# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Exercise Blueprint Cedar policies through the runner's normal bootstrap."""

from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from models import TaskConfig
from policy import POLICIES_MAX_BYTES, PolicyEngine
from runner import _initialize_policy_engine_and_hooks

LEGACY = """forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command == "echo legacy" };"""


@pytest.fixture(scope="module")
def guide_policies() -> list[str]:
    guide = Path(__file__).resolve().parents[2] / "docs/guides/CEDAR_POLICY_GUIDE.md"
    array = re.search(
        r"cedarPolicies:\s*\[(.*?)^\s*\]", guide.read_text(), re.DOTALL | re.MULTILINE
    )
    assert array, "The guide must include the Blueprint's cedarPolicies array"
    return re.findall(r"`([^`]+)`", array[1])


def engine_for(policies: list[str], *, timeout_s: int | None = None) -> PolicyEngine:
    config = TaskConfig(
        repo_url="owner/repo",
        aws_region="us-east-1",
        cedar_policies=policies,
        approval_timeout_s=timeout_s,
    )
    engine, _ = _initialize_policy_engine_and_hooks(
        config=config, trajectory=None, progress=MagicMock()
    )
    return engine


@pytest.mark.parametrize("tool", ["Write", "Edit"])
@pytest.mark.parametrize(
    ("path", "outcome"),
    [
        ("prod/config.yaml", "deny"),
        ("/workspace/repo/prod/config.yaml", "deny"),
        ("services/prod/nested/config.yaml", "deny"),
        ("/workspace/repo/prod/nested/config.yaml", "deny"),
        ("production/config.yaml", "allow"),
        ("/workspace/repo/nonprod/config.yaml", "allow"),
    ],
)
def test_guide_hard_rule_matches_the_prod_directory(guide_policies, tool, path, outcome):
    decision = engine_for(guide_policies).evaluate_tool_use(tool, {"file_path": path})
    assert decision.outcome == outcome
    if outcome == "deny":
        assert "block_prod_writes" in decision.reason


@pytest.mark.parametrize(("task_timeout", "expected"), [(None, 300), (600, 600), (3600, 900)])
def test_guide_soft_rule_uses_shorter_approval_window(guide_policies, task_timeout, expected):
    engine = engine_for(guide_policies, timeout_s=task_timeout)
    decision = engine.evaluate_tool_use("Bash", {"command": "terraform apply"})
    assert decision.outcome == "require_approval"
    assert decision.matching_rule_ids == ("deploy_staging",)
    assert decision.timeout_s == expected
    assert engine.evaluate_tool_use("Bash", {"command": "terraform plan"}).outcome == "allow"


@pytest.mark.parametrize(
    "comment", ["", '// Older versions used @tier("hard") and @rule_id("old").\n']
)
def test_legacy_rule_keeps_its_generated_id(guide_policies, comment):
    engine = engine_for([*guide_policies, comment + LEGACY])
    decision = engine.evaluate_tool_use("Bash", {"command": "echo legacy"})
    assert decision.outcome == "require_approval"
    assert decision.matching_rule_ids == ("legacy_extra_0",)


def test_mixed_tiers_in_one_entry_fail_task_start(guide_policies):
    with pytest.raises(ValueError, match="both"):
        engine_for(["\n".join(guide_policies)])


def test_rule_id_without_a_tier_fails_task_start():
    with pytest.raises(ValueError, match="declare the tier"):
        engine_for(['@rule_id("orphan")\nforbid (principal, action, resource);'])


def test_unbound_template_in_a_blueprint_entry_fails_task_start(guide_policies):
    with pytest.raises(ValueError, match=r"cedar_policies\[1\].*template"):
        engine_for(
            [LEGACY, guide_policies[0] + "\npermit (principal == ?principal, action, resource);"]
        )


def test_oversized_blueprint_is_rejected_before_parsing():
    with pytest.raises(ValueError, match="64 KB cap"):
        engine_for([" " * POLICIES_MAX_BYTES, "malformed"])
