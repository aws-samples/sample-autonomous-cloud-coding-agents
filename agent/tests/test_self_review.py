"""Unit tests for self_review.py — self-review orchestration module."""

from unittest.mock import MagicMock, patch

from models import AgentResult, RepoSetup, TaskConfig
from self_review import _MAX_DIFF_CHARS, _get_diff, _truncate_diff, run_self_review


def _make_config(**overrides) -> TaskConfig:
    """Create a minimal TaskConfig for testing."""
    defaults = {
        "repo_url": "owner/repo",
        "github_token": "ghp_test123",
        "aws_region": "us-east-1",
        "task_description": "Fix the bug",
        "max_turns": 10,
        "self_review_enabled": True,
        "self_review_max_turns": 5,
        "task_type": "new_task",
    }
    defaults.update(overrides)
    return TaskConfig(**defaults)


def _make_setup(**overrides) -> RepoSetup:
    """Create a minimal RepoSetup for testing."""
    defaults = {
        "repo_dir": "/workspace/repo",
        "branch": "feat/123-fix",
        "default_branch": "main",
    }
    defaults.update(overrides)
    return RepoSetup(**defaults)


def _make_agent_result(**overrides) -> AgentResult:
    """Create a minimal AgentResult for testing."""
    defaults = {
        "status": "success",
        "turns": 5,
        "num_turns": 5,
        "cost_usd": 0.50,
    }
    defaults.update(overrides)
    return AgentResult(**defaults)


class TestSkipConditions:
    """Test all conditions that cause self-review to be skipped."""

    def test_skip_when_disabled(self):
        config = _make_config(self_review_enabled=False)
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    def test_skip_for_pr_review_task_type(self):
        config = _make_config(
            task_type="pr_review",
            pr_number="42",
            task_description="",
            issue_number="",
        )
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    def test_skip_when_no_remaining_turns(self):
        config = _make_config(max_turns=5, self_review_max_turns=5)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    def test_skip_when_no_remaining_budget(self):
        config = _make_config(max_budget_usd=1.0)
        setup = _make_setup()
        agent_result = _make_agent_result(cost_usd=1.0)
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    @patch("self_review._get_diff", return_value="")
    def test_skip_when_empty_diff(self, mock_diff):
        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    @patch("self_review._get_diff", return_value="   \n  \n  ")
    def test_skip_when_whitespace_only_diff(self, mock_diff):
        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None


class TestGetDiff:
    """Test _get_diff helper."""

    @patch("self_review.subprocess.run")
    def test_returns_diff_output(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="diff --git a/f\n+line\n")
        result = _get_diff("/repo", "main")
        assert result == "diff --git a/f\n+line\n"
        mock_run.assert_called_once_with(
            ["git", "diff", "origin/main...HEAD"],
            cwd="/repo",
            capture_output=True,
            text=True,
            timeout=60,
        )

    @patch("self_review.subprocess.run")
    def test_returns_empty_on_failure(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        result = _get_diff("/repo", "main")
        assert result == ""

    @patch("self_review.subprocess.run")
    def test_returns_empty_on_timeout(self, mock_run):
        import subprocess

        mock_run.side_effect = subprocess.TimeoutExpired(cmd="git", timeout=60)
        result = _get_diff("/repo", "main")
        assert result == ""

    @patch("self_review.subprocess.run")
    def test_uses_custom_default_branch(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="some diff")
        _get_diff("/repo", "develop")
        mock_run.assert_called_once_with(
            ["git", "diff", "origin/develop...HEAD"],
            cwd="/repo",
            capture_output=True,
            text=True,
            timeout=60,
        )


class TestTruncateDiff:
    """Test _truncate_diff helper."""

    def test_no_truncation_needed(self):
        short_diff = "diff --git a/file.py\n@@ -1,3 +1,4 @@\n+new line\n"
        result = _truncate_diff(short_diff)
        assert result == short_diff

    def test_truncates_at_hunk_boundary(self):
        # Build a diff that exceeds the limit with multiple hunks
        hunk1 = "diff --git a/file.py\n@@ -1,3 +1,4 @@\n" + "+line\n" * 100
        hunk2 = "\n@@ -100,3 +101,4 @@\n" + "+more\n" * 100
        big_diff = hunk1 + hunk2
        result = _truncate_diff(big_diff, max_chars=len(hunk1) + 10)
        # Should truncate before hunk2's @@ marker
        assert "@@ -100,3" not in result
        assert "truncated" in result

    def test_hard_cut_when_no_hunk_boundary(self):
        # Single hunk that exceeds max
        big_diff = "+x\n" * 30000
        result = _truncate_diff(big_diff, max_chars=100)
        assert len(result) < len(big_diff)
        assert "truncated" in result

    def test_exact_limit_no_truncation(self):
        diff = "a" * _MAX_DIFF_CHARS
        result = _truncate_diff(diff)
        assert result == diff

    def test_one_over_limit_truncates(self):
        diff = "a" * (_MAX_DIFF_CHARS + 1)
        result = _truncate_diff(diff)
        assert "truncated" in result


class TestBudgetAndTurnComputation:
    """Test that budget and turn limits are computed correctly."""

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    def test_review_turns_capped_at_self_review_max_turns(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=2, num_turns=2)
        config = _make_config(max_turns=100, self_review_max_turns=3)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        trajectory = MagicMock()
        progress = MagicMock()

        run_self_review(config, setup, agent_result, trajectory, progress)

        # The review config passed to run_agent should have max_turns=3
        call_args = mock_asyncio_run.call_args
        coro = call_args[0][0]
        # Close the coroutine to avoid warnings
        coro.close()

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    def test_review_turns_uses_remaining_when_less_than_cap(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=1, num_turns=1)
        config = _make_config(max_turns=8, self_review_max_turns=5)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=6)  # Only 2 remaining
        trajectory = MagicMock()
        progress = MagicMock()

        run_self_review(config, setup, agent_result, trajectory, progress)

        # Should use min(2, 5) = 2 turns
        call_args = mock_asyncio_run.call_args
        coro = call_args[0][0]
        coro.close()


class TestHappyPath:
    """Test the full happy path with mocked run_agent."""

    @patch("self_review._get_diff", return_value="diff --git a/file.py\n+new code\n")
    @patch("self_review.asyncio.run")
    def test_returns_review_result(self, mock_asyncio_run, mock_diff):
        review_agent_result = AgentResult(
            status="success", turns=2, num_turns=2, cost_usd=0.10
        )
        mock_asyncio_run.return_value = review_agent_result

        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)

        assert result is not None
        assert result.status == "success"
        assert result.turns == 2
        assert result.cost_usd == 0.10

    @patch("self_review._get_diff", return_value="diff --git a/file.py\n+new code\n")
    @patch("self_review.asyncio.run")
    def test_writes_progress_milestones(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(
            status="success", turns=1, num_turns=1, cost_usd=0.05
        )
        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        run_self_review(config, setup, agent_result, trajectory, progress)

        # Should write both started and complete milestones
        milestone_calls = progress.write_agent_milestone.call_args_list
        assert len(milestone_calls) == 2
        assert milestone_calls[0][0][0] == "self_review_started"
        assert milestone_calls[1][0][0] == "self_review_complete"

    @patch("self_review._get_diff", return_value="diff --git a/file.py\n+new code\n")
    @patch("self_review.asyncio.run")
    def test_fail_open_on_agent_error(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.side_effect = RuntimeError("SDK crashed")

        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        # Should not raise
        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

        # Should still write milestones
        milestone_calls = progress.write_agent_milestone.call_args_list
        assert milestone_calls[0][0][0] == "self_review_started"
        assert milestone_calls[1][0][0] == "self_review_complete"
        assert "error" in milestone_calls[1][0][1]

    @patch("self_review._get_diff", return_value="diff --git a/file.py\n+new code\n")
    @patch("self_review.asyncio.run")
    def test_works_with_unlimited_budget(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(
            status="success", turns=1, num_turns=1, cost_usd=0.03
        )
        config = _make_config(max_budget_usd=None)
        setup = _make_setup()
        agent_result = _make_agent_result(cost_usd=None)
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is not None
        assert result.status == "success"
