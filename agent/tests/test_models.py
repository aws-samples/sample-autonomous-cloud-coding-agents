"""Unit tests for models.py — TaskType enum and Pydantic models."""

import pytest
from pydantic import ValidationError

from models import (
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
        c = IssueComment(author="alice", body="Looks good!")
        assert c.author == "alice"
        assert c.body == "Looks good!"

    def test_frozen(self):
        c = IssueComment(author="alice", body="text")
        with pytest.raises(ValidationError):
            c.author = "bob"

    def test_model_dump(self):
        c = IssueComment(author="alice", body="text")
        d = c.model_dump()
        assert d == {"author": "alice", "body": "text"}


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
            comments=[IssueComment(author="bob", body="noted")],
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
        assert hc.user_prompt == "Fix the bug"
        assert hc.issue is None
        assert hc.resolved_base_branch is None
        assert hc.truncated is False
        assert hc.memory_context is None

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
            "user_prompt": "Fix bug",
            "issue": {"title": "Bug", "number": 42, "body": "", "comments": []},
            "truncated": True,
        }
        hc = HydratedContext.model_validate(data)
        assert hc.user_prompt == "Fix bug"
        assert hc.issue is not None and hc.issue.number == 42
        assert hc.truncated is True


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
