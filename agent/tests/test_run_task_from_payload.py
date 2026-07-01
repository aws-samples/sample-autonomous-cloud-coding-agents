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
