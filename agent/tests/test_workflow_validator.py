"""Unit tests for the cross-field workflow validator (#248).

The golden corpus (``test_workflow_validation_corpus.py``) is the parity
contract; these tests pin individual rule behavior and edge cases directly, so a
rule regression is attributable to a named rule rather than a corpus diff.
"""

from __future__ import annotations

import pytest

from workflow import WorkflowValidationError, assert_valid, validate_workflow


def _base() -> dict:
    """A valid coding workflow (single source for mutation in tests)."""
    return {
        "id": "coding/new-task-v1",
        "version": "1.0.0",
        "domain": "coding",
        "requires_repo": True,
        "read_only": False,
        "prompt": {"template": "do the thing"},
        "hydration": {"sources": ["issue", "task_description"]},
        "agent_config": {
            "tier": "standard",
            "allowed_tools": ["Bash", "Read", "Write", "Edit"],
            "cedar_policy_modules": ["builtin/hard_deny", "builtin/soft_deny"],
        },
        "repo_config": {"provider": "github", "discover": True},
        "required_inputs": {"one_of": ["issue_number", "task_description"]},
        "steps": [
            {"kind": "clone_repo"},
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "ensure_pr", "strategy": "create"},
        ],
        "terminal_outcomes": {"primary": "pr_url"},
        "status": "production",
    }


def test_base_is_valid():
    assert validate_workflow(_base()) == []


def test_assert_valid_raises_on_violation():
    w = _base()
    w["version"] = "2.0.0"  # rule-1
    with pytest.raises(WorkflowValidationError, match="rule-1"):
        assert_valid(w)


class TestIndividualRules:
    def test_rule1_major_mismatch(self):
        w = _base()
        w["version"] = "3.1.0"
        assert "rule-1" in validate_workflow(w)

    @pytest.mark.parametrize("n_agents,expect", [(0, True), (1, False), (2, True)])
    def test_rule2_single_run_agent(self, n_agents, expect):
        w = _base()
        w["steps"] = [s for s in w["steps"] if s["kind"] != "run_agent"]
        w["steps"] += [{"kind": "run_agent"} for _ in range(n_agents)]
        assert ("rule-2" in validate_workflow(w)) is expect

    def test_rule3_domain_default_repo_less(self):
        # knowledge + requires_repo omitted -> repo-less by default; a clone_repo
        # step is then invalid, and the schema's allOf does NOT catch it.
        w = _base()
        w["id"] = "knowledge/x-v1"
        w["domain"] = "knowledge"
        del w["requires_repo"]
        del w["repo_config"]
        w["hydration"] = {"sources": ["task_description"]}
        w["required_inputs"] = {"all_of": ["task_description"]}
        w["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "clone_repo"},
            {"kind": "deliver_artifact", "target": "comment"},
        ]
        w["terminal_outcomes"] = {"primary": "comment"}
        assert "rule-3" in validate_workflow(w)

    def test_rule4_read_only_rejects_pr_create(self):
        # read_only ⇒ an ensure_pr that writes the tree (create/push) is invalid.
        w = _base()
        w["read_only"] = True
        w["agent_config"]["tier"] = "read-only"
        w["agent_config"]["allowed_tools"] = ["Bash", "Read"]
        # steps still contain ensure_pr strategy:create from _base()
        assert "rule-4" in validate_workflow(w)

    def test_rule7_repo_less_rejects_discover_and_provider(self):
        # knowledge default (repo-less); repo_config that discovers / names a
        # provider is invalid, and the schema can't see the domain default.
        w = _base()
        w["id"] = "knowledge/x-v1"
        w["domain"] = "knowledge"
        del w["requires_repo"]
        w["hydration"] = {"sources": ["task_description"]}
        w["required_inputs"] = {"all_of": ["task_description"]}
        w["repo_config"] = {"discover": True, "provider": "github"}
        w["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "deliver_artifact", "target": "comment"},
        ]
        w["terminal_outcomes"] = {"primary": "comment"}
        assert "rule-7" in validate_workflow(w)

    def test_rule5_policy_floor(self):
        w = _base()
        w["agent_config"]["cedar_policy_modules"] = ["builtin/hard_deny"]
        assert "rule-5" in validate_workflow(w)

    def test_rule5_read_only_exempt_from_soft_deny(self):
        # A read_only workflow need not carry soft_deny (it can't write).
        w = _base()
        w["read_only"] = True
        w["agent_config"]["tier"] = "read-only"
        w["agent_config"]["allowed_tools"] = ["Bash", "Read"]
        w["agent_config"]["cedar_policy_modules"] = ["builtin/hard_deny"]
        w["steps"] = [
            {"kind": "clone_repo"},
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "post_review"},
        ]
        w["terminal_outcomes"] = {"primary": "review_posted"}
        w["required_inputs"] = {"all_of": ["task_description"]}
        assert "rule-5" not in validate_workflow(w)

    def test_rule6_standard_tier_rejects_mcp(self):
        w = _base()
        w["agent_config"]["mcp_servers"] = ["builtin/linear"]
        assert "rule-6" in validate_workflow(w)

    def test_rule6_elevated_tier_allows_mcp(self):
        w = _base()
        w["agent_config"]["tier"] = "elevated"
        w["agent_config"]["mcp_servers"] = ["builtin/linear"]
        assert "rule-6" not in validate_workflow(w)

    def test_rule6_read_only_tier_rejects_elevated_fields(self):
        # read-only is BELOW standard; it must not declare extended reach either.
        w = _base()
        w["read_only"] = True
        w["agent_config"]["tier"] = "read-only"
        w["agent_config"]["allowed_tools"] = ["Bash", "Read"]
        w["agent_config"]["cedar_policy_modules"] = ["builtin/hard_deny"]
        w["agent_config"]["skills"] = ["registry://skill/x-v1"]
        w["steps"] = [
            {"kind": "clone_repo"},
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "post_review"},
        ]
        w["terminal_outcomes"] = {"primary": "review_posted"}
        w["required_inputs"] = {"all_of": ["task_description"]}
        assert "rule-6" in validate_workflow(w)

    @pytest.mark.parametrize(
        "ref,bad",
        [
            ("builtin/soft_deny", False),
            ("registry://cedar/custom-v1", False),
            ("http://evil", True),
            ("soft_deny", True),
        ],
    )
    def test_rule8_ref_resolution(self, ref, bad):
        w = _base()
        w["agent_config"]["cedar_policy_modules"] = ["builtin/hard_deny", "builtin/soft_deny", ref]
        assert ("rule-8" in validate_workflow(w)) is bad

    def test_rule8_unknown_deliver_target_flagged(self):
        # ADR-014 addendum: deliver_artifact.target must name a registered
        # deliverer. rule-8 catches an unknown target universally (rule-11 only
        # catches it when it collides with the primary outcome).
        w = _base()
        w["id"] = "knowledge/x-v1"
        w["domain"] = "knowledge"
        del w["requires_repo"]
        w["repo_config"] = {"discover": False}
        w["hydration"] = {"sources": ["task_description"]}
        w["required_inputs"] = {"all_of": ["task_description"]}
        w["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "deliver_artifact", "target": "typo_target"},
        ]
        w["terminal_outcomes"] = {"primary": "artifact"}
        assert "rule-8" in validate_workflow(w)

    def test_rule8_known_deliver_target_ok(self):
        w = _base()
        w["id"] = "knowledge/x-v1"
        w["domain"] = "knowledge"
        del w["requires_repo"]
        w["repo_config"] = {"discover": False}
        w["hydration"] = {"sources": ["task_description"]}
        w["required_inputs"] = {"all_of": ["task_description"]}
        w["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "deliver_artifact", "target": "s3"},
        ]
        w["terminal_outcomes"] = {"primary": "artifact"}
        assert "rule-8" not in validate_workflow(w)

    def test_rule9_unsatisfiable_input(self):
        w = _base()
        w["required_inputs"] = {"all_of": ["pr_number"]}  # no pull_request source
        assert "rule-9" in validate_workflow(w)

    def test_rule11_outcome_requires_step(self):
        w = _base()
        w["terminal_outcomes"] = {"primary": "artifact"}  # no deliver_artifact
        assert "rule-11" in validate_workflow(w)

    def _repo_less_deliver(self, target: str, primary: str) -> dict:
        """A repo-less workflow ending in one deliver_artifact step."""
        w = _base()
        w["id"] = "knowledge/x-v1"
        w["domain"] = "knowledge"
        del w["requires_repo"]
        w["repo_config"] = {"discover": False}
        w["hydration"] = {"sources": ["task_description"]}
        w["required_inputs"] = {"all_of": ["task_description"]}
        w["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "deliver_artifact", "target": target},
        ]
        w["terminal_outcomes"] = {"primary": primary}
        return w

    def test_rule11_comment_outcome_s3_only_target_flagged(self):
        # primary=comment but the deliver step only targets s3 → never posts a comment.
        w = self._repo_less_deliver(target="s3", primary="comment")
        assert "rule-11" in validate_workflow(w)

    @pytest.mark.parametrize("target", ["comment", "s3_and_comment"])
    def test_rule11_comment_outcome_satisfied_by_matching_target(self, target):
        w = self._repo_less_deliver(target=target, primary="comment")
        assert "rule-11" not in validate_workflow(w)

    def test_rule11_artifact_outcome_comment_only_target_flagged(self):
        # primary=artifact but the deliver step only posts a comment → no artifact.
        w = self._repo_less_deliver(target="comment", primary="artifact")
        assert "rule-11" in validate_workflow(w)

    def test_rule11_unknown_deliverer_target_flagged(self):
        # ADR-014 addendum: target is an open string resolving to a registered
        # deliverer. An unknown name produces nothing the validator can vouch
        # for, so a declared primary outcome it doesn't back is flagged.
        w = self._repo_less_deliver(target="not_a_registered_deliverer", primary="artifact")
        assert "rule-11" in validate_workflow(w)

    def test_rule11_unset_target_comment_outcome_flagged(self):
        # PR review #296 finding #7: an unset target now resolves to the runtime
        # default (s3, produces only `artifact`), so a primary:comment workflow
        # that omits target is flagged — it would never post the comment it
        # declares. Previously the validator was lenient here (full set) and let
        # this pass while the runtime silently delivered to s3 only.
        w = self._repo_less_deliver(target="s3", primary="comment")
        del w["steps"][2]["target"]  # omit target entirely
        assert "rule-11" in validate_workflow(w)

    def test_rule11_unset_target_artifact_outcome_passes(self):
        # The complement: primary:artifact with an unset target is fine, because
        # the default target (s3) produces `artifact`. Validator and runtime agree.
        w = self._repo_less_deliver(target="s3", primary="artifact")
        del w["steps"][2]["target"]
        assert "rule-11" not in validate_workflow(w)

    def test_rule12_side_effect_continue(self):
        w = _base()
        w["steps"][-1] = {"kind": "ensure_pr", "strategy": "create", "on_failure": "continue"}
        assert "rule-12" in validate_workflow(w)

    def test_rule12_advisory_continue_allowed(self):
        # A non-side-effecting step may use on_failure: continue.
        w = _base()
        w["steps"].insert(3, {"kind": "verify_lint", "on_failure": "continue"})
        assert "rule-12" not in validate_workflow(w)

    def test_rule14_non_github_provider(self):
        w = _base()
        w["repo_config"]["provider"] = "gitlab"
        assert "rule-14" in validate_workflow(w)


def test_validator_reports_complete_verdict_on_shape_invalid():
    """Even a shape-invalid file gets the full cross-field verdict, not just 'schema'."""
    w = _base()
    del w["steps"]  # schema violation
    w["version"] = "2.0.0"  # rule-1 still computable
    verdict = validate_workflow(w)
    assert "schema" in verdict
    assert "rule-1" in verdict


def test_rule13_not_enforced_locally():
    """Model allow-list (rule 13) is a create-task-boundary check, not file-local."""
    w = _base()
    w["agent_config"]["model"] = {"id": "some.unapproved.model"}
    # The file-local validator must NOT flag model choice — that's the boundary's job.
    assert validate_workflow(w) == []
