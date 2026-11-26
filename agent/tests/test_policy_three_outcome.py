from __future__ import annotations

from unittest.mock import patch

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
    _sha256_tool_input,
)


class TestPolicyDecisionConstruction:
    def test_new_style_outcome_kwarg(self):
        d = PolicyDecision(outcome=Outcome.ALLOW, reason="ok")
        assert d.outcome == Outcome.ALLOW
        assert d.allowed is True

    def test_require_approval_has_allowed_false(self):
        d = PolicyDecision(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason="soft-deny: force_push_any",
            timeout_s=300,
            severity="medium",
            matching_rule_ids=("force_push_any",),
        )
        assert d.allowed is False

    def test_outcome_is_required(self):
        without_outcome: dict = {"reason": "orphan"}
        with pytest.raises(TypeError, match="outcome"):
            PolicyDecision(**without_outcome)

    def test_decision_cannot_be_modified(self):
        d = PolicyDecision.deny("blocked")
        for name in ("outcome", "reason"):
            with pytest.raises(AttributeError):
                setattr(d, name, "allow")
        assert d.outcome == Outcome.DENY

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
        bare = PolicyDecision(outcome=Outcome.DENY, reason="x")
        with_meta = PolicyDecision(
            outcome=Outcome.DENY,
            reason="x",
            cache_hit_metadata={"tool_name": "Bash"},
        )
        assert bare == with_meta
        assert hash(bare) == hash(with_meta)

    def test_fail_closed_defaults_false(self):
        assert PolicyDecision.allow().fail_closed is False
        assert PolicyDecision.deny("Hard-deny: force_push_main").fail_closed is False

    def test_deny_can_be_marked_fail_closed(self):
        d = PolicyDecision.deny("fail-closed: RuntimeError", fail_closed=True)
        assert d.outcome == Outcome.DENY
        assert d.fail_closed is True

    def test_fail_closed_not_in_equality(self):
        bare = PolicyDecision(outcome=Outcome.DENY, reason="x")
        flagged = PolicyDecision(outcome=Outcome.DENY, reason="x", fail_closed=True)
        assert bare == flagged
        assert hash(bare) == hash(flagged)


class TestEvaluateToolUseFailClosed:
    def test_engine_unavailable_is_fail_closed(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine._cedarpy = None
        d = engine.evaluate_tool_use("Bash", {"command": "echo hi"})
        assert d.outcome == Outcome.DENY
        assert d.fail_closed is True

    def test_unhashable_tool_input_is_fail_closed(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": {1, 2, 3}})
        assert d.outcome == Outcome.DENY
        assert d.fail_closed is True

    def test_cedar_eval_exception_is_fail_closed(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        with patch.object(engine, "_eval_for_tool", side_effect=RuntimeError("cedar boom")):
            d = engine.evaluate_tool_use("Bash", {"command": "echo hi"})
        assert d.outcome == Outcome.DENY
        assert d.fail_closed is True

    def test_hard_deny_is_not_fail_closed(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=True)
        d = engine.evaluate_tool_use("Write", {"file_path": "x.py", "content": "y"})
        assert d.outcome == Outcome.DENY
        assert d.fail_closed is False


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
        al = ApprovalAllowlist(["rule:deploy_staging"])
        assert al.matches("Bash", {"command": "terraform apply"}) is False
        assert "deploy_staging" in al.rule_ids

    def test_unknown_scope_prefix_rejected(self):
        with pytest.raises(ValueError, match="unknown scope"):
            ApprovalAllowlist(["flimflam:foo"])

    def test_unknown_tool_group_rejected(self):
        with pytest.raises(ValueError, match="unknown tool_group"):
            ApprovalAllowlist(["tool_group:no_such_group"])


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
        cache = RecentDecisionCache()
        with pytest.raises(ValueError, match="DENIED/TIMED_OUT"):
            cache.record("Bash", "sha-a", "APPROVED", "user said yes")

    def test_ttl_expiry(self):
        now = [0.0]

        def fake_clock() -> float:
            return now[0]

        cache = RecentDecisionCache(clock=fake_clock)
        cache.record("Bash", "sha-a", "DENIED", "x")
        assert cache.get("Bash", "sha-a") is not None
        now[0] += CACHE_TTL_S + 0.1
        assert cache.get("Bash", "sha-a") is None

    def test_lru_eviction_on_overflow(self):
        cache = RecentDecisionCache(max_entries=3)
        cache.record("Bash", "a", "DENIED", "1")
        cache.record("Bash", "b", "DENIED", "2")
        cache.record("Bash", "c", "DENIED", "3")
        cache.record("Bash", "d", "DENIED", "4")
        assert cache.get("Bash", "a") is None
        assert cache.get("Bash", "d") is not None

    def test_access_touches_lru_order(self):
        cache = RecentDecisionCache(max_entries=3)
        cache.record("Bash", "a", "DENIED", "1")
        cache.record("Bash", "b", "DENIED", "2")
        cache.record("Bash", "c", "DENIED", "3")
        _ = cache.get("Bash", "a")
        cache.record("Bash", "d", "DENIED", "4")
        assert cache.get("Bash", "a") is not None
        assert cache.get("Bash", "b") is None

    def test_cache_max_entries_default(self):
        assert CACHE_MAX_ENTRIES == 50

    def test_record_stores_original_decision_ts(self):
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
        cache = RecentDecisionCache()
        cache.record("Bash", "sha-a", "DENIED", "x")
        entry = cache.get("Bash", "sha-a")
        assert entry is not None
        assert entry.original_decision_ts.endswith("Z")
        assert entry.original_decision_ts[:4].isdigit()

    def test_record_rule_decision_and_lookup(self):
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
        hit = cache.get_rule_decision("Bash", ["rule_a", "rule_b", "rule_c"])
        assert hit is not None
        assert hit[0] == "rule_b"

    def test_rule_cache_miss_returns_none(self):
        cache = RecentDecisionCache()
        cache.record_rule_decision("Bash", "force_push_any", "DENIED", "x")
        assert cache.get_rule_decision("Write", ["force_push_any"]) is None
        assert cache.get_rule_decision("Bash", ["other_rule"]) is None
        assert cache.get_rule_decision("Bash", []) is None

    def test_rule_cache_timed_out_rejected(self):
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
        cache.record_rule_decision("Bash", "rule_c", "DENIED", "3")
        assert cache.get_rule_decision("Bash", ["rule_a"]) is None
        assert cache.get_rule_decision("Bash", ["rule_c"]) is not None


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
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin main"})
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert "force_push_any" in d.matching_rule_ids
        assert "force_push_main" in d.matching_rule_ids
        assert d.timeout_s == 300
        assert d.severity == "high"

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
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            initial_approvals=["all_session"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason

    def test_pre_approved_rule_scope_matched_post_soft_deny(self):
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


class TestRecentDecisionCacheIntegration:
    def test_denied_then_retry_hits_cache(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
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
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason
        assert "Recent" not in d.reason

    def test_cache_hit_attaches_metadata_for_impl_23(self):
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

    def test_semantic_retry_hits_rule_cache(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.recent_decisions.record_rule_decision(
            "Bash",
            "force_push_any",
            "DENIED",
            "no force pushes",
            original_decision_ts="2026-05-12T19:00:00Z",
        )
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
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.recent_decisions.record_rule_decision("Bash", "rm_slash", "DENIED", "not allowed")
        d = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert d.outcome == Outcome.DENY
        assert "Hard-deny" in d.reason
        assert "Recent" not in d.reason

    def test_rule_cache_does_not_shadow_allowlist(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.allowlist.add("rule:force_push_any")
        engine.recent_decisions.record_rule_decision(
            "Bash", "force_push_any", "DENIED", "stale rejection"
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
        assert d.outcome == Outcome.ALLOW
        assert "Allowlist" in d.reason

    def test_pre_approval_beats_a_recent_denial_of_the_same_call(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        tool_input = {"command": "git push --force origin feature"}
        engine.recent_decisions.record("Bash", _sha256_tool_input(tool_input), "DENIED", "not yet")
        assert engine.evaluate_tool_use("Bash", tool_input).outcome == Outcome.DENY
        engine.allowlist.add("tool_type:Bash")
        d = engine.evaluate_tool_use("Bash", tool_input)
        assert d.outcome == Outcome.ALLOW
        assert d.reason == "Pre-approved by allowlist"

    def test_non_cache_decisions_have_no_cache_hit_metadata(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert engine.evaluate_tool_use("Bash", {"command": "npm test"}).cache_hit_metadata is None
        assert engine.evaluate_tool_use("Bash", {"command": "rm -rf /"}).cache_hit_metadata is None
        assert (
            engine.evaluate_tool_use(
                "Bash", {"command": "git push --force origin feature"}
            ).cache_hit_metadata
            is None
        )


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
        with pytest.raises(ValueError, match="rm_slash"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_disable=["rm_slash"],
            )

    def test_blueprint_disable_accepts_unknown_id(self):
        e = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_disable=["nonexistent_rule"],
        )
        assert "nonexistent_rule" in e._disabled_rule_ids

    def test_blueprint_64kb_cap_rejected(self):
        big = (
            '@tier("soft") @rule_id("big") '
            "forbid (principal, action, resource) "
            'when { context.x like "*aaaaaaaaaa*" };'
        ) * 1000
        assert len(big) > POLICIES_MAX_BYTES
        with pytest.raises(ValueError, match="64 KB cap"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                blueprint_soft_policies=big,
            )

    def test_registry_extra_policies_counted_in_64kb_cap(self):
        big = 'forbid (principal, action, resource) when { context.x like "*aaaaaaaaaa*" };' * 1000
        assert len(big) > POLICIES_MAX_BYTES
        with pytest.raises(ValueError, match="64 KB cap"):
            PolicyEngine(
                task_type="new_task",
                repo="owner/repo",
                extra_policies=[big],
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

    @pytest.mark.parametrize(
        ("policies", "message"),
        [
            pytest.param(
                {"extra_policies": ["forbid (principal, action, resource) when {"]},
                "Cedar policy parse failed",
                id="text that is not Cedar",
            ),
            pytest.param(
                {
                    "blueprint_soft_policies": '@tier("soft") @rule_id("t") '
                    '@approval_timeout_s("soon") forbid (principal, action, resource);'
                },
                "@approval_timeout_s must be integer",
                id="a timeout that is not a number",
            ),
            pytest.param(
                {
                    "blueprint_soft_policies": '@tier("soft") @rule_id("t") '
                    '@severity("urgent") forbid (principal, action, resource);'
                },
                "@severity must be one of",
                id="a severity outside low, medium, high",
            ),
            pytest.param(
                {
                    "blueprint_soft_policies": '@tier("soft") @rule_id("force_push_any") '
                    "forbid (principal, action, resource);"
                },
                "duplicate @rule_id 'force_push_any'",
                id="the rule id of a built-in rule of the same tier",
            ),
            pytest.param(
                {
                    "blueprint_soft_policies": '@tier("hard") @rule_id("h") '
                    "forbid (principal, action, resource);"
                },
                "lives in the 'soft' file",
                id="a hard rule among the soft rules",
            ),
        ],
    )
    def test_policy_the_engine_cannot_use_fails_at_start(self, policies, message):
        with pytest.raises(ValueError, match=message):
            PolicyEngine(task_type="new_task", repo="owner/repo", **policies)

    @pytest.mark.parametrize(
        ("rule", "attribute"),
        [
            pytest.param(
                "forbid (principal, action, resource) "
                'when { context.command like "*terraform destroy*" };',
                "command",
                id="a rule for every action reads the command",
            ),
            pytest.param(
                'forbid (principal, action == Agent::Action::"invoke_tool", '
                'resource == Agent::Tool::"Read") when { context.file_path like "*.pem" };',
                "file_path",
                id="a rule for the Read tool reads the file path",
            ),
            pytest.param(
                "forbid (principal, action, resource) "
                'when { resource == Agent::Tool::"Bash" && context.command like "*curl*" };',
                "command",
                id="a rule for the Bash tool reads the command",
            ),
            pytest.param(
                "forbid (principal, action, resource) "
                'when { resource == Agent::Tool::"Write" && context.file_path like "*.pem" };',
                "file_path",
                id="a rule for the Write tool reads the file path",
            ),
            pytest.param(
                "forbid (principal, action, resource) "
                'when { resource == Agent::Tool::"Edit" && context.file_path like "*.pem" };',
                "file_path",
                id="a rule for the Edit tool reads the file path",
            ),
            pytest.param(
                'forbid (principal, action == Agent::Action::"write_file", resource) '
                'when { context.command like "*terraform destroy*" };',
                "command",
                id="a rule for file writes reads the command",
            ),
            pytest.param(
                'forbid (principal, action == Agent::Action::"execute_bash", resource) '
                'when { context.file_path like "*.pem" };',
                "file_path",
                id="a rule for shell commands reads the file path",
            ),
        ],
    )
    def test_rule_reading_an_absent_context_attribute_fails_at_start(self, rule, attribute):
        with pytest.raises(ValueError, match=rf"soft-deny Cedar probe failed.*{attribute}"):
            PolicyEngine(task_type="new_task", repo="owner/repo", extra_policies=[rule])

    def test_hard_rule_reading_an_absent_context_attribute_fails_at_start(self):
        rule = (
            '@tier("hard") @rule_id("no_destroy") forbid (principal, action, resource) '
            'when { context.command like "*terraform destroy*" };'
        )
        with pytest.raises(ValueError, match=r"hard-deny Cedar probe failed.*command"):
            PolicyEngine(task_type="new_task", repo="owner/repo", blueprint_hard_policies=rule)


class TestFailClosedPosture:
    def test_cedarpy_parse_error_maps_to_deny_fail_closed(self):
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
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        d = engine.evaluate_tool_use("Bash", {"command": object()})
        assert d.outcome == Outcome.DENY
        assert d.reason == "fail-closed: unhashable_tool_input"


class TestReviewRegressions:
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
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            blueprint_disable=["force_push_any"],
        )
        d = engine.evaluate_tool_use("Bash", {"command": "git push --force origin main"})
        assert d.outcome == Outcome.REQUIRE_APPROVAL
        assert "force_push_main" in d.matching_rule_ids
        assert "force_push_any" not in d.matching_rule_ids

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

    def test_allowlist_strips_whitespace(self):
        al = ApprovalAllowlist(["  tool_type: Read  "])
        assert al.matches("Read", {"file_path": "a.py"}) is True

    def test_allowlist_empty_value_rejected(self):
        with pytest.raises(ValueError, match="missing value"):
            ApprovalAllowlist(["tool_type:"])

    def test_allowlist_empty_value_after_strip_rejected(self):
        with pytest.raises(ValueError, match="missing value"):
            ApprovalAllowlist(["tool_type:   "])

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


class TestApprovalGateCounter:
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
        assert e.approval_gate_count == 75

    def test_initial_approval_gate_count_seeds_counter(self):
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
    def test_empty_window(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert e.approvals_in_last_minute == 0

    def test_record_within_window_counts(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.record_approval_gate_timestamp(now=1000.0)
        e.record_approval_gate_timestamp(now=1010.0)
        assert len(e._approvals_last_minute) == 2

    def test_old_entries_pruned(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.record_approval_gate_timestamp(now=100.0)
        e.record_approval_gate_timestamp(now=105.0)
        e._prune_rate_window(200.0)
        assert len(e._approvals_last_minute) == 0

    def test_mixed_window_keeps_recent(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.record_approval_gate_timestamp(now=100.0)
        e.record_approval_gate_timestamp(now=155.0)
        e.record_approval_gate_timestamp(now=199.0)
        e._prune_rate_window(200.0)
        assert list(e._approvals_last_minute) == [155.0, 199.0]


class TestDenialInjectionQueue:
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
        assert e.drain_denial_injections() == []


class TestCeilingShrinkingLatch:
    def test_first_call_returns_true(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert e.mark_ceiling_shrinking_emitted() is True

    def test_subsequent_calls_return_false(self):
        e = PolicyEngine(task_type="new_task", repo="owner/repo")
        e.mark_ceiling_shrinking_emitted()
        assert e.mark_ceiling_shrinking_emitted() is False
        assert e.mark_ceiling_shrinking_emitted() is False


class TestRecentDecisionReasonText:
    def test_timed_out_retry_omits_the_missing_reason(self):
        from policy import PolicyEngine, _sha256_tool_input

        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        tool_input = {"file_path": "/workspace/t/docs/a.env", "content": "X=1\n"}
        engine.recent_decisions.record(
            "Write", _sha256_tool_input(tool_input), decision="TIMED_OUT", reason=""
        )
        decision = engine.evaluate_tool_use("Write", tool_input)
        assert decision.outcome == "deny"
        assert decision.reason == "Recent TIMED_OUT within 60s"

    def test_denied_retry_keeps_the_human_reason(self):
        from policy import PolicyEngine, _sha256_tool_input

        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        tool_input = {"file_path": "/workspace/t/docs/b.env", "content": "X=1\n"}
        engine.recent_decisions.record(
            "Write", _sha256_tool_input(tool_input), decision="DENIED", reason="use .example"
        )
        assert engine.evaluate_tool_use("Write", tool_input).reason == (
            "Recent DENIED within 60s: use .example"
        )
