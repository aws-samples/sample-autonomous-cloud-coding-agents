# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Blueprint ``cedar_policies`` reach the engine input their declared tier needs.

The Cedar policy guide documents fully annotated hard and soft rules. Before this
routing, every annotated rule went down the legacy ``extra_policies`` path, which
rejects annotations, so following the guide failed every task at start.
"""

from __future__ import annotations

import pytest

from policy import PolicyEngine
from runner import split_blueprint_policies

# Verbatim from docs/guides/CEDAR_POLICY_GUIDE.md "Where rules live".
GUIDE_HARD = """@tier("hard")
@rule_id("block_prod_writes")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "prod/**" };"""
GUIDE_SOFT = """@tier("soft")
@rule_id("deploy_staging")
@severity("high")
@approval_timeout_s("900")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*terraform apply*" };"""
LEGACY = """forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*legacy-danger*" };"""


def engine_for(policies: list[str], **kwargs) -> PolicyEngine:
    legacy, hard, soft = split_blueprint_policies(policies)
    return PolicyEngine(
        task_type="new_task",
        repo="owner/repo",
        extra_policies=legacy or None,
        blueprint_hard_policies="\n".join(hard) or None,
        blueprint_soft_policies="\n".join(soft) or None,
        **kwargs,
    )


def test_routes_each_string_by_its_declared_tier():
    assert split_blueprint_policies([GUIDE_HARD, GUIDE_SOFT, LEGACY]) == (
        [LEGACY],
        [GUIDE_HARD],
        [GUIDE_SOFT],
    )


def test_guide_rules_build_an_engine_and_enforce_as_documented():
    engine = engine_for([GUIDE_HARD, GUIDE_SOFT])

    hard = engine.evaluate_tool_use("Write", {"file_path": "prod/config.yaml", "content": "x"})
    assert hard.outcome == "deny"

    soft = engine.evaluate_tool_use(
        "Bash", {"command": "cd infra && terraform apply -auto-approve"}
    )
    assert soft.outcome == "require_approval"
    assert "deploy_staging" in soft.matching_rule_ids
    # Min-wins: the task's default window (300 s) caps the rule's 900 s ...
    assert soft.timeout_s == 300
    # ... and a task submitted with a longer window gets the rule's full 900 s.
    longer = engine_for([GUIDE_SOFT], task_default_timeout_s=3600)
    assert longer.evaluate_tool_use("Bash", {"command": "terraform apply"}).timeout_s == 900

    assert engine.evaluate_tool_use("Bash", {"command": "terraform plan"}).outcome == "allow"


def test_unannotated_rules_keep_the_legacy_soft_wrapping():
    decision = engine_for([LEGACY]).evaluate_tool_use("Bash", {"command": "run legacy-danger now"})
    assert decision.outcome == "require_approval"
    assert tuple(decision.matching_rule_ids) == ("legacy_extra_0",)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (GUIDE_HARD + "\n" + GUIDE_SOFT, "both"),
        ('@rule_id("orphan")\nforbid (principal, action, resource);', "declare the tier"),
    ],
)
def test_ambiguous_annotations_fail_instead_of_guessing(text, message):
    with pytest.raises(ValueError, match=message):
        split_blueprint_policies([text])
