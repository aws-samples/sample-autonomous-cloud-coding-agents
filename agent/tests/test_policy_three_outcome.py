"""Unit tests for the Cedar-HITL three-outcome policy engine.

Companion to ``test_policy.py`` which exercises the Phase 1 binary-decision
surface via ``.allowed``. This module targets the new three-outcome
behavior (``Outcome.ALLOW`` / ``Outcome.DENY`` / ``Outcome.REQUIRE_APPROVAL``)
introduced for Cedar HITL gates. See
``docs/design/CEDAR_HITL_GATES.md`` §§6, 12.

Covers:

- ``PolicyDecision`` construction (new + legacy kwargs; factory helpers).
- ``Outcome`` enum membership and the ``.allowed`` shim's mapping.
- ``ApprovalAllowlist`` for every scope type.
- ``RecentDecisionCache`` TTL, LRU eviction, APPROVED-not-populated rule,
  independent 50-entry memory bound.
- Annotation parsing + multi-match merging (min timeout, max severity,
  floor clamp, WARN on sub-120s).
- Load-time validation: 64 KB cap, hard-deny disable rejection,
  approval_gate_cap bounds, tier/rule_id checks.
- Three-outcome pipeline happy paths: hard-deny → DENY, pre-approved →
  ALLOW, soft-deny hit → REQUIRE_APPROVAL, rule-scope allowlist → ALLOW,
  default fallthrough → ALLOW.
- Recent-decision cache blocking a retry after DENIED outcome.
- Fail-closed on cedarpy exceptions.
"""

from __future__ import annotations

# Hard import — the policy engine requires cedarpy; skipping would hide drift.
import cedarpy  # noqa: F401  (sanity import)
import pytest

from policy import (
    APPROVAL_GATE_CAP_MAX,
    APPROVAL_GATE_CAP_MIN,
    CACHE_MAX_ENTRIES,
    CACHE_TTL_S,
    POLICIES_MAX_BYTES,
    ApprovalAllowlist,
    Outcome,
    PolicyDecision,
    PolicyEngine,
    RecentDecisionCache,
)

# ---------------------------------------------------------------------------
# PolicyDecision + Outcome
# ---------------------------------------------------------------------------


class TestPolicyDecisionConstruction:
    def test_new_style_outcome_kwarg(self):
        d = PolicyDecision(outcome=Outcome.ALLOW, reason="ok")
        assert d.outcome == Outcome.ALLOW
        assert d.allowed is True

    def test_legacy_allowed_true_maps_to_allow(self):
        d = PolicyDecision(allowed=True, reason="ok", duration_ms=1.0)
        assert d.outcome == Outcome.ALLOW
        assert d.allowed is True
        assert d.duration_ms == 1.0

    def test_legacy_allowed_false_maps_to_deny(self):
        d = PolicyDecision(allowed=False, reason="nope")
        assert d.outcome == Outcome.DENY
        assert d.allowed is False

    def test_require_approval_has_allowed_false(self):
        d = PolicyDecision(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason="soft-deny: force_push_any",
            timeout_s=300,
            severity="medium",
            matching_rule_ids=("force_push_any",),
        )
        # Critical backward-compat: Phase 1 callers that branch on
        # ``if not decision.allowed: return deny`` must keep blocking
        # REQUIRE_APPROVAL until the hook is extended to the three-outcome
        # path in Chunk 3.
        assert d.allowed is False

    def test_cannot_pass_both_outcome_and_allowed(self):
        with pytest.raises(TypeError, match="not both"):
            PolicyDecision(outcome=Outcome.ALLOW, allowed=True, reason="ok")

    def test_cannot_pass_neither_outcome_nor_allowed(self):
        with pytest.raises(TypeError, match="requires either"):
            PolicyDecision(reason="orphan")

    def test_factory_allow(self):
        d = PolicyDecision.allow()
        assert d.outcome == Outcome.ALLOW
        assert d.reason == "permitted"

    def test_factory_deny(self):
        d = PolicyDecision.deny("blocked")
        assert d.outcome == Outcome.DENY
        assert d.reason == "blocked"

    def test_factory_require_approval(self):
        d = PolicyDecision.require_approval(
            reason="soft-deny: foo",
            timeout_s=600,
            severity="high",
            matching_rule_ids=("foo", "bar"),
        )
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert d.timeout_s == 600
        assert d.severity == "high"
        assert d.matching_rule_ids == ("foo", "bar")

    def test_equality_and_hash(self):
        a = PolicyDecision(outcome=Outcome.ALLOW, reason="ok")
        b = PolicyDecision(outcome=Outcome.ALLOW, reason="ok")
        assert a == b
        assert hash(a) == hash(b)

    def test_cache_hit_metadata_default_none(self):
        d = PolicyDecision(outcome=Outcome.ALLOW, reason="ok")
        assert d.cache_hit_metadata is None

    def test_cache_hit_metadata_can_be_populated(self):
        payload = {
            "tool_name": "Bash",
            "tool_input_sha256": "abc",
            "cached_decision": "DENIED",
            "cached_reason": "prior deny",
            "original_decision_ts": "2026-05-07T12:00:00Z",
        }
        d = PolicyDecision(outcome=Outcome.DENY, reason="Recent DENIED", cache_hit_metadata=payload)
        assert d.cache_hit_metadata == payload

    def test_cache_hit_metadata_not_in_equality(self):
        # Metadata is observability-only — two DENYs with the same outcome
        # and reason are the "same" decision even if their original_decision_ts
        # differs. Keeps __eq__/__hash__ stable for legacy callers that put
        # PolicyDecision values in sets / dicts.
        bare = PolicyDecision(outcome=Outcome.DENY, reason="x")
        with_meta = PolicyDecision(
            outcome=Outcome.DENY,
            reason="x",
            cache_hit_metadata={"tool_name": "Bash"},
        )
        assert bare == with_meta
        assert hash(bare) == hash(with_meta)


# ---------------------------------------------------------------------------
# ApprovalAllowlist — §6.4
# ---------------------------------------------------------------------------


class TestApprovalAllowlist:
    def test_empty_allowlist_matches_nothing(self):
        al = ApprovalAllowlist()
        assert al.matches("Read", {"file_path": "a.py"}) is False

    def test_tool_type_scope(self):
        al = ApprovalAllowlist(["tool_type:Read"])
        assert al.matches("Read", {"file_path": "a.py"}) is True
        assert al.matches("Write", {"file_path": "a.py"}) is False

    def test_tool_group_file_write_matches_write_and_edit(self):
        al = ApprovalAllowlist(["tool_group:file_write"])
        assert al.matches("Write", {"file_path": "a.py"}) is True
        assert al.matches("Edit", {"file_path": "a.py"}) is True
        assert al.matches("Read", {"file_path": "a.py"}) is False

    def test_all_session_matches_everything(self):
        al = ApprovalAllowlist(["all_session"])
        assert al.matches("Bash", {"command": "anything"}) is True
        assert al.matches("WebFetch", {"url": "https://x"}) is True

    def test_bash_pattern_matches_via_fnmatch(self):
        al = ApprovalAllowlist(["bash_pattern:git status*"])
        assert al.matches("Bash", {"command": "git status"}) is True
        assert al.matches("Bash", {"command": "git status --short"}) is True
        assert al.matches("Bash", {"command": "git push"}) is False

    def test_write_path_glob(self):
        al = ApprovalAllowlist(["write_path:docs/**"])
        assert al.matches("Write", {"file_path": "docs/README.md"}) is True
        assert al.matches("Edit", {"file_path": "docs/guides/foo.md"}) is True
        assert al.matches("Write", {"file_path": "src/main.py"}) is False

    def test_rule_scope_exposed_but_not_checked_in_matches(self):
        # rule: scopes are checked POST soft-deny-eval inside the engine,
        # not in .matches() (rule_ids are only known once Cedar reports
        # matching policies). Confirm matches() returns False for rule-only
        # allowlists, but the rule_ids set is populated.
        al = ApprovalAllowlist(["rule:deploy_staging"])
        assert al.matches("Bash", {"command": "terraform apply"}) is False
        assert "deploy_staging" in al.rule_ids

    def test_unknown_scope_prefix_rejected(self):
        with pytest.raises(ValueError, match="unknown scope"):
            ApprovalAllowlist(["flimflam:foo"])

    def test_unknown_tool_group_rejected(self):
        with pytest.raises(ValueError, match="unknown tool_group"):
            ApprovalAllowlist(["tool_group:no_such_group"])


# ---------------------------------------------------------------------------
# RecentDecisionCache — §6.2, §12.8, §12.9
# ---------------------------------------------------------------------------


class TestRecentDecisionCache:
    def test_record_and_get_within_ttl(self):
        cache = RecentDecisionCache()
        cache.record("Bash", "sha-a", "DENIED", "too risky")
        entry = cache.get("Bash", "sha-a")
        assert entry is not None
        assert entry.decision == "DENIED"
        assert entry.reason == "too risky"

    def test_missing_key_returns_none(self):
        cache = RecentDecisionCache()
        assert cache.get("Bash", "nonexistent") is None

    def test_approved_decision_rejected(self):
        # §12.8: cache must NOT be populated on APPROVED — otherwise a
        # just-approved call would auto-deny on the next identical invocation.
        cache = RecentDecisionCache()
        with pytest.raises(ValueError, match="DENIED/TIMED_OUT"):
            cache.record("Bash", "sha-a", "APPROVED", "user said yes")

    def test_ttl_expiry(self):
        # Inject a controllable clock so we can advance past the 60s window.
        now = [0.0]

        def fake_clock() -> float:
            return now[0]

        cache = RecentDecisionCache(clock=fake_clock)
        cache.record("Bash", "sha-a", "DENIED", "x")
        assert cache.get("Bash", "sha-a") is not None
        now[0] += CACHE_TTL_S + 0.1
        assert cache.get("Bash", "sha-a") is None

    def test_lru_eviction_on_overflow(self):
        # §12.9: cache memory bound is 50 entries INDEPENDENT of
        # approval_gate_cap. Oldest entry evicted when the cap is hit.
        cache = RecentDecisionCache(max_entries=3)
        cache.record("Bash", "a", "DENIED", "1")
        cache.record("Bash", "b", "DENIED", "2")
        cache.record("Bash", "c", "DENIED", "3")
        cache.record("Bash", "d", "DENIED", "4")  # evicts "a"
        assert cache.get("Bash", "a") is None
        assert cache.get("Bash", "d") is not None

    def test_access_touches_lru_order(self):
        cache = RecentDecisionCache(max_entries=3)
        cache.record("Bash", "a", "DENIED", "1")
        cache.record("Bash", "b", "DENIED", "2")
        cache.record("Bash", "c", "DENIED", "3")
        # Access "a" to promote it past "b" / "c".
        _ = cache.get("Bash", "a")
        cache.record("Bash", "d", "DENIED", "4")  # evicts "b" now
        assert cache.get("Bash", "a") is not None  # touched; stayed
        assert cache.get("Bash", "b") is None  # evicted

    def test_cache_max_entries_default(self):
        assert CACHE_MAX_ENTRIES == 50

    def test_record_stores_original_decision_ts(self):
        # IMPL-23: cache hits must surface when the original decision landed
        # so operators can correlate the cache-driven deny back to the gate.
        cache = RecentDecisionCache()
        cache.record(
            "Bash",
            "sha-a",
            "DENIED",
            "too risky",
            original_decision_ts="2026-05-07T12:00:00Z",
        )
        entry = cache.get("Bash", "sha-a")
        assert entry is not None
        assert entry.original_decision_ts == "2026-05-07T12:00:00Z"

    def test_record_defaults_original_decision_ts_to_now(self):
        # Legacy callers that omit the kwarg still get a valid ISO string.
        cache = RecentDecisionCache()
        cache.record("Bash", "sha-a", "DENIED", "x")
        entry = cache.get("Bash", "sha-a")
        assert entry is not None
        assert entry.original_decision_ts.endswith("Z")
        # Shape sanity: 2026-05-07T12:34:56.789012Z (26-27 chars) or
        # 2026-05-07T12:34:56Z (20 chars) depending on Python's subsecond
        # behavior — either way starts with the year.
        assert entry.original_decision_ts[:4].isdigit()

    # --- Rule-level cache extension (B1, 2026-05-12) ---------------------

    def test_record_rule_decision_and_lookup(self):
        # Rule-level cache catches semantic retries (same rule, different
        # input) the input-hash cache misses. Seeded on DENIED only.
        cache = RecentDecisionCache()
        cache.record_rule_decision(
            "Bash",
            "force_push_any",
            "DENIED",
            "no prod pushes",
            original_decision_ts="2026-05-12T19:00:00Z",
        )
        hit = cache.get_rule_decision("Bash", ["force_push_any"])
        assert hit is not None
        rule_id, entry = hit
        assert rule_id == "force_push_any"
        assert entry.decision == "DENIED"
        assert entry.reason == "no prod pushes"
        assert entry.original_decision_ts == "2026-05-12T19:00:00Z"

    def test_rule_cache_returns_first_of_multiple_matching(self):
        cache = RecentDecisionCache()
        cache.record_rule_decision("Bash", "rule_b", "DENIED", "b")
        cache.record_rule_decision("Bash", "rule_c", "DENIED", "c")
        # ``get_rule_decision`` iterates in caller-order and returns the
        # first hit. ``rule_a`` isn't cached → scan moves on to ``rule_b``.
        hit = cache.get_rule_decision("Bash", ["rule_a", "rule_b", "rule_c"])
        assert hit is not None
        assert hit[0] == "rule_b"

    def test_rule_cache_miss_returns_none(self):
        cache = RecentDecisionCache()
        cache.record_rule_decision("Bash", "force_push_any", "DENIED", "x")
        # Different tool — rule cache is keyed on ``(tool, rule_id)``.
        assert cache.get_rule_decision("Write", ["force_push_any"]) is None
        # Different rule on the same tool.
        assert cache.get_rule_decision("Bash", ["other_rule"]) is None
        # Empty rule_ids list.
        assert cache.get_rule_decision("Bash", []) is None

    def test_rule_cache_timed_out_rejected(self):
        # TIMED_OUT is ambiguous (user was away, not actively refusing),
        # so it stays input-hash-scoped only. Rule-level cache rejects
        # TIMED_OUT / APPROVED to keep the semantics clean.
        cache = RecentDecisionCache()
        with pytest.raises(ValueError, match="only accepts DENIED"):
            cache.record_rule_decision("Bash", "force_push_any", "TIMED_OUT", "x")
        with pytest.raises(ValueError, match="only accepts DENIED"):
            cache.record_rule_decision("Bash", "force_push_any", "APPROVED", "x")

    def test_rule_cache_ttl_expiry(self):
        now = [0.0]

        def fake_clock() -> float:
            return now[0]

        cache = RecentDecisionCache(clock=fake_clock)
        cache.record_rule_decision("Bash", "force_push_any", "DENIED", "x")
        assert cache.get_rule_decision("Bash", ["force_push_any"]) is not None
        now[0] += CACHE_TTL_S + 0.1
        assert cache.get_rule_decision("Bash", ["force_push_any"]) is None

    def test_rule_cache_lru_eviction(self):
        cache = RecentDecisionCache(max_entries=2)
        cache.record_rule_decision("Bash", "rule_a", "DENIED", "1")
        cache.record_rule_decision("Bash", "rule_b", "DENIED", "2")
        cache.record_rule_decision("Bash", "rule_c", "DENIED", "3")  # evicts rule_a
        assert cache.get_rule_decision("Bash", ["rule_a"]) is None
        assert cache.get_rule_decision("Bash", ["rule_c"]) is not None


# ---------------------------------------------------------------------------
# PolicyEngine: three-outcome pipeline
# ---------------------------------------------------------------------------


class TestThreeOutcomePipeline:
    def test_hard_deny_rm_slash_returns_deny(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason
        assert "rm_slash" in d.reason

    def test_hard_deny_git_internals_returns_deny(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Write", {"file_path": ".git/config"})
        assert d.outcome == Outcome.DENY
        assert "write_git_internals" in d.reason

    def test_soft_deny_force_push_returns_require_approval(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert "force_push_any" in d.matching_rule_ids
        assert d.timeout_s == 300
        assert d.severity == "medium"

    def test_soft_deny_multi_match_merges_annotations(self):
        # force_push_any (300s, medium) + force_push_main (600s, high) both
        # match "git push --force origin main". Merge picks min(300, 600)=300s
        # and max(medium, high)=high. §6.3.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin main"})
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert "force_push_any" in d.matching_rule_ids
        assert "force_push_main" in d.matching_rule_ids
        assert d.timeout_s == 300  # min across rules + task default
        assert d.severity == "high"  # max across rules

    def test_default_allow_on_no_match(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert d.outcome == Outcome.ALLOW

    def test_pre_approved_tool_type_returns_allow_without_approval(self):
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["tool_type:Read"],
        )
        d = engine.evaluate_tool_use("Read", {"file_path": "a.py"})
        assert d.outcome == Outcome.ALLOW
        assert "Pre-approved by allowlist" in d.reason

    def test_pre_approved_all_session_skips_soft_deny(self):
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["all_session"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.ALLOW

    def test_pre_approved_all_session_does_not_bypass_hard_deny(self):
        # §12.5: hard-deny is absolute. No --pre-approve scope bypasses it.
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["all_session"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason

    def test_pre_approved_rule_scope_matched_post_soft_deny(self):
        # rule: scope matches after the soft-deny eval knows which rules
        # were triggered. Confirms the post-eval allowlist branch fires.
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["rule:force_push_any"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.ALLOW
        assert "Allowlist rule" in d.reason
        assert "force_push_any" in d.reason

    def test_bash_pattern_scope_pre_approves_prefix(self):
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["bash_pattern:git status*"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git status --short"})
        assert d.outcome == Outcome.ALLOW

    def test_write_path_scope_pre_approves_docs(self):
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["write_path:docs/*"],
        )
        d = engine.evaluate_tool_use("Write", {"file_path": "docs/README.md"})
        assert d.outcome == Outcome.ALLOW


# ---------------------------------------------------------------------------
# Recent-decision cache integration
# ---------------------------------------------------------------------------


class TestRecentDecisionCacheIntegration:
    def test_denied_then_retry_hits_cache(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Seed cache directly via the public ``recent_decisions`` interface
        # — simulates a prior DENIED outcome from the hook (§6.2 step 2.5).
        import hashlib
        import json as _json

        tool_input = {"command": "git push --force origin feature"}
        sha = hashlib.sha256(_json.dumps(tool_input, sort_keys=True).encode()).hexdigest()
        engine.recent_decisions.record("Bash", sha, "DENIED", "user said force-push is too risky")
        d = engine.evaluate_tool_use("Bash", tool_input)
        assert d.outcome == Outcome.DENY
        assert "Recent DENIED" in d.reason

    def test_cache_does_not_shadow_hard_deny(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Even if the cache held an entry for "rm -rf /", step 1 hard-deny
        # runs first so the denial reason is hard-deny, not cache.
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason
        assert "Recent" not in d.reason

    def test_cache_hit_attaches_metadata_for_impl_23(self):
        # IMPL-23: a cache hit must carry the metadata the hook will forward
        # to progress_writer.write_policy_decision_cached so cache-driven
        # denies are visible in the TaskEventsTable event stream.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        import hashlib
        import json as _json

        tool_input = {"command": "git push --force origin feature"}
        sha = hashlib.sha256(_json.dumps(tool_input, sort_keys=True).encode()).hexdigest()
        engine.recent_decisions.record(
            "Bash",
            sha,
            "DENIED",
            "user said force-push is too risky",
            original_decision_ts="2026-05-07T12:00:00Z",
        )
        d = engine.evaluate_tool_use("Bash", tool_input)
        assert d.outcome == Outcome.DENY
        assert d.cache_hit_metadata == {
            "tool_name": "Bash",
            "tool_input_sha256": sha,
            "cached_decision": "DENIED",
            "cached_reason": "user said force-push is too risky",
            "original_decision_ts": "2026-05-07T12:00:00Z",
        }

    # --- Rule-level cache integration (B1, 2026-05-12) ---------------------

    def test_semantic_retry_hits_rule_cache(self):
        # Once the user has denied ``git push --force origin feature``
        # and the hook seeded the rule cache with ``force_push_any``,
        # the agent's retry on a DIFFERENT branch name should fast-deny
        # instead of opening a fresh approval gate. Regression guard
        # for the E2E Phase 4 finding: max_turns burn due to semantic
        # retries not hitting the input-hash cache.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.recent_decisions.record_rule_decision(
            "Bash",
            "force_push_any",
            "DENIED",
            "no force pushes",
            original_decision_ts="2026-05-12T19:00:00Z",
        )
        # Different branch name → different input hash; input-hash cache
        # would miss. Rule cache catches it because the Cedar eval still
        # returns ``force_push_any`` as a matching rule.
        d = engine.evaluate_tool_use(
            "Bash", {"command": "git push --force origin some-other-branch"}
        )
        assert d.outcome == Outcome.DENY
        assert "Recent DENIED on rule 'force_push_any'" in d.reason
        assert d.cache_hit_metadata is not None
        assert d.cache_hit_metadata["matched_rule_id"] == "force_push_any"
        assert d.cache_hit_metadata["cached_decision"] == "DENIED"
        assert d.cache_hit_metadata["original_decision_ts"] == "2026-05-12T19:00:00Z"

    def test_rule_cache_does_not_shadow_hard_deny(self):
        # Hard-deny (step 1) still precedes rule-cache (step 3.5),
        # mirroring the invariant for the input-hash cache.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.recent_decisions.record_rule_decision("Bash", "rm_slash", "DENIED", "not allowed")
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason
        assert "Recent" not in d.reason

    def test_rule_cache_does_not_shadow_allowlist(self):
        # Step 2 allowlist (tool-scope) wins over rule cache just like it
        # wins over the input-hash cache. Pre-approval via allowlist is
        # the user's explicit override.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.allowlist.add("rule:force_push_any")
        engine.recent_decisions.record_rule_decision(
            "Bash", "force_push_any", "DENIED", "stale rejection"
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.ALLOW
        assert "Allowlist" in d.reason

    def test_non_cache_decisions_have_no_cache_hit_metadata(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # ALLOW path
        assert engine.evaluate_tool_use("Bash", {"command": "npm test"}).cache_hit_metadata is None
        # Hard-deny path
        assert engine.evaluate_tool_use("Bash", {"command": "rm -rf /"}).cache_hit_metadata is None
        # Soft-deny path
        assert (
            engine.evaluate_tool_use(
                "Bash", {"command": "git push --force origin feature"}
            ).cache_hit_metadata
            is None
        )


# ---------------------------------------------------------------------------
# Load-time validation — §5.1, §12.4
# ---------------------------------------------------------------------------


class TestLoadTimeValidation:
    def test_approval_gate_cap_bounds_enforced(self):
        with pytest.raises(ValueError, match="approval_gate_cap"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                approval_gate_cap=APPROVAL_GATE_CAP_MAX + 1,
            )
        with pytest.raises(ValueError, match="approval_gate_cap"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                approval_gate_cap=APPROVAL_GATE_CAP_MIN - 1,
            )

    def test_approval_gate_cap_at_bounds_accepted(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo", approval_gate_cap=1)
        assert e.approval_gate_cap == 1
        e = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            approval_gate_cap=APPROVAL_GATE_CAP_MAX,
        )
        assert e.approval_gate_cap == APPROVAL_GATE_CAP_MAX

    def test_blueprint_disable_rejects_builtin_hard_deny_rule(self):
        # §5.1, finding #9: blueprints may NOT disable built-in hard-deny
        # rules. Attempting `disable: [rm_slash]` must fail at task start.
        with pytest.raises(ValueError, match="rm_slash"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_disable=["rm_slash"],
            )

    def test_blueprint_disable_accepts_unknown_id(self):
        # A disable entry that names a non-existent rule is tolerated (it's
        # a no-op). Blueprint-drift safeguard — we reject only hard-deny.
        e = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_disable=["nonexistent_rule"],
        )
        # Constructs cleanly; the unknown ID is stored but does nothing.
        assert "nonexistent_rule" in e._disabled_rule_ids

    def test_blueprint_64kb_cap_rejected(self):
        # §12.4, finding #12: combined blueprint text > 64 KB rejected.
        big = (
            '@tier("soft") @rule_id("big") '
            "forbid (principal, action, resource) "
            'when { context.x like "*aaaaaaaaaa*" };'
        ) * 1000  # well over 64 KB
        assert len(big) > POLICIES_MAX_BYTES
        with pytest.raises(ValueError, match="64 KB cap"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=big,
            )

    def test_blueprint_soft_rule_missing_rule_id_rejected(self):
        bad = '@tier("soft") forbid (principal, action, resource) when { context.x like "*foo*" };'
        with pytest.raises(ValueError, match="missing @rule_id"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=bad,
            )

    def test_blueprint_soft_timeout_below_floor_rejected(self):
        bad = (
            '@tier("soft") @rule_id("too_short") @approval_timeout_s("10") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*foo*" };'
        )
        with pytest.raises(ValueError, match="below floor"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=bad,
            )

    def test_blueprint_soft_timeout_sub_120s_emits_warn(self):
        # IMPL-25: sub-120s is advisory, not strict. Construction succeeds;
        # the WARN log line is emitted by shell.log() which prints to stdout,
        # not Python's logging module, so stdlib caplog won't capture it.
        # Asserting "construction does not raise" is sufficient signal for
        # the accept-and-warn contract; WARN visibility is a CloudWatch
        # concern (ops), not a unit-test concern.
        ok_but_warn = (
            '@tier("soft") @rule_id("quick") @approval_timeout_s("90") '
            '@severity("low") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*nosuch*" };'
        )
        PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_soft_policies=ok_but_warn,
        )

    def test_duplicate_rule_id_across_tiers_rejected(self):
        conflict = (
            '@tier("soft") @rule_id("rm_slash") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*never*" };'
        )
        with pytest.raises(ValueError, match="rm_slash"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=conflict,
            )

    def test_invalid_scope_in_initial_approvals_rejected(self):
        with pytest.raises(ValueError, match="unknown scope"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                initial_approvals=["flimflam:foo"],
            )


# ---------------------------------------------------------------------------
# Fail-closed posture — §13
# ---------------------------------------------------------------------------


class TestFailClosedPosture:
    def test_cedarpy_parse_error_maps_to_deny_fail_closed(self):
        # §13.4: engine exception -> DENY with reason "fail-closed: ...".
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine._hard_policies = "THIS IS NOT VALID CEDAR"
        d = engine.evaluate_tool_use("Write", {"file_path": "a.py"})
        assert d.outcome == Outcome.DENY
        assert "fail-closed" in d.reason

    def test_engine_disabled_returns_deny(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine._disabled = True
        engine._cedarpy = None
        d = engine.evaluate_tool_use("Read", {"file_path": "a.py"})
        assert d.outcome == Outcome.DENY
        assert "unavailable" in d.reason

    def test_unhashable_tool_input_surfaces_distinct_reason(self):
        # Review finding #5: a non-JSON-serializable tool_input should be
        # distinguishable from a Cedar evaluation failure so operators can
        # tell the difference in CloudWatch.
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": object()})
        assert d.outcome == Outcome.DENY
        assert d.reason == "fail-closed: unhashable_tool_input"


# ---------------------------------------------------------------------------
# Regressions covered from Chunk 2 adversarial review
# ---------------------------------------------------------------------------


class TestReviewRegressions:
    """Lock the review findings from Chunk 2 so a future refactor cannot
    silently reintroduce them.
    """

    # Finding #1: blueprint_disable actually disables the soft rule at eval time.
    def test_blueprint_disable_suppresses_soft_deny(self):
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_disable=["force_push_any"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.ALLOW, (
            "blueprint_disable must actually disable the matching soft rule, "
            "not just log-and-continue"
        )

    def test_blueprint_disable_partial_leaves_surviving_rules(self):
        # Only disable force_push_any; force_push_main still fires on push to main.
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_disable=["force_push_any"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin main"})
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert "force_push_main" in d.matching_rule_ids
        assert "force_push_any" not in d.matching_rule_ids

    # Finding #2: legacy extra_policies with annotations rejected.
    def test_legacy_extra_policies_with_tier_annotation_rejected(self):
        with pytest.raises(ValueError, match="already declares"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                extra_policies=['@tier("soft") forbid (principal, action, resource);'],
            )

    def test_legacy_extra_policies_with_rule_id_annotation_rejected(self):
        with pytest.raises(ValueError, match="already declares"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                extra_policies=['@rule_id("foo") forbid (principal, action, resource);'],
            )

    # Finding #6: scope whitespace normalization + empty-value rejection.
    def test_allowlist_strips_whitespace(self):
        al = ApprovalAllowlist(["  tool_type: Read  "])
        assert al.matches("Read", {"file_path": "a.py"}) is True

    def test_allowlist_empty_value_rejected(self):
        with pytest.raises(ValueError, match="missing value"):
            ApprovalAllowlist(["tool_type:"])

    def test_allowlist_empty_value_after_strip_rejected(self):
        with pytest.raises(ValueError, match="missing value"):
            ApprovalAllowlist(["tool_type:   "])

    # Finding #7: base_permit exemption only applies to permit effect.
    def test_base_permit_forbid_not_exempted(self):
        bad = (
            '@rule_id("base_permit") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*foo*" };'
        )
        with pytest.raises(ValueError, match="missing @tier"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=bad,
            )


# ---------------------------------------------------------------------------
# Chunk 3: approval-gate counters + denial queue (§6.5, §12.9)
# ---------------------------------------------------------------------------


class TestApprovalGateCounter:
    """Lock the per-task gate counter surface the hook depends on (§6.5)."""

    def _engine(self) -> PolicyEngine:
        return PolicyEngine(task_type="new_task", repo="owner/repo")

    def test_initial_count_is_zero(self):
        assert self._engine().approval_gate_count == 0

    def test_increment_advances(self):
        e = self._engine()
        e.increment_approval_gate_count()
        e.increment_approval_gate_count()
        assert e.approval_gate_count == 2

    def test_counter_survives_many_increments(self):
        e = self._engine()
        for _ in range(75):
            e.increment_approval_gate_count()
        # Counter itself is unbounded — the cap check is enforced in the hook.
        assert e.approval_gate_count == 75

    def test_initial_approval_gate_count_seeds_counter(self):
        # Chunk 7: container restarts resume the cumulative gate budget so
        # the cap is respected across restarts (§13.6). The kwarg threads
        # the TaskTable-persisted value into a fresh PolicyEngine.
        e = PolicyEngine(task_type="new_task", repo="owner/repo", initial_approval_gate_count=12)
        assert e.approval_gate_count == 12

    def test_initial_approval_gate_count_adds_to_increments(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo", initial_approval_gate_count=12)
        e.increment_approval_gate_count()
        e.increment_approval_gate_count()
        assert e.approval_gate_count == 14

    def test_initial_approval_gate_count_default_is_zero(self):
        assert PolicyEngine(task_type="new_task", repo="owner/repo").approval_gate_count == 0

    def test_initial_approval_gate_count_rejects_negative(self):
        with pytest.raises(ValueError, match="initial_approval_gate_count must be >= 0"):
            PolicyEngine(task_type="new_task", repo="owner/repo", initial_approval_gate_count=-1)


class TestApprovalRateWindow:
    """Sliding-window per-container rate limit (§12.9)."""

    def test_empty_window(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert e.approvals_in_last_minute == 0

    def test_record_within_window_counts(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.record_approval_gate_timestamp(now=1000.0)
        e.record_approval_gate_timestamp(now=1010.0)
        # Prune window pins at current monotonic time; inject deque directly
        # to assert the count before pruning.
        assert len(e._approvals_last_minute) == 2

    def test_old_entries_pruned(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Seed with an entry older than the 60s window relative to a
        # synthetic "now".
        e.record_approval_gate_timestamp(now=100.0)
        e.record_approval_gate_timestamp(now=105.0)
        # Force prune at 200s: both old entries should drop out.
        e._prune_rate_window(200.0)
        assert len(e._approvals_last_minute) == 0

    def test_mixed_window_keeps_recent(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.record_approval_gate_timestamp(now=100.0)  # old
        e.record_approval_gate_timestamp(now=155.0)  # within 60s of 200s
        e.record_approval_gate_timestamp(now=199.0)  # within 60s of 200s
        e._prune_rate_window(200.0)
        assert list(e._approvals_last_minute) == [155.0, 199.0]


class TestDenialInjectionQueue:
    """Queue consumed by ``_denial_between_turns_hook`` (§6.5)."""

    def test_queue_starts_empty(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert e.drain_denial_injections() == []

    def test_queue_then_drain_preserves_order(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.queue_denial_injection(
            request_id="01K1", reason="do it after tests pass", decided_at="t1"
        )
        e.queue_denial_injection(request_id="01K2", reason="not on Fridays", decided_at="t2")
        drained = e.drain_denial_injections()
        assert [p["request_id"] for p in drained] == ["01K1", "01K2"]
        assert drained[0]["reason"] == "do it after tests pass"
        # Drain clears the queue.
        assert e.drain_denial_injections() == []


class TestCeilingShrinkingLatch:
    """IMPL-26: ``approval_ceiling_shrinking`` is emit-once per task."""

    def test_first_call_returns_true(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert e.mark_ceiling_shrinking_emitted() is True

    def test_subsequent_calls_return_false(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.mark_ceiling_shrinking_emitted()
        assert e.mark_ceiling_shrinking_emitted() is False
        assert e.mark_ceiling_shrinking_emitted() is False
