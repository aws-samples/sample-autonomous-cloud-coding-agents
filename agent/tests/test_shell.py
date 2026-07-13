"""Unit tests for shell.py — slugify, redact_secrets, truncate."""

from types import SimpleNamespace
from unittest.mock import patch

from shell import (
    is_transient_cmd_failure,
    redact_secrets,
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
