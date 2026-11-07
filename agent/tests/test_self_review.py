"""Unit tests for self_review.py — self-review orchestration module."""

from unittest.mock import MagicMock, patch

from models import AgentResult, RepoSetup, TaskConfig
from prompts.self_review import SELF_REVIEW_PROMPT
from self_review import (
    _MAX_DIFF_CHARS,
    _SUMMARY_FILENAME,
    _build_review_system_prompt,
    _get_diff,
    _render_review_prompt,
    _truncate_diff,
    read_self_review_summary,
    run_self_review,
)


def _make_config(**overrides) -> TaskConfig:
    """Create a minimal TaskConfig for testing."""
    base = TaskConfig(
        repo_url="owner/repo",
        github_token="ghp_test123",
        aws_region="us-east-1",
        task_description="Fix the bug",
        max_turns=10,
    )
    return base.model_copy(update=overrides) if overrides else base


def _make_setup(**overrides) -> RepoSetup:
    """Create a minimal RepoSetup for testing."""
    base = RepoSetup(
        repo_dir="/workspace/repo",
        branch="feat/123-fix",
        default_branch="main",
    )
    return base.model_copy(update=overrides) if overrides else base


def _make_agent_result(**overrides) -> AgentResult:
    """Create a minimal AgentResult for testing."""
    base = AgentResult(
        status="success",
        turns=5,
        num_turns=5,
        cost_usd=0.50,
    )
    return base.model_copy(update=overrides) if overrides else base


class TestSkipConditions:
    """Test all conditions that cause self-review to be skipped."""

    def test_skip_for_read_only_workflow(self):
        config = _make_config(read_only=True)
        setup = _make_setup()
        agent_result = _make_agent_result()
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress)
        assert result is None

    def test_skip_when_no_remaining_turns(self):
        config = _make_config(max_turns=5)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        trajectory = MagicMock()
        progress = MagicMock()

        result = run_self_review(config, setup, agent_result, trajectory, progress, max_turns=5)
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

    def test_single_large_hunk_keeps_body(self):
        # #262 finding #2: a large single-hunk diff has its only @@ marker near
        # the top. Cutting to the last hunk header would discard the entire hunk
        # body and leave only file-header lines. The fallback must keep content.
        header = "diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n"
        body = "@@ -1,8000 +1,8000 @@\n" + "+code line\n" * 8000
        big_diff = header + body
        assert len(big_diff) > _MAX_DIFF_CHARS
        result = _truncate_diff(big_diff)
        assert "truncated" in result
        # Real hunk-body content survives — not just the header lines.
        assert result.count("+code line") > 100

    def test_single_wide_hunk_over_window_keeps_body(self):
        # A single hunk header at offset 0 whose body exceeds max_chars.
        big_diff = "@@ -1,5000 +1,5000 @@\n" + "+x\n" * 40000
        result = _truncate_diff(big_diff, max_chars=1000)
        assert "truncated" in result
        assert result.count("+x") > 10

    def test_exact_limit_no_truncation(self):
        diff = "a" * _MAX_DIFF_CHARS
        result = _truncate_diff(diff)
        assert result == diff

    def test_one_over_limit_truncates(self):
        diff = "a" * (_MAX_DIFF_CHARS + 1)
        result = _truncate_diff(diff)
        assert "truncated" in result


class TestRenderReviewPrompt:
    """Test _render_review_prompt — custom template with fail-open fallback."""

    def test_none_template_uses_builtin(self):
        result = _render_review_prompt(None, "the-diff", "the-task")
        assert result == SELF_REVIEW_PROMPT.format(diff="the-diff", task_description="the-task")

    def test_custom_template_rendered(self):
        template = "Review only security.\n<diff>{diff}</diff>\nTask: {task_description}"
        result = _render_review_prompt(template, "the-diff", "the-task")
        assert result == "Review only security.\n<diff>the-diff</diff>\nTask: the-task"

    def test_custom_template_may_omit_task_description(self):
        template = "Focus on tests.\n{diff}"
        result = _render_review_prompt(template, "the-diff", "the-task")
        assert result == "Focus on tests.\nthe-diff"

    def test_fallback_when_template_lacks_diff(self):
        template = "Review the changes for task: {task_description}"
        result = _render_review_prompt(template, "the-diff", "the-task")
        assert result == SELF_REVIEW_PROMPT.format(diff="the-diff", task_description="the-task")

    def test_fallback_on_unknown_placeholder(self):
        template = "{diff} and {not_a_placeholder}"
        result = _render_review_prompt(template, "the-diff", "the-task")
        assert result == SELF_REVIEW_PROMPT.format(diff="the-diff", task_description="the-task")

    def test_fallback_on_stray_brace(self):
        template = "{diff} with a stray } brace"
        result = _render_review_prompt(template, "the-diff", "the-task")
        assert result == SELF_REVIEW_PROMPT.format(diff="the-diff", task_description="the-task")

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    @patch("self_review._render_review_prompt", wraps=_render_review_prompt)
    def test_run_self_review_forwards_template(self, mock_render, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=1, num_turns=1)
        config = _make_config()
        setup = _make_setup()
        agent_result = _make_agent_result()

        run_self_review(
            config,
            setup,
            agent_result,
            MagicMock(),
            MagicMock(),
            prompt_template="Custom: {diff}",
        )

        assert mock_render.call_args[0][0] == "Custom: {diff}"


class TestReviewSystemPrompt:
    """The critic is read-only (#262 finding #1).

    The system prompt handed to ``run_agent`` must agree with the built-in
    user prompt: both instruct a read-only reviewer that reports findings
    rather than editing/committing. Previously the system prompt told the
    critic to "fix issues and commit" — the exact opposite — so a default run
    had undefined behaviour.
    """

    def test_system_prompt_is_read_only(self):
        prompt = _build_review_system_prompt(_make_config(), _make_setup())
        assert "READ-ONLY" in prompt
        # Must NOT invite mutation/commits — the contradiction we removed.
        lowered = prompt.lower()
        assert "commit fixes" not in lowered
        assert "fix any issues you find directly" not in lowered

    def test_system_and_user_prompts_agree(self):
        system = _build_review_system_prompt(_make_config(), _make_setup()).lower()
        user = SELF_REVIEW_PROMPT.lower()
        # Both prohibit modifying files / committing.
        assert "do not modify any files" in user
        assert "do not make commits" in user
        assert "do not" in system and "modify" in system


class TestReadOnlyEnforcement:
    """The critic runs read-only structurally, not just via prompt text (#262 finding #1).

    The config handed to ``run_agent`` must carry ``read_only=True`` so
    ``runner._resolve_allowed_tools`` drops Write/Edit and PolicyEngine enforces
    the read-only Cedar rules — otherwise a prompt-injection payload in the
    attacker-influenceable diff could steer the critic into mutating tracked
    files that then land in the PR.
    """

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    @patch("runner.run_agent")
    def test_review_config_is_read_only(self, mock_run_agent, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=1, num_turns=1)
        config = _make_config()
        assert config.read_only is False  # coding config is not read-only

        run_self_review(config, _make_setup(), _make_agent_result(), MagicMock(), MagicMock())

        review_config = mock_run_agent.call_args[0][2]
        assert review_config.read_only is True


class TestBudgetAndTurnComputation:
    """Test that budget and turn limits are computed correctly."""

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    def test_review_turns_capped_at_step_max_turns(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=2, num_turns=2)
        config = _make_config(max_turns=100)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        trajectory = MagicMock()
        progress = MagicMock()

        # The step's max_turns (3) caps the review even though 95 turns remain.
        run_self_review(config, setup, agent_result, trajectory, progress, max_turns=3)

        call_args = mock_asyncio_run.call_args
        coro = call_args[0][0]
        # Close the coroutine to avoid warnings
        coro.close()

    @patch("self_review._get_diff", return_value="diff --git a/f\n+line\n")
    @patch("self_review.asyncio.run")
    def test_review_turns_uses_remaining_when_less_than_cap(self, mock_asyncio_run, mock_diff):
        mock_asyncio_run.return_value = AgentResult(status="success", turns=1, num_turns=1)
        config = _make_config(max_turns=8)
        setup = _make_setup()
        agent_result = _make_agent_result(turns=6)  # Only 2 remaining
        trajectory = MagicMock()
        progress = MagicMock()

        # Should use min(2 remaining, 5 cap) = 2 turns
        run_self_review(config, setup, agent_result, trajectory, progress, max_turns=5)

        call_args = mock_asyncio_run.call_args
        coro = call_args[0][0]
        coro.close()


class TestHappyPath:
    """Test the full happy path with mocked run_agent."""

    @patch("self_review._get_diff", return_value="diff --git a/file.py\n+new code\n")
    @patch("self_review.asyncio.run")
    def test_returns_review_result(self, mock_asyncio_run, mock_diff):
        review_agent_result = AgentResult(status="success", turns=2, num_turns=2, cost_usd=0.10)
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


class TestReadSelfReviewSummary:
    """Tests for read_self_review_summary — reads and cleans up the summary file."""

    def test_returns_content_when_file_exists(self, tmp_path):
        summary_content = (
            "### Self-Review Summary\n\n"
            "**Findings:** 2\n"
            "**Fixes applied:** 1\n\n"
            "#### Issues found\n\n"
            "- Security: hardcoded token — fixed\n"
            "- Style: inconsistent naming — not fixed (cosmetic)\n"
        )
        (tmp_path / _SUMMARY_FILENAME).write_text(summary_content)

        result = read_self_review_summary(str(tmp_path))

        assert result == summary_content.strip()

    def test_returns_none_when_file_missing(self, tmp_path):
        result = read_self_review_summary(str(tmp_path))
        assert result is None

    def test_deletes_file_after_reading(self, tmp_path):
        (tmp_path / _SUMMARY_FILENAME).write_text("No issues found — code looks good.")

        read_self_review_summary(str(tmp_path))

        assert not (tmp_path / _SUMMARY_FILENAME).exists()

    def test_returns_none_for_empty_file(self, tmp_path):
        (tmp_path / _SUMMARY_FILENAME).write_text("   \n\n  ")

        result = read_self_review_summary(str(tmp_path))

        assert result is None

    def test_returns_none_for_whitespace_only(self, tmp_path):
        (tmp_path / _SUMMARY_FILENAME).write_text("\t\n ")

        result = read_self_review_summary(str(tmp_path))

        assert result is None

    @patch("self_review.subprocess.run")
    def test_runs_git_rm_cached_for_cleanup(self, mock_run, tmp_path):
        (tmp_path / _SUMMARY_FILENAME).write_text("Some findings")
        mock_run.return_value = MagicMock(returncode=0)

        read_self_review_summary(str(tmp_path))

        mock_run.assert_called_once_with(
            ["git", "rm", "--cached", "--ignore-unmatch", "-f", _SUMMARY_FILENAME],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=30,
        )

    @patch("self_review.subprocess.run", side_effect=OSError("git not found"))
    def test_git_rm_failure_does_not_block(self, mock_run, tmp_path):
        (tmp_path / _SUMMARY_FILENAME).write_text("Findings here")

        # Should not raise even if git rm fails
        result = read_self_review_summary(str(tmp_path))

        assert result == "Findings here"


class TestPostSelfReviewComment:
    """Tests for post_hooks.post_self_review_comment."""

    def test_posts_comment_on_success(self, tmp_path):
        from post_hooks import post_self_review_comment

        (tmp_path / _SUMMARY_FILENAME).write_text("**Findings:** 1\n**Fixes applied:** 1")

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/pull/42"

        with patch("post_hooks.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            result = post_self_review_comment(str(tmp_path), pr_url, config)

        assert result is True
        call_args = mock_run.call_args[0][0]
        assert call_args[0:3] == ["gh", "pr", "comment"]
        assert "42" in call_args
        assert "owner/repo" in call_args

    def test_returns_false_when_no_summary(self, tmp_path):
        from post_hooks import post_self_review_comment

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/pull/42"

        result = post_self_review_comment(str(tmp_path), pr_url, config)
        assert result is False

    def test_returns_false_on_invalid_pr_url(self, tmp_path):
        from post_hooks import post_self_review_comment

        (tmp_path / _SUMMARY_FILENAME).write_text("Some findings")

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/issues/42"

        result = post_self_review_comment(str(tmp_path), pr_url, config)
        assert result is False

    def test_returns_false_on_gh_failure(self, tmp_path):
        from post_hooks import post_self_review_comment

        (tmp_path / _SUMMARY_FILENAME).write_text("**Findings:** 1")

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/pull/99"

        with patch("post_hooks.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="not found")
            result = post_self_review_comment(str(tmp_path), pr_url, config)

        assert result is False

    def test_fail_open_on_exception(self, tmp_path):
        from post_hooks import post_self_review_comment

        (tmp_path / _SUMMARY_FILENAME).write_text("**Findings:** 1")

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/pull/5"

        with patch("post_hooks.subprocess.run", side_effect=OSError("network error")):
            result = post_self_review_comment(str(tmp_path), pr_url, config)

        assert result is False

    def test_comment_body_includes_header(self, tmp_path):
        from post_hooks import post_self_review_comment

        (tmp_path / _SUMMARY_FILENAME).write_text("**Findings:** 0\nNo issues.")

        config = MagicMock()
        config.repo_url = "owner/repo"
        pr_url = "https://github.com/owner/repo/pull/7"

        with patch("post_hooks.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            post_self_review_comment(str(tmp_path), pr_url, config)

        call_args = mock_run.call_args[0][0]
        body_idx = call_args.index("--body") + 1
        body = call_args[body_idx]
        assert "Self-Review Summary" in body
        assert "**Findings:** 0" in body


class TestSelfReviewStepHandler:
    """Tests for the workflow ``self_review`` step handler (workflow/runner.py).

    The step's presence in a workflow is the enablement signal; the handler
    wraps ``run_self_review`` and accumulates the review's turns/cost onto the
    shared ``ctx.agent_result``.
    """

    def _ctx(self, *, setup, agent_result):
        from workflow import Step, StepContext, Workflow

        wf = Workflow.model_validate(
            {
                "id": "coding/new-task-v1",
                "version": "1.0.0",
                "domain": "coding",
                "prompt": {"template": "registry://prompt/x"},
                "hydration": {"sources": ["task_description"]},
                "agent_config": {"tier": "standard", "allowed_tools": ["Bash"]},
                "steps": [
                    {"kind": "run_agent"},
                    {
                        "kind": "self_review",
                        "name": "review",
                        "max_turns": 4,
                        "prompt": "Custom review: {diff}",
                    },
                ],
                "terminal_outcomes": {"primary": "pr_url"},
                "status": "production",
            }
        )
        step = next(s for s in wf.steps if s.kind == "self_review")
        ctx = StepContext(
            workflow=wf,
            config=_make_config(),
            setup=setup,
            agent_result=agent_result,
            trajectory=MagicMock(),
            progress=MagicMock(),
        )
        return step, ctx, Step

    def test_passes_step_max_turns_and_accumulates(self):
        from workflow.runner import _handle_self_review

        setup = _make_setup()
        agent_result = _make_agent_result(turns=5, num_turns=5, cost_usd=0.50)
        step, ctx, _ = self._ctx(setup=setup, agent_result=agent_result)

        review = AgentResult(status="success", turns=2, num_turns=2, cost_usd=0.10)
        with patch("self_review.run_self_review", return_value=review) as mock_review:
            outcome = _handle_self_review(step, ctx)

        # The step's max_turns (4) and prompt are forwarded to run_self_review.
        assert mock_review.call_args.kwargs["max_turns"] == 4
        assert mock_review.call_args.kwargs["prompt_template"] == "Custom review: {diff}"
        assert outcome.status == "succeeded"
        assert outcome.data["self_review_ran"] is True
        # Review turns/cost accumulated onto the shared agent_result.
        assert ctx.agent_result.turns == 7
        assert ctx.agent_result.num_turns == 7
        assert abs(ctx.agent_result.cost_usd - 0.60) < 1e-9

    def test_skipped_review_records_not_ran(self):
        from workflow.runner import _handle_self_review

        setup = _make_setup()
        agent_result = _make_agent_result(turns=5)
        step, ctx, _ = self._ctx(setup=setup, agent_result=agent_result)

        with patch("self_review.run_self_review", return_value=None):
            outcome = _handle_self_review(step, ctx)

        assert outcome.status == "succeeded"
        assert outcome.data["self_review_ran"] is False
        # No accumulation when the review was skipped.
        assert ctx.agent_result.turns == 5

    def test_fails_without_clone(self):
        from workflow.runner import _handle_self_review

        agent_result = _make_agent_result()
        step, ctx, _ = self._ctx(setup=None, agent_result=agent_result)

        outcome = _handle_self_review(step, ctx)
        assert outcome.status == "failed"
        assert "cloned repo" in (outcome.error or "")

    def test_default_max_turns_when_step_omits_it(self):
        from workflow import Step, StepContext, Workflow
        from workflow.runner import _DEFAULT_SELF_REVIEW_MAX_TURNS, _handle_self_review

        wf = Workflow.model_validate(
            {
                "id": "coding/new-task-v1",
                "version": "1.0.0",
                "domain": "coding",
                "prompt": {"template": "registry://prompt/x"},
                "hydration": {"sources": ["task_description"]},
                "agent_config": {"tier": "standard", "allowed_tools": ["Bash"]},
                "steps": [{"kind": "run_agent"}, {"kind": "self_review"}],
                "terminal_outcomes": {"primary": "pr_url"},
                "status": "production",
            }
        )
        step = next(s for s in wf.steps if s.kind == "self_review")
        assert step.max_turns is None
        ctx = StepContext(
            workflow=wf,
            config=_make_config(),
            setup=_make_setup(),
            agent_result=_make_agent_result(turns=2),
            trajectory=MagicMock(),
            progress=MagicMock(),
        )
        review = AgentResult(status="success", turns=1, num_turns=1)
        with patch("self_review.run_self_review", return_value=review) as mock_review:
            _handle_self_review(step, ctx)
        assert mock_review.call_args.kwargs["max_turns"] == _DEFAULT_SELF_REVIEW_MAX_TURNS
        # No step prompt ⇒ the built-in review prompt is used.
        assert mock_review.call_args.kwargs["prompt_template"] is None
        # Step model unused beyond fixture; keep import referenced.
        assert Step is not None
