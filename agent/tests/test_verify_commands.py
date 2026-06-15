"""Tests for the configurable build/lint verification command (#1 build-gate fix)."""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import post_hooks
from post_hooks import (
    DEFAULT_BUILD_COMMAND,
    DEFAULT_LINT_COMMAND,
    is_verify_command_inert,
    resolve_verify_argv,
    verify_build,
    verify_lint,
)


class TestResolveVerifyArgv:
    def test_empty_falls_back_to_default(self):
        assert resolve_verify_argv("", DEFAULT_BUILD_COMMAND) == ["mise", "run", "build"]
        assert resolve_verify_argv("   ", DEFAULT_LINT_COMMAND) == ["mise", "run", "lint"]

    def test_none_falls_back_to_default(self):
        assert resolve_verify_argv(None, DEFAULT_BUILD_COMMAND) == ["mise", "run", "build"]

    def test_configured_command_splits_to_argv(self):
        assert resolve_verify_argv("npm run build", "") == ["npm", "run", "build"]
        assert resolve_verify_argv("gradle build", "") == ["gradle", "build"]

    def test_quoted_args_preserved(self):
        assert resolve_verify_argv('make "target with spaces"', DEFAULT_BUILD_COMMAND) == [
            "make", "target with spaces",
        ]


class TestVerifyBuildHonorsCommand:
    def _capture_argv(self, monkeypatch):
        seen = {}

        def fake_run_cmd(argv, **kw):
            seen["argv"] = argv
            return SimpleNamespace(returncode=0)

        monkeypatch.setattr(post_hooks, "run_cmd", fake_run_cmd)
        return seen

    def test_build_defaults_to_mise(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        assert verify_build("/repo") is True
        assert seen["argv"] == ["mise", "run", "build"]

    def test_build_uses_configured_command(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        assert verify_build("/repo", "npm run build") is True
        assert seen["argv"] == ["npm", "run", "build"]

    def test_lint_uses_configured_command(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        assert verify_lint("/repo", "ruff check .") is True
        assert seen["argv"] == ["ruff", "check", "."]

    def test_nonzero_returncode_is_failure(self, monkeypatch):
        monkeypatch.setattr(post_hooks, "run_cmd", lambda argv, **kw: SimpleNamespace(returncode=1))
        assert verify_build("/repo", "npm run build") is False

    def test_timeout_is_failure(self, monkeypatch):
        def boom(argv, **kw):
            raise subprocess.TimeoutExpired(cmd=argv, timeout=1)

        monkeypatch.setattr(post_hooks, "run_cmd", boom)
        assert verify_build("/repo", "npm run build") is False


class TestIsVerifyCommandInert:
    def test_mise_no_tasks_defined_is_inert(self):
        assert is_verify_command_inert(1, "mise ERROR no tasks defined in /repo") is True

    def test_command_not_found_exit_127_is_inert(self):
        assert is_verify_command_inert(127, "gradle: command not found") is True

    def test_no_task_named_is_inert(self):
        assert is_verify_command_inert(1, "mise ERROR: no task named 'build'") is True

    def test_genuine_build_failure_is_NOT_inert(self):
        # Real compiler/test output, exited non-zero → meaningful gating signal.
        assert is_verify_command_inert(2, "TypeError: cannot read property 'x'\n1 test failed") is False

    def test_clean_exit_is_not_inert(self):
        assert is_verify_command_inert(0, "") is False
