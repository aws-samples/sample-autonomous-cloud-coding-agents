"""Unit tests for runner.py helpers.

The full ``run_agent`` path is integration-tested via test_pipeline.py
with a mocked ``pipeline.run_agent``. This module covers the narrower
``_initialize_policy_engine_and_hooks`` helper extracted in Chunk 7 so
the policy-engine bootstrap + ``pre_approvals_loaded`` emission can be
verified without spinning up the Claude Agent SDK client.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from models import TaskConfig
from runner import _initialize_policy_engine_and_hooks


def _config(**overrides: Any) -> TaskConfig:
    # Use an explicitly typed dict so ty can see the heterogenous field
    # types across the TaskConfig signature (``bool`` for ``dry_run``,
    # ``int`` for ``max_turns``, etc.) rather than inferring ``dict[str, str]``
    # from the homogeneous base literal.
    base: dict[str, Any] = {
        "repo_url": "owner/repo",
        "github_token": "ghp_test",
        "aws_region": "us-east-1",
        "task_id": "t-runner-1",
    }
    base.update(overrides)
    return TaskConfig(**base)


class TestInitializePolicyEngineAndHooks:
    """Bootstrap the per-task PolicyEngine + hooks without the SDK loop.

    Chunk 7 verifies two new behaviors:
      1. ``initial_approval_gate_count`` from ``TaskConfig`` reaches
         ``PolicyEngine.__init__`` so a container restart resumes the
         cumulative gate budget (§13.6).
      2. ``pre_approvals_loaded`` is emitted to the progress writer
         right after PolicyEngine init so the live SSE stream reports
         the starting posture (§4 step 7, §11.1).
    """

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_initial_approval_gate_count_threaded_to_engine(
        self, mock_policy_engine, _mock_build_hooks
    ):
        config = _config(initial_approval_gate_count=17)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        assert mock_policy_engine.called
        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["initial_approval_gate_count"] == 17

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_zero_initial_approval_gate_count_omits_kwarg(
        self, mock_policy_engine, _mock_build_hooks
    ):
        # Default path (fresh task, no restart). Helper omits the kwarg
        # so PolicyEngine falls back to its own default of 0 — avoids
        # threading 0 explicitly and keeps legacy construction surface.
        config = _config(initial_approval_gate_count=0)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert "initial_approval_gate_count" not in kwargs

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_initial_approvals_and_timeout_threaded(self, mock_policy_engine, _mock_build_hooks):
        config = _config(
            initial_approvals=["tool_type:Read", "rule:force_push_any"],
            approval_timeout_s=600,
        )
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["initial_approvals"] == ["tool_type:Read", "rule:force_push_any"]
        assert kwargs["task_default_timeout_s"] == 600

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_pre_approvals_loaded_emitted_with_initial_scopes(
        self, _mock_policy_engine, _mock_build_hooks
    ):
        config = _config(initial_approvals=["tool_type:Read", "all_session"])
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        progress.write_approval_pre_approvals_loaded.assert_called_once_with(
            count=2, scopes=["tool_type:Read", "all_session"]
        )

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_pre_approvals_loaded_emitted_with_zero_count_when_empty(
        self, _mock_policy_engine, _mock_build_hooks
    ):
        # §4 step 7: emit even when no pre-approvals — "no seeded scopes"
        # must be explicit in the live stream, not inferred from silence.
        config = _config()
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        progress.write_approval_pre_approvals_loaded.assert_called_once_with(count=0, scopes=[])

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_helper_returns_engine_and_hooks(self, mock_policy_engine, mock_build_hooks):
        engine_instance = MagicMock()
        hooks_instance = [MagicMock()]
        mock_policy_engine.return_value = engine_instance
        mock_build_hooks.return_value = hooks_instance

        engine, hooks = _initialize_policy_engine_and_hooks(
            config=_config(), trajectory=None, progress=MagicMock()
        )

        assert engine is engine_instance
        assert hooks is hooks_instance

    # --- Chunk 7b: approval_gate_cap fanout to PolicyEngine -----------------

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_approval_gate_cap_threaded_to_engine_when_set(
        self, mock_policy_engine, _mock_build_hooks
    ):
        # Chunk 7b: submit-time-resolved cap on TaskConfig must reach
        # PolicyEngine so blueprint overrides (or the default-50 frozen
        # at submit) apply on every container, including restarts.
        config = _config(approval_gate_cap=200)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["approval_gate_cap"] == 200

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_approval_gate_cap_omitted_when_none(self, mock_policy_engine, _mock_build_hooks):
        # Legacy tasks (pre-Chunk-7b) don't carry approval_gate_cap.
        # Helper must NOT thread None — the engine's default-50
        # fallback is what makes the legacy behavior preserved.
        config = _config(approval_gate_cap=None)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert "approval_gate_cap" not in kwargs
