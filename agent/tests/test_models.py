"""Unit tests for models.py — TaskType enum and Pydantic models."""

import pytest
from pydantic import ValidationError

from models import (
    SUPPORTED_HYDRATED_CONTEXT_VERSION,
    AgentResult,
    GitHubIssue,
    HydratedContext,
    IssueComment,
    MemoryContext,
    RepoSetup,
    TaskConfig,
    TaskResult,
    TaskType,
    TokenUsage,
)


class TestTaskType:
    def test_new_task_value(self):
        assert TaskType.new_task == "new_task"

    def test_pr_iteration_value(self):
        assert TaskType.pr_iteration == "pr_iteration"

    def test_pr_review_value(self):
        assert TaskType.pr_review == "pr_review"

    def test_new_task_is_not_pr_task(self):
        assert not TaskType.new_task.is_pr_task

    def test_pr_iteration_is_pr_task(self):
        assert TaskType.pr_iteration.is_pr_task

    def test_pr_review_is_pr_task(self):
        assert TaskType.pr_review.is_pr_task

    def test_new_task_is_not_read_only(self):
        assert not TaskType.new_task.is_read_only

    def test_pr_iteration_is_not_read_only(self):
        assert not TaskType.pr_iteration.is_read_only

    def test_pr_review_is_read_only(self):
        assert TaskType.pr_review.is_read_only

    def test_str_enum_membership(self):
        assert TaskType.new_task == "new_task"
        assert TaskType.pr_review == "pr_review"


class TestIssueComment:
    def test_construction(self):
        c = IssueComment(id=1, author="alice", body="Looks good!")
        assert c.id == 1
        assert c.author == "alice"
        assert c.body == "Looks good!"

    def test_frozen(self):
        c = IssueComment(id=1, author="alice", body="text")
        with pytest.raises(ValidationError):
            c.author = "bob"

    def test_model_dump(self):
        c = IssueComment(id=99, author="alice", body="text")
        d = c.model_dump()
        assert d == {"id": 99, "author": "alice", "body": "text"}

    def test_extra_forbidden(self):
        with pytest.raises(ValidationError):
            IssueComment.model_validate({"id": 1, "author": "a", "body": "b", "unknown": True})


class TestGitHubIssue:
    def test_construction_with_defaults(self):
        issue = GitHubIssue(title="Bug", number=1)
        assert issue.title == "Bug"
        assert issue.body == ""
        assert issue.number == 1
        assert issue.comments == []

    def test_construction_with_comments(self):
        issue = GitHubIssue(
            title="Bug",
            body="desc",
            number=42,
            comments=[IssueComment(id=10, author="bob", body="noted")],
        )
        assert len(issue.comments) == 1
        assert issue.comments[0].author == "bob"

    def test_frozen(self):
        issue = GitHubIssue(title="Bug", number=1)
        with pytest.raises(ValidationError):
            issue.title = "Feature"


class TestMemoryContext:
    def test_defaults(self):
        mc = MemoryContext()
        assert mc.repo_knowledge == []
        assert mc.past_episodes == []

    def test_construction(self):
        mc = MemoryContext(repo_knowledge=["Uses TS"], past_episodes=["Task t0"])
        assert mc.repo_knowledge == ["Uses TS"]
        assert mc.past_episodes == ["Task t0"]

    def test_frozen(self):
        mc = MemoryContext()
        with pytest.raises(ValidationError):
            mc.repo_knowledge = ["new"]


class TestHydratedContext:
    def test_construction(self):
        hc = HydratedContext(user_prompt="Fix the bug")
        assert hc.version == 1
        assert hc.user_prompt == "Fix the bug"
        assert hc.issue is None
        assert hc.sources == []
        assert hc.token_estimate == 0
        assert hc.resolved_branch_name is None
        assert hc.resolved_base_branch is None
        assert hc.truncated is False
        assert hc.memory_context is None
        assert hc.fallback_error is None
        assert hc.guardrail_blocked is None

    def test_with_nested_models(self):
        hc = HydratedContext(
            user_prompt="Fix it",
            issue=GitHubIssue(title="Bug", number=1),
            memory_context=MemoryContext(repo_knowledge=["TS"]),
        )
        assert hc.issue is not None and hc.issue.title == "Bug"
        assert hc.memory_context is not None and hc.memory_context.repo_knowledge == ["TS"]

    def test_frozen(self):
        hc = HydratedContext(user_prompt="test")
        with pytest.raises(ValidationError):
            hc.user_prompt = "changed"

    def test_model_validate_from_dict(self):
        data = {
            "version": 1,
            "user_prompt": "Fix bug",
            "issue": {"title": "Bug", "number": 42, "body": "", "comments": []},
            "sources": ["github_issue"],
            "token_estimate": 100,
            "truncated": True,
        }
        hc = HydratedContext.model_validate(data)
        assert hc.user_prompt == "Fix bug"
        assert hc.issue is not None and hc.issue.number == 42
        assert hc.truncated is True
        assert hc.sources == ["github_issue"]
        assert hc.token_estimate == 100

    def test_model_validate_orchestrator_shape(self):
        data = {
            "version": 1,
            "user_prompt": "Do the thing",
            "issue": {
                "number": 7,
                "title": "T",
                "body": "B",
                "comments": [{"id": 1, "author": "u", "body": "c"}],
            },
            "memory_context": {"repo_knowledge": ["k"], "past_episodes": ["e"]},
            "sources": ["github_issue", "memory"],
            "token_estimate": 500,
            "truncated": False,
            "fallback_error": None,
            "guardrail_blocked": None,
            "resolved_branch_name": "feat/x",
            "resolved_base_branch": "main",
        }
        hc = HydratedContext.model_validate(data)
        assert hc.resolved_branch_name == "feat/x"
        assert hc.issue is not None
        assert hc.issue.comments[0].id == 1

    def test_version_above_supported_fails(self):
        with pytest.raises(ValidationError) as excinfo:
            HydratedContext(
                version=SUPPORTED_HYDRATED_CONTEXT_VERSION + 1,
                user_prompt="x",
            )
        assert "not supported" in str(excinfo.value).lower()
        assert str(SUPPORTED_HYDRATED_CONTEXT_VERSION + 1) in str(excinfo.value)

    def test_extra_top_level_forbidden(self):
        with pytest.raises(ValidationError):
            HydratedContext.model_validate(
                {
                    "user_prompt": "x",
                    "future_orchestrator_field": True,
                }
            )

    def test_content_trust_none_by_default(self):
        hc = HydratedContext(user_prompt="Fix bug")
        assert hc.content_trust is None

    def test_content_trust_accepted(self):
        hc = HydratedContext(
            user_prompt="Fix bug",
            content_trust={"issue": "untrusted-external", "task_description": "trusted"},
        )
        assert hc.content_trust == {"issue": "untrusted-external", "task_description": "trusted"}

    def test_content_trust_with_memory(self):
        hc = HydratedContext(
            user_prompt="Fix bug",
            content_trust={"memory": "memory", "task_description": "trusted"},
        )
        assert hc.content_trust is not None
        assert hc.content_trust["memory"] == "memory"

    def test_content_trust_round_trip(self):
        data = {
            "version": 1,
            "user_prompt": "Do the thing",
            "sources": ["issue", "memory"],
            "content_trust": {
                "issue": "untrusted-external",
                "memory": "memory",
            },
        }
        hc = HydratedContext.model_validate(data)
        assert hc.content_trust == {"issue": "untrusted-external", "memory": "memory"}

    def test_content_trust_invalid_value_rejected(self):
        with pytest.raises(ValidationError):
            HydratedContext.model_validate(
                {
                    "user_prompt": "Fix bug",
                    "content_trust": {"issue": "invalid-trust-level"},
                }
            )


class TestTaskConfig:
    def test_required_fields(self):
        config = TaskConfig(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        assert config.repo_url == "owner/repo"
        assert config.task_type == "new_task"
        assert config.cedar_policies == []
        assert config.issue is None

    def test_mutable_assignment(self):
        config = TaskConfig(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        config.cedar_policies = ["policy1"]
        assert config.cedar_policies == ["policy1"]

        config.issue = GitHubIssue(title="Bug", number=1)
        assert config.issue.title == "Bug"

        config.base_branch = "develop"
        assert config.base_branch == "develop"

    def test_validate_assignment(self):
        config = TaskConfig(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        # max_turns should be validated as int
        config.max_turns = 50
        assert config.max_turns == 50

    def test_trace_true_with_empty_user_id_raises_at_construction(self):
        """trace=True + user_id='' must fail at construction, not at S3 upload."""
        with pytest.raises(ValidationError, match="trace=True requires a non-empty user_id"):
            TaskConfig(
                repo_url="owner/repo",
                github_token="ghp_test",
                aws_region="us-east-1",
                trace=True,
                # user_id omitted — defaults to ""
            )

    def test_trace_true_with_valid_user_id_constructs_cleanly(self):
        """Happy path: trace=True with a non-empty user_id is accepted."""
        config = TaskConfig(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
            trace=True,
            user_id="cognito-sub-abc-123",
        )
        assert config.trace is True
        assert config.user_id == "cognito-sub-abc-123"

    def test_trace_false_allows_empty_user_id(self):
        """Negative control: local batch runs (trace=False, user_id='') still work."""
        config = TaskConfig(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
            # trace defaults to False; user_id defaults to ""
        )
        assert config.trace is False
        assert config.user_id == ""


class TestRepoSetup:
    def test_construction(self):
        setup = RepoSetup(repo_dir="/workspace/abc", branch="bgagent/abc/fix")
        assert setup.repo_dir == "/workspace/abc"
        assert setup.branch == "bgagent/abc/fix"
        assert setup.notes == []
        assert setup.build_before is True
        assert setup.default_branch == "main"

    def test_frozen(self):
        setup = RepoSetup(repo_dir="/workspace/abc", branch="b")
        with pytest.raises(ValidationError):
            setup.repo_dir = "/other"

    def test_model_dump(self):
        setup = RepoSetup(
            repo_dir="/workspace/abc",
            branch="b",
            notes=["OK"],
            build_before=False,
        )
        d = setup.model_dump()
        assert d["repo_dir"] == "/workspace/abc"
        assert d["build_before"] is False
        assert d["notes"] == ["OK"]


class TestTokenUsage:
    def test_defaults(self):
        u = TokenUsage()
        assert u.input_tokens == 0
        assert u.output_tokens == 0
        assert u.cache_read_input_tokens == 0
        assert u.cache_creation_input_tokens == 0

    def test_construction(self):
        u = TokenUsage(input_tokens=100, output_tokens=50)
        assert u.input_tokens == 100
        assert u.output_tokens == 50

    def test_frozen(self):
        u = TokenUsage(input_tokens=100)
        with pytest.raises(ValidationError):
            u.input_tokens = 200


class TestAgentResult:
    def test_defaults(self):
        r = AgentResult()
        assert r.status == "unknown"
        assert r.turns == 0
        assert r.cost_usd is None
        assert r.usage is None

    def test_progressive_mutation(self):
        r = AgentResult()
        r.status = "success"
        r.turns = 5
        r.cost_usd = 0.05
        r.usage = TokenUsage(input_tokens=1000)
        assert r.status == "success"
        assert r.usage.input_tokens == 1000


class TestTaskResult:
    def test_construction(self):
        r = TaskResult(status="success", task_id="t1")
        assert r.status == "success"
        assert r.task_id == "t1"
        assert r.pr_url is None
        assert r.error is None

    def test_model_dump(self):
        r = TaskResult(
            status="success",
            build_passed=True,
            cost_usd=0.05,
            task_id="t1",
        )
        d = r.model_dump()
        assert d["status"] == "success"
        assert d["build_passed"] is True
        assert d["cost_usd"] == 0.05
