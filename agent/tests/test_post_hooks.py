"""Unit tests for post_hooks screenshot functions."""

from unittest.mock import MagicMock, patch

from post_hooks import _append_screenshots_to_pr, capture_pr_screenshots


class TestCapturePrScreenshots:
    def test_returns_urls_on_success(self):
        with patch("browser.capture_screenshot", return_value="https://s3/img.png"):
            result = capture_pr_screenshots("https://github.com/owner/repo/pull/1", "task-1")
        assert result == ["https://s3/img.png"]

    def test_returns_empty_list_when_pr_url_empty(self):
        result = capture_pr_screenshots("", "task-1")
        assert result == []

    def test_returns_empty_list_when_pr_url_not_github(self):
        result = capture_pr_screenshots("https://gitlab.com/owner/repo/pull/1", "task-1")
        assert result == []

    def test_returns_empty_list_on_exception(self):
        with patch("browser.capture_screenshot", side_effect=RuntimeError("boom")):
            result = capture_pr_screenshots("https://github.com/owner/repo/pull/1", "task-1")
        assert result == []


class TestAppendScreenshotsToPr:
    def _make_mocks(self):
        config = MagicMock()
        config.repo_url = "https://github.com/owner/repo"
        setup = MagicMock()
        setup.branch = "bgagent/task-1"
        setup.repo_dir = "/tmp/repo"
        return config, setup

    def test_appends_screenshots_section(self):
        config, setup = self._make_mocks()
        view_result = MagicMock(returncode=0, stdout="## Summary\n\nSome PR body")
        edit_result = MagicMock(returncode=0, stderr="")
        with patch("post_hooks.subprocess.run", side_effect=[view_result, edit_result]) as mock_run:
            _append_screenshots_to_pr(config, setup, ["https://s3/img1.png"])
        edit_call = mock_run.call_args_list[1]
        body_arg = edit_call[0][0][edit_call[0][0].index("--body") + 1]
        assert "## Screenshots" in body_arg
        assert "![Screenshot 1](https://s3/img1.png)" in body_arg

    def test_replaces_existing_screenshots_section(self):
        config, setup = self._make_mocks()
        existing_body = "## Summary\n\nBody\n\n## Screenshots\n\n![Screenshot 1](https://old.png)"
        view_result = MagicMock(returncode=0, stdout=existing_body)
        edit_result = MagicMock(returncode=0, stderr="")
        with patch("post_hooks.subprocess.run", side_effect=[view_result, edit_result]) as mock_run:
            _append_screenshots_to_pr(config, setup, ["https://s3/new.png"])
        edit_call = mock_run.call_args_list[1]
        body_arg = edit_call[0][0][edit_call[0][0].index("--body") + 1]
        assert "![Screenshot 1](https://s3/new.png)" in body_arg
        assert "https://old.png" not in body_arg
        # Should only have one ## Screenshots section
        assert body_arg.count("## Screenshots") == 1

    def test_handles_gh_pr_view_failure(self):
        config, setup = self._make_mocks()
        view_result = MagicMock(returncode=1, stdout="", stderr="not found")
        with patch("post_hooks.subprocess.run", return_value=view_result):
            # Should not raise
            _append_screenshots_to_pr(config, setup, ["https://s3/img.png"])

    def test_handles_gh_pr_edit_failure(self):
        config, setup = self._make_mocks()
        view_result = MagicMock(returncode=0, stdout="## Summary\n\nBody")
        edit_result = MagicMock(returncode=1, stderr="permission denied")
        with patch("post_hooks.subprocess.run", side_effect=[view_result, edit_result]):
            # Should not raise
            _append_screenshots_to_pr(config, setup, ["https://s3/img.png"])

    def test_does_nothing_when_urls_empty(self):
        config, setup = self._make_mocks()
        with patch("post_hooks.subprocess.run") as mock_run:
            _append_screenshots_to_pr(config, setup, [])
        mock_run.assert_not_called()
