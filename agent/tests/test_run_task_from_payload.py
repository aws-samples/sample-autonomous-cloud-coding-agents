"""Unit tests for pipeline.run_task_from_payload — the ECS payload→run_task map.

Regression cover for ABCA-487: the ECS boot command used to hand-list a subset
of run_task kwargs and silently dropped channel_source/channel_metadata (no
Linear/Jira reactions on ECS), build_command, cedar_policies, base_branch, etc.
run_task_from_payload maps the WHOLE payload so nothing is dropped again.
"""

from __future__ import annotations

from unittest.mock import patch

from pipeline import _RUN_TASK_PARAMS, run_task_from_payload


def _capture(payload: dict) -> dict:
    """Run the mapper with run_task replaced by a capturing stub; return kwargs."""
    seen: dict = {}

    def fake_run_task(**kwargs):
        seen.update(kwargs)
        return {"status": "success"}

    with patch("pipeline.run_task", side_effect=fake_run_task):
        run_task_from_payload(payload)
    return seen


class TestRunTaskFromPayload:
    def test_renames_prompt_and_model_id(self):
        seen = _capture({"prompt": "do the thing", "model_id": "anthropic.claude-x"})
        assert seen["task_description"] == "do the thing"
        assert seen["anthropic_model"] == "anthropic.claude-x"
        # The original payload keys must NOT leak through as-is (run_task rejects them).
        assert "prompt" not in seen
        assert "model_id" not in seen

    def test_forwards_channel_fields_ABCA_487(self):
        # THE regression: channel_source/channel_metadata must reach run_task so
        # the Linear/Jira reaction + channel MCP fire on ECS.
        cm = {"linear_issue_id": "iss-1", "linear_oauth_secret_arn": "arn:sm:...:lin"}
        seen = _capture({"channel_source": "linear", "channel_metadata": cm})
        assert seen["channel_source"] == "linear"
        assert seen["channel_metadata"] == cm

    def test_forwards_cedar_attachments_trace_user_fields(self):
        # HITL guardrails (cedar_policies, approval_*), attachments, trace, and
        # user_id are real run_task params here — they must reach run_task on ECS
        # (the hand-listed boot command used to drop them).
        seen = _capture(
            {
                "cedar_policies": ["p1", "p2"],
                "attachments": [{"filename": "x.png"}],
                "trace": True,
                "user_id": "user-9",
            }
        )
        assert seen["cedar_policies"] == ["p1", "p2"]
        assert seen["attachments"] == [{"filename": "x.png"}]
        assert seen["trace"] is True
        assert seen["user_id"] == "user-9"

    def test_drops_payload_keys_that_are_not_yet_run_task_params(self):
        # build_command/lint_command (configurable verify, #1) and base_branch/
        # merge_branches (orchestration stacking, #247) are emitted by the
        # orchestrator but are NOT run_task parameters on this branch. The mapper
        # filters against run_task's REAL signature, so they are dropped rather
        # than smuggled through as an invalid kwarg. When those params land,
        # they forward automatically with no change here — that's the point of
        # keying off inspect.signature instead of a hand-list.
        seen = _capture(
            {
                "repo_url": "org/repo",
                "build_command": "npm ci && npm test",
                "lint_command": "npm run lint",
                "base_branch": "epic-tip",
                "merge_branches": ["a", "b"],
            }
        )
        assert seen["repo_url"] == "org/repo"
        for not_yet in ("build_command", "lint_command", "base_branch", "merge_branches"):
            assert not_yet not in seen

    def test_coerces_issue_and_pr_number_to_str_and_max_turns_to_int(self):
        seen = _capture({"issue_number": 42, "pr_number": 7, "max_turns": "50"})
        assert seen["issue_number"] == "42"
        assert seen["pr_number"] == "7"
        assert seen["max_turns"] == 50
        assert isinstance(seen["max_turns"], int)

    def test_ignores_unknown_payload_keys(self):
        # github_token_secret_arn is on the payload but is NOT a run_task param
        # (it's consumed platform-side); passing it as **kwargs would TypeError.
        seen = _capture(
            {
                "repo_url": "org/repo",
                "github_token_secret_arn": "arn:...",
                "sources": ["x"],
            }
        )
        assert seen["repo_url"] == "org/repo"
        assert "github_token_secret_arn" not in seen
        assert "sources" not in seen

    def test_github_token_secret_arn_dropped_quietly(self):
        # N3: github_token_secret_arn is ALWAYS present and ALWAYS resolved via
        # the GITHUB_TOKEN_SECRET_ARN env (never a run_task param), so its drop is
        # 100% expected and must NOT fire the known-key WARN — that channel is for
        # genuine future contract gaps, not this always-dropped key.
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"github_token_secret_arn": "arn:aws:secretsmanager:...", "repo_url": "r"})
        assert not [m for level, m in logs if "github_token_secret_arn" in m], (
            "github_token_secret_arn must drop quietly (N3) — it is always resolved via env"
        )

    def test_drops_none_values_so_run_task_defaults_apply(self):
        seen = _capture({"repo_url": "org/repo", "base_branch": None, "channel_metadata": None})
        assert "base_branch" not in seen
        assert "channel_metadata" not in seen

    def test_aws_region_falls_back_to_env(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        seen = _capture({"repo_url": "org/repo"})
        assert seen["aws_region"] == "us-east-1"

    def test_explicit_aws_region_in_payload_wins(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        seen = _capture({"repo_url": "org/repo", "aws_region": "eu-west-1"})
        assert seen["aws_region"] == "eu-west-1"

    def test_every_forwarded_key_is_a_real_run_task_param(self):
        # Guard: whatever the mapper forwards must be accepted by run_task, so a
        # future payload key can never smuggle an invalid kwarg through. Compare
        # against the module's real param set (run_task is patched in _capture).
        accepted = _RUN_TASK_PARAMS
        seen = _capture(
            {
                "prompt": "p",
                "model_id": "m",
                "repo_url": "r",
                "issue_number": 1,
                "channel_source": "linear",
                "channel_metadata": {"a": "b"},
                "build_command": "b",
                "cedar_policies": ["c"],
                "base_branch": "x",
                "attachments": [{}],
                "trace": False,
                "user_id": "u",
                "pr_number": 3,
                "hydrated_context": {"k": "v"},
                "resolved_workflow": {"id": "w"},
            }
        )
        assert set(seen).issubset(accepted)

    def test_max_turns_rejects_surprising_inputs(self):
        # N4: int() accepts a bool (int(True)==1) and truncates a float
        # (int(3.9)==3). The orchestrator always emits a real int, but a corrupt
        # / hand-edited payload must not silently become a bogus turn count —
        # drop with a breadcrumb and let run_task's default apply.
        assert "max_turns" not in _capture({"repo_url": "r", "max_turns": True})
        assert "max_turns" not in _capture({"repo_url": "r", "max_turns": 3.9})
        # Valid inputs still pass: a real int and an int-valued string / float.
        assert _capture({"repo_url": "r", "max_turns": 50})["max_turns"] == 50
        assert _capture({"repo_url": "r", "max_turns": "50"})["max_turns"] == 50
        assert _capture({"repo_url": "r", "max_turns": 50.0})["max_turns"] == 50

    def test_warns_when_dropping_a_known_orchestrator_key(self):
        # N4: a KNOWN orchestrator key that run_task doesn't accept is dropped
        # (expected today) but logged, so a future "wired one side, forgot the
        # other" contract gap (the ABCA-487 class) is visible, not silent.
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"build_command": "mise run build", "repo_url": "r"})
        assert [m for level, m in logs if level == "WARN" and "build_command" in m], (
            "expected a WARN when dropping the known orchestrator key build_command"
        )

    def test_does_NOT_warn_when_dropping_a_foreign_key(self):
        # A genuinely-foreign key (not a known orchestrator field) is dropped
        # quietly — no log noise for keys we never expected to forward.
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"some_future_unrelated_key": "v", "repo_url": "r"})
        assert not [m for level, m in logs if "some_future_unrelated_key" in m]

    def test_warns_when_dropping_task_started_at_HITL_parity(self):
        # task_started_at drives the AgentCore HITL maxLifetime clip via
        # TASK_STARTED_AT; the ECS path doesn't set it yet, so its drop must WARN
        # (surface the AgentCore↔ECS parity gap, not silently fail-open).
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"task_started_at": "2026-07-14T00:00:00Z", "repo_url": "r"})
        assert [m for level, m in logs if level == "WARN" and "task_started_at" in m]

    def test_malformed_max_turns_is_dropped_not_raised(self):
        # A non-integer max_turns must not crash the boot — it's dropped (run_task
        # default applies) with a WARN, matching how every other field defaults.
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            seen = _capture({"repo_url": "r", "max_turns": "not-a-number"})
        assert "max_turns" not in seen
        assert [m for level, m in logs if level == "WARN" and "max_turns" in m]

    def test_valid_max_turns_still_coerced_to_int(self):
        seen = _capture({"repo_url": "r", "max_turns": "50"})
        assert seen["max_turns"] == 50
        assert isinstance(seen["max_turns"], int)
