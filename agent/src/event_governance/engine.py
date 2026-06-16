"""Build PolicyEngine from TaskConfig for event governance gates."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models import TaskConfig
    from policy import PolicyEngine


def build_policy_engine(config: TaskConfig) -> PolicyEngine:
    """Mirror runner.py PolicyEngine construction for checkpoint gates."""
    from policy import PolicyEngine

    engine_kwargs: dict = {}
    if config.initial_approvals:
        engine_kwargs["initial_approvals"] = list(config.initial_approvals)
    if config.approval_timeout_s is not None:
        engine_kwargs["task_default_timeout_s"] = config.approval_timeout_s
    if config.initial_approval_gate_count:
        engine_kwargs["initial_approval_gate_count"] = config.initial_approval_gate_count
    if config.approval_gate_cap is not None:
        engine_kwargs["approval_gate_cap"] = config.approval_gate_cap
    cedar = config.cedar_policies if config.cedar_policies else None
    return PolicyEngine(
        task_type=config.policy_principal,
        repo=config.repo_url,
        read_only=config.read_only,
        extra_policies=cedar,
        **engine_kwargs,
    )
