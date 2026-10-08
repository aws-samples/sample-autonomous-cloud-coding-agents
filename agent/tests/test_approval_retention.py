"""Approval deadlines are explicit; compute lifetime never creates one."""

import math

from hooks import _ApprovalDeadline, _compute_effective_timeout
from policy import PolicyEngine


def test_default_builtin_gate_has_no_automatic_deadline():
    engine = PolicyEngine(task_type="new_task", repo="owner/repo")
    decision = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
    assert decision.outcome == "require_approval"
    assert decision.timeout_s == 0


def test_zero_deadline_survives_a_long_pause(monkeypatch):
    deadline = _ApprovalDeadline.from_recorded("2026-01-01T00:00:00Z", 0)
    monkeypatch.setattr("hooks.time.time", lambda: 9_999_999_999)
    monkeypatch.setattr("hooks.time.monotonic", lambda: 9_999_999_999)
    assert math.isinf(deadline.remaining_s())
    assert _compute_effective_timeout(
        decision_timeout_s=0, task_default_timeout_s=0, remaining_lifetime_s=10
    ) == (0, None, 0)


def test_explicit_rule_deadline_survives_a_no_deadline_task_default():
    engine = PolicyEngine(
        task_type="new_task",
        repo="owner/repo",
        blueprint_soft_policies=(
            '@tier("soft") @rule_id("explicit") @approval_timeout_s("120") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*explicit-tool*" };'
        ),
    )
    decision = engine.evaluate_tool_use("Bash", {"command": "explicit-tool"})
    assert decision.timeout_s == 120
