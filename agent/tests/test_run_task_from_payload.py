from __future__ import annotations

from unittest.mock import patch

from pipeline import _RUN_TASK_PARAMS, run_task_from_payload


def _capture(payload: dict) -> dict:
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
        assert "prompt" not in seen
        assert "model_id" not in seen

    def test_forwards_every_channel_field_to_the_agent(self):
        cm = {"linear_issue_id": "iss-1", "linear_oauth_secret_arn": "arn:sm:...:lin"}
        seen = _capture({"channel_source": "linear", "channel_metadata": cm})
        assert seen["channel_source"] == "linear"
        assert seen["channel_metadata"] == cm

    def test_forwards_build_and_lint_and_cedar_and_branch_fields(self):
        seen = _capture(
            {
                "build_command": "npm ci && npm test",
                "lint_command": "npm run lint",
                "cedar_policies": ["p1", "p2"],
                "base_branch": "epic-tip",
                "merge_branches": ["a", "b"],
                "attachments": [{"filename": "x.png"}],
                "trace": True,
                "user_id": "user-9",
            }
        )
        assert seen["build_command"] == "npm ci && npm test"
        assert seen["lint_command"] == "npm run lint"
        assert seen["cedar_policies"] == ["p1", "p2"]
        assert seen["base_branch"] == "epic-tip"
        assert seen["merge_branches"] == ["a", "b"]
        assert seen["attachments"] == [{"filename": "x.png"}]
        assert seen["trace"] is True
        assert seen["user_id"] == "user-9"

    def test_coerces_issue_and_pr_number_to_str_and_max_turns_to_int(self):
        seen = _capture({"issue_number": 42, "pr_number": 7, "max_turns": "50"})
        assert seen["issue_number"] == "42"
        assert seen["pr_number"] == "7"
        assert seen["max_turns"] == 50
        assert isinstance(seen["max_turns"], int)

    def test_ignores_unknown_payload_keys(self):
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
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"github_token_secret_arn": "arn:aws:secretsmanager:...", "repo_url": "r"})
        assert not [m for level, m in logs if "github_token_secret_arn" in m], (
            "github_token_secret_arn must drop quietly — it is always resolved via env"
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
        # int() accepts a bool (int(True) == 1) and truncates a float (int(3.9) == 3).
        assert "max_turns" not in _capture({"repo_url": "r", "max_turns": True})
        assert "max_turns" not in _capture({"repo_url": "r", "max_turns": 3.9})
        assert _capture({"repo_url": "r", "max_turns": 50})["max_turns"] == 50
        assert _capture({"repo_url": "r", "max_turns": "50"})["max_turns"] == 50
        assert _capture({"repo_url": "r", "max_turns": 50.0})["max_turns"] == 50

    def test_does_NOT_warn_when_dropping_a_foreign_key(self):
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"some_future_unrelated_key": "v", "repo_url": "r"})
        assert not [m for level, m in logs if "some_future_unrelated_key" in m]

    def test_warns_when_dropping_task_started_at_HITL_parity(self):
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            _capture({"task_started_at": "2026-07-14T00:00:00Z", "repo_url": "r"})
        assert [m for level, m in logs if level == "WARN" and "task_started_at" in m]

    def test_malformed_max_turns_is_dropped_not_raised(self):
        logs: list[tuple[str, str]] = []
        with patch("pipeline.log", side_effect=lambda level, msg, **kw: logs.append((level, msg))):
            seen = _capture({"repo_url": "r", "max_turns": "not-a-number"})
        assert "max_turns" not in seen
        assert [m for level, m in logs if level == "WARN" and "max_turns" in m]

    def test_valid_max_turns_still_coerced_to_int(self):
        seen = _capture({"repo_url": "r", "max_turns": "50"})
        assert seen["max_turns"] == 50
        assert isinstance(seen["max_turns"], int)
