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
            "make",
            "target with spaces",
        ]

    def test_chained_command_runs_through_a_shell(self):
        # #72: a && / | / ; chain must run via `bash -lc` so the WHOLE chain
        # executes. Previously shlex-split into one `npm` call with `&&`/`npm`/…
        # as bogus args — `npm ci` ran, ignored the rest, exited 0, and a broken
        # lint/test in the chain NEVER ran (false "build OK").
        assert resolve_verify_argv("npm ci && npm run lint && npm test", "") == [
            "bash",
            "-lc",
            "npm ci && npm run lint && npm test",
        ]

    def test_other_shell_operators_also_wrap(self):
        for cmd in ("eslint . | tee out.txt", "make build; make test", "tsc > /dev/null"):
            argv = resolve_verify_argv(cmd, "")
            assert argv[:2] == ["bash", "-lc"], cmd
            assert argv[2] == cmd

    def test_plain_command_still_direct_argv(self):
        # No operators → still a direct exec (no shell wrapper).
        assert resolve_verify_argv("npm run build", "") == ["npm", "run", "build"]

    def test_env_assignment_prefix_wraps_in_shell(self):
        # ABCA-662 follow-up: a leading VAR=value env-prefix is shell syntax. Exec'd
        # directly, shlex-split makes the FIRST token the "program" (VAR=value) →
        # FileNotFoundError, crashing the task before the build runs. Must route
        # through bash -lc so the assignment takes effect. (Live-caught: a
        # lint_command of `MISE_EXPERIMENTAL=1 mise //cdk:eslint` crashed at exit 1.)
        assert resolve_verify_argv("MISE_EXPERIMENTAL=1 mise //cdk:eslint", "") == [
            "bash",
            "-lc",
            "MISE_EXPERIMENTAL=1 mise //cdk:eslint",
        ]

    def test_multiple_env_assignments_wrap(self):
        cmd = "FOO=1 BAR=2 make build"
        assert resolve_verify_argv(cmd, "") == ["bash", "-lc", cmd]

    def test_equals_not_at_start_is_not_an_env_prefix(self):
        # An `=` inside a later arg (not a leading VAR= token) is NOT an env prefix
        # — a plain command with such an arg still execs directly.
        assert resolve_verify_argv("npm run build --define=X=1", "") == [
            "npm",
            "run",
            "build",
            "--define=X=1",
        ]


class TestVerifyBuildHonorsCommand:
    def _capture_argv(self, monkeypatch):
        seen = {}

        def fake_run_cmd(argv, **kw):
            seen["argv"] = argv
            seen["kw"] = kw
            return SimpleNamespace(returncode=0)

        monkeypatch.setattr(post_hooks, "run_cmd", fake_run_cmd)
        return seen

    def test_build_defaults_to_mise(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        outcome = verify_build("/repo")
        assert outcome.passed is True
        assert outcome.timed_out is False
        assert seen["argv"] == ["mise", "run", "build"]

    def test_build_uses_configured_command(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        assert verify_build("/repo", "npm run build").passed is True
        assert seen["argv"] == ["npm", "run", "build"]

    def test_verify_passes_the_build_timeout(self, monkeypatch):
        # The verify subprocess must run under BUILD_VERIFY_TIMEOUT_S (not
        # run_cmd's 600s default) so a real CI-parity build can finish.
        seen = self._capture_argv(monkeypatch)
        verify_build("/repo", "mise run build")
        assert seen["kw"].get("timeout") == post_hooks.BUILD_VERIFY_TIMEOUT_S

    def test_lint_uses_configured_command(self, monkeypatch):
        seen = self._capture_argv(monkeypatch)
        assert verify_lint("/repo", "ruff check .").passed is True
        assert seen["argv"] == ["ruff", "check", "."]

    def test_nonzero_returncode_is_failure_not_timeout(self, monkeypatch):
        monkeypatch.setattr(post_hooks, "run_cmd", lambda argv, **kw: SimpleNamespace(returncode=1))
        outcome = verify_build("/repo", "npm run build")
        assert outcome.passed is False
        assert outcome.timed_out is False  # ran-and-failed, not a timeout

    def test_timeout_is_not_passed_AND_flagged_timed_out(self, monkeypatch):
        # The key distinction (user 2026-06-29): a timeout must read as "timed
        # out", not a generic build failure. passed=False (a build that never
        # finished isn't green) but timed_out=True so the reason differs.
        def boom(argv, **kw):
            raise subprocess.TimeoutExpired(cmd=argv, timeout=1)

        monkeypatch.setattr(post_hooks, "run_cmd", boom)
        outcome = verify_build("/repo", "npm run build")
        assert outcome.passed is False
        assert outcome.timed_out is True

    def test_exit_127_is_INERT_not_a_build_failure(self, monkeypatch):
        # K8: command-not-found (e.g. yarn missing) means the gate couldn't run —
        # a CONFIG problem, not the agent's code. Must flag inert, not a failure,
        # so the platform doesn't emit a false "build failed".
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            lambda argv, **kw: SimpleNamespace(returncode=127, stderr="yarn: command not found"),
        )
        outcome = verify_build("/repo", "yarn install && yarn build")
        assert outcome.passed is False
        assert outcome.inert is True
        assert outcome.timed_out is False

    def test_no_such_mise_task_is_INERT(self, monkeypatch):
        no_task = "mise ERROR no task named 'build'"
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            lambda argv, **kw: SimpleNamespace(returncode=1, stderr=no_task),
        )
        assert verify_build("/repo", "mise run build").inert is True

    def test_genuine_nonzero_is_a_failure_NOT_inert(self, monkeypatch):
        # A real compiler/test failure (exit 1/2 with real output) must NOT be
        # mislabeled inert — that would hide a genuine red build.
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            lambda argv, **kw: SimpleNamespace(returncode=2, stderr="tsc: 3 type errors"),
        )
        outcome = verify_build("/repo", "mise //cdk:compile")
        assert outcome.passed is False
        assert outcome.inert is False

    def test_ENOSPC_is_INFRA_failure_not_a_build_failure(self, monkeypatch):
        # ABCA-659 #2: disk-full mid-build means the build couldn't COMPLETE on
        # this host — an infra fault, not broken code. Must flag infra_failed
        # (not a plain failure, not inert) so the platform reports "retry / needs
        # capacity", not "build/tests failed".
        enospc = "yarn error ENOSPC: no space left on device, write"
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            lambda argv, **kw: SimpleNamespace(returncode=1, stderr=enospc),
        )
        outcome = verify_build("/repo", "mise run build")
        assert outcome.passed is False
        assert outcome.infra_failed is True
        assert outcome.inert is False  # NOT a config problem

    def test_OOM_sigkill_137_is_INFRA_failure(self, monkeypatch):
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            lambda argv, **kw: SimpleNamespace(returncode=137, stderr="Killed"),
        )
        outcome = verify_build("/repo", "mise run build")
        assert outcome.passed is False
        assert outcome.infra_failed is True


class TestIsVerifyCommandInert:
    def test_mise_no_tasks_defined_is_inert(self):
        assert is_verify_command_inert(1, "mise ERROR no tasks defined in /repo") is True

    def test_command_not_found_exit_127_is_inert(self):
        assert is_verify_command_inert(127, "gradle: command not found") is True

    def test_no_task_named_is_inert(self):
        assert is_verify_command_inert(1, "mise ERROR: no task named 'build'") is True

    def test_genuine_build_failure_is_NOT_inert(self):
        # Real compiler/test output, exited non-zero → meaningful gating signal.
        real_failure = "TypeError: cannot read property 'x'\n1 test failed"
        assert is_verify_command_inert(2, real_failure) is False

    def test_clean_exit_is_not_inert(self):
        assert is_verify_command_inert(0, "") is False
