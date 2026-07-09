"""Unit tests for shell.py — slugify, redact_secrets, truncate."""

from types import SimpleNamespace
from unittest.mock import patch

from shell import (
    is_transient_cmd_failure,
    redact_secrets,
    run_cmd,
    run_cmd_with_backoff,
    slugify,
    truncate,
)


class TestSlugify:
    def test_basic(self):
        assert slugify("Fix the login bug") == "fix-the-login-bug"

    def test_special_chars(self):
        assert slugify("Add feature: OAuth2.0!") == "add-feature-oauth20"

    def test_max_len(self):
        result = slugify("a very long task description indeed", max_len=10)
        assert len(result) <= 10
        assert not result.endswith("-")

    def test_empty(self):
        assert slugify("") == "task"

    def test_only_special_chars(self):
        assert slugify("!!!") == "task"


class TestRedactSecrets:
    def test_ghp_token(self):
        assert "***" in redact_secrets("ghp_abc123XYZ")
        assert "abc123XYZ" not in redact_secrets("ghp_abc123XYZ")

    def test_github_pat_token(self):
        result = redact_secrets("github_pat_abcDEF123")
        assert "abcDEF123" not in result

    def test_x_access_token(self):
        result = redact_secrets("https://x-access-token:mysecret@github.com/foo/bar")
        assert "mysecret" not in result

    def test_no_secrets(self):
        text = "nothing secret here"
        assert redact_secrets(text) == text


class TestTruncate:
    def test_short_text(self):
        assert truncate("hello") == "hello"

    def test_long_text(self):
        long = "a" * 300
        result = truncate(long, max_len=100)
        assert len(result) == 103  # 100 + "..."
        assert result.endswith("...")

    def test_empty(self):
        assert truncate("") == ""

    def test_newlines_replaced(self):
        assert truncate("line1\nline2") == "line1 line2"


class TestIsTransientCmdFailure:
    def test_dns_and_5xx_are_transient(self):
        assert is_transient_cmd_failure("fatal: Could not resolve host: github.com")
        assert is_transient_cmd_failure("The requested URL returned error: 503")
        assert is_transient_cmd_failure("npm ERR! 429 Too Many Requests")
        assert is_transient_cmd_failure("getaddrinfo EAI_AGAIN registry.npmjs.org")

    def test_permanent_failures_are_not_transient(self):
        # Auth/not-found: re-running won't help — must NOT retry.
        assert not is_transient_cmd_failure("remote: Permission denied")
        assert not is_transient_cmd_failure(
            "Could not resolve to a Repository with the name 'owner/repo'"
        )
        assert not is_transient_cmd_failure("")


class TestRunCmdWithBackoff:
    def _proc(self, rc, stderr=""):
        return SimpleNamespace(returncode=rc, stdout="", stderr=stderr)

    def _counting(self, proc, counter):
        """A run_cmd side_effect that records each call and returns *proc*."""

        def _side_effect(*_a, **_k):
            counter.append(1)
            return proc

        return _side_effect

    def test_returns_immediately_on_success(self):
        calls = []
        with patch("shell.run_cmd", side_effect=self._counting(self._proc(0), calls)):
            result = run_cmd_with_backoff(["git", "clone"], "clone", sleep=lambda _: None)
        assert result.returncode == 0
        assert len(calls) == 1  # no retries

    def test_retries_then_succeeds_on_transient(self):
        # Host-less transient (name-resolution blip, no nameable endpoint) →
        # retryable. A host-NAMING failure bails instead — see
        # test_does_not_retry_when_stderr_names_a_host.
        seq = [self._proc(1, "Temporary failure in name resolution"), self._proc(0)]
        retries = []
        with patch("shell.run_cmd", side_effect=lambda *a, **k: seq.pop(0)):
            result = run_cmd_with_backoff(
                ["git", "clone"],
                "clone",
                on_retry=lambda *a: retries.append(a),
                sleep=lambda _: None,
            )
        assert result.returncode == 0
        assert len(retries) == 1  # one retry fired an audit callback

    def test_does_not_retry_when_stderr_names_a_host(self):
        # #251 review fix: "Could not resolve host: <host>" names a firewalled /
        # non-existent endpoint — retrying never helps. Backoff must bail on the
        # first failure (no retry, no dependency_unreachable audit event) so
        # _fail_setup_command can reclassify it to non-retryable egress_denied.
        attempts = []
        proc = self._proc(1, "fatal: unable to access: Could not resolve host: github.com")
        retries = []
        with patch("shell.run_cmd", side_effect=self._counting(proc, attempts)):
            result = run_cmd_with_backoff(
                ["git", "clone"],
                "clone",
                max_attempts=3,
                on_retry=lambda *a: retries.append(a),
                sleep=lambda _: None,
            )
        assert result.returncode == 1
        assert len(attempts) == 1  # bailed on first failure — no retry
        assert retries == []  # no misleading dependency_unreachable audit event

    def test_tcp_connect_timeout_to_named_host_still_retries(self):
        # #251 review: "Failed to connect to <host> ... Connection timed out" is a
        # transient TCP timeout to a (likely allowlisted) host — NOT a DNS
        # resolution failure. The bail is DNS-scoped, so this must still retry;
        # a persistent one is reclassified to egress_denied only AFTER exhaustion.
        stderr = (
            "fatal: unable to access 'https://github.com/o/r': "
            "Failed to connect to github.com port 443: Connection timed out"
        )
        seq = [self._proc(1, stderr), self._proc(0)]
        retries = []
        with patch("shell.run_cmd", side_effect=lambda *a, **k: seq.pop(0)):
            result = run_cmd_with_backoff(
                ["git", "clone"],
                "clone",
                on_retry=lambda *a: retries.append(a),
                sleep=lambda _: None,
            )
        assert result.returncode == 0
        assert len(retries) == 1  # retried the transient TCP timeout

    def test_gives_up_after_max_attempts_on_persistent_transient(self):
        attempts = []
        proc = self._proc(1, "connection timed out")
        with patch("shell.run_cmd", side_effect=self._counting(proc, attempts)):
            result = run_cmd_with_backoff(
                ["git", "clone"], "clone", max_attempts=3, sleep=lambda _: None
            )
        assert result.returncode == 1
        assert len(attempts) == 3  # exhausted the cap, no more

    def test_does_not_retry_permanent_failure(self):
        attempts = []
        proc = self._proc(1, "Permission denied")
        with patch("shell.run_cmd", side_effect=self._counting(proc, attempts)):
            result = run_cmd_with_backoff(
                ["git", "clone"], "clone", max_attempts=3, sleep=lambda _: None
            )
        assert result.returncode == 1
        assert len(attempts) == 1  # fail-fast on non-transient

    def test_backoff_delays_are_exponential(self):
        delays = []
        seq = [self._proc(1, "connection reset")] * 2 + [self._proc(0)]
        with patch("shell.run_cmd", side_effect=lambda *a, **k: seq.pop(0)):
            run_cmd_with_backoff(["git", "clone"], "clone", base_delay_s=2.0, sleep=delays.append)
        assert delays == [2.0, 4.0]  # 2 * 2**0, 2 * 2**1


class TestRunCmdFailureLogging:
    """A failing command must surface its ACTUAL error. Build/test tooling (jest,
    tsc, the mise task DAG) writes the failing-task error to STDOUT, not stderr —
    so logging stderr alone made build-gate failures undebuggable (ABCA-662: a red
    ``mise run build`` showed every task starting but never WHICH one failed)."""

    def _completed(self, rc, stdout="", stderr=""):
        return SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr)

    def _run_capturing_logs(self, proc):
        logs = []
        with (
            patch("shell.subprocess.run", return_value=proc),
            patch("shell.log", side_effect=lambda prefix, text: logs.append((prefix, text))),
        ):
            run_cmd(["mise", "run", "build"], "verify-build-post", check=False)
        return logs

    def test_stdout_is_logged_on_failure(self):
        # The failing task's error lives in stdout — it MUST reach the log.
        proc = self._completed(
            1,
            stdout="[//cdk:test] FAIL test/foo.test.ts\n  expected 1 got 2\n[//cdk:test] exit 1",
            stderr="",
        )
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "FAIL test/foo.test.ts" in blob
        assert "expected 1 got 2" in blob

    def test_no_markers_falls_back_to_tail(self):
        # Unknown tool output with no failure signature → fall back to the tail.
        proc = self._completed(
            1,
            stdout="\n".join(f"line {i}" for i in range(50)),
            stderr="",
        )
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "line 49" in blob  # last line present (tail)
        assert "line 0" not in blob  # earliest lines dropped

    def test_failure_line_in_the_MIDDLE_is_surfaced(self):
        # ABCA-662 root cause of the tooling gap: a PARALLEL mise DAG interleaves
        # output, so the failing task's line is in the MIDDLE while the tail is a
        # passing package's coverage table. The failing line MUST be surfaced.
        mid = "[//cdk:test] FAIL test/handlers/foo.test.ts — expected 1 got 2"
        stdout = (
            "\n".join(f"[//cdk:test] passing line {i}" for i in range(30))
            + f"\n{mid}\n"
            + "\n".join(f"[//agent:test] coverage {i} | 100 | 100" for i in range(30))
        )
        proc = self._completed(1, stdout=stdout, stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "FAIL test/handlers/foo.test.ts" in blob  # the mid-DAG red is surfaced
        assert "coverage 29" in blob  # tail context still present

    def test_coverage_threshold_failure_is_surfaced(self):
        # jest prints a coverage table then exits 1 with "does not meet threshold"
        # — no ✕/FAIL line. That threshold line must be surfaced.
        stdout = (
            "\n".join(f"file{i}.ts | 100 | 100 | 100 | 100" for i in range(40))
            + '\nJest: "global" coverage threshold for branches (82%) not met: 79%'
        )
        proc = self._completed(1, stdout=stdout, stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "coverage threshold for branches" in blob

    def test_benign_zero_errors_line_not_surfaced_as_failure(self):
        # "0 errors" / "no error" must NOT be pulled in as a failure marker.
        stdout = "eslint: 0 errors, 0 warnings\n" + "\n".join(f"ok {i}" for i in range(20))
        proc = self._completed(1, stdout=stdout, stderr="")
        logs = self._run_capturing_logs(proc)
        # It falls back to tail (no real failure markers); the "0 errors" line is
        # not falsely elevated as THE failure.
        blob = "\n".join(text for _, text in logs)
        assert "ok 19" in blob

    def test_stdout_is_redacted(self):
        proc = self._completed(1, stdout="error: pushing with ghp_supersecrettoken123", stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "ghp_supersecrettoken123" not in blob

    def test_success_does_not_dump_stdout(self):
        # On success we don't spam stdout — only the OK line.
        proc = self._completed(0, stdout="lots of build output", stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "lots of build output" not in blob


class TestRunCmdStreaming:
    """stream=True tees the command's output to the log LINE-BY-LINE as it runs
    (so the full log reaches CloudWatch verbatim) AND returns a CompletedProcess
    matching subprocess.run's contract. Uses real `sh -c` — exercises the actual
    Popen + drain-thread path (the buffered summary hid build failures — ABCA-662)."""

    def _run(self, argv, check=False):
        logs = []
        with patch("shell.log", side_effect=lambda prefix, text: logs.append((prefix, text))):
            result = run_cmd(argv, "verify-build-post", check=check, stream=True)
        blob = "\n".join(text for _, text in logs)
        return result, blob

    def test_streams_stdout_lines_live_and_returns_captured(self):
        result, blob = self._run(["sh", "-c", "echo out-line-A; echo out-line-B"])
        assert result.returncode == 0
        # every line reached the log (verbatim, live)
        assert "out-line-A" in blob and "out-line-B" in blob
        # and the CompletedProcess still carries stdout for callers
        assert "out-line-A" in result.stdout and "out-line-B" in result.stdout

    def test_keeps_stdout_and_stderr_separate(self):
        result, _ = self._run(["sh", "-c", "echo to-out; echo to-err 1>&2"])
        assert "to-out" in result.stdout
        assert "to-err" in result.stderr
        assert "to-err" not in result.stdout  # streams not merged

    def test_nonzero_exit_surfaces_failing_line(self):
        # A mid-stream failure line is streamed AND flagged in the failing-lines
        # pointer — the whole reason streaming exists.
        result, blob = self._run(
            ["sh", "-c", "echo passing; echo 'FAIL test/x.test.ts'; exit 1"]
        )
        assert result.returncode == 1
        assert "FAIL test/x.test.ts" in blob
        assert "failing lines" in blob  # the streamed-path pointer

    def test_stream_redacts_secrets_in_live_output(self):
        # Redaction happens inside the real log(); assert redact_secrets covers the
        # streamed line (the test patches log(), so check the redactor directly on
        # what the drain thread hands it — that's the line that reaches CloudWatch).
        from shell import redact_secrets

        assert "ghp_streamedsecretABC123" not in redact_secrets(
            "  token=ghp_streamedsecretABC123"
        )

    def test_stream_raises_on_check_true_failure(self):
        import pytest

        with pytest.raises(RuntimeError):
            self._run(["sh", "-c", "exit 3"], check=True)
