"""Unit tests for shell.py — slugify, redact_secrets, truncate."""

import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from shell import (
    is_transient_cmd_failure,
    put_log_event,
    redact_secrets,
    run_cmd,
    run_cmd_with_backoff,
    slugify,
    truncate,
)

# A GitHub App installation token of the stateless format, ghs_<app id>_<JWT>:
# three base64url parts, which may hold "-" and "_", joined by dots. Assembled
# here so that this file holds no token-shaped literal.
_JWT = ".".join(["eyJ" + "hbGciOi" * 5, "eyJ" + "pYXQi-_" * 40, "s1G-n_" * 30])
_APP_TOKEN = "gh" + "s_123456_" + _JWT


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

    def test_github_token_with_a_prefix_only_the_catch_all_rule_knows(self):
        # ghu_ (user-to-server) is not among the prefixes the first rule lists.
        assert redact_secrets("remote: ghu_abc123XYZ rejected") == "remote: *** rejected"

    def test_authorization_header(self):
        assert (
            redact_secrets("> Authorization: Bearer abc.def-123") == "> Authorization: Bearer ***"
        )
        assert redact_secrets("authorization: token s3cr3t next") == "authorization: token *** next"

    def test_secret_query_parameters(self):
        url = "https://example.test/hook?access_token=abc123&ref=main&API_KEY=xyz789"
        redacted = "https://example.test/hook?access_token=***&ref=main&API_KEY=***"
        assert redact_secrets(url) == redacted

    def test_no_secrets(self):
        text = "nothing secret here"
        assert redact_secrets(text) == text

    @pytest.mark.parametrize(
        "name",
        [
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "LINEAR_API_TOKEN",
            "JIRA_API_TOKEN",
            "JIRA_APP_ACTOR_SHARED_SECRET",
        ],
    )
    def test_value_of_a_credential_the_process_holds(self, monkeypatch, name):
        # What a build prints with `env`, or the agent with `printenv`. The value
        # has no shape a pattern could know: a Linear or Atlassian token, the
        # Forge signing key, a GitHub token without the `gh?_` prefix.
        monkeypatch.setenv(name, "made-up-value-0123456789")
        assert redact_secrets(f"{name}=made-up-value-0123456789") == f"{name}=***"

    def test_short_value_of_a_credential_variable_is_left_alone(self, monkeypatch):
        # Replacing a short string would mangle unrelated text that contains it.
        monkeypatch.setenv("GITHUB_TOKEN", "test")
        text = "3 tests passed, latest: test_ok"
        assert redact_secrets(text) == text

    @pytest.mark.parametrize(
        ("text", "redacted"),
        [
            pytest.param(f"GITHUB_TOKEN={_APP_TOKEN}", "GITHUB_TOKEN=ghs_***", id="an assignment"),
            pytest.param(_APP_TOKEN, "ghs_***", id="the bare token"),
            pytest.param(
                f"The installation token is {_APP_TOKEN}.",
                "The installation token is ghs_***",
                id="at the end of a sentence",
            ),
            pytest.param(
                "gh" + "s_123456_" + "eyJ" + "hb-" + _JWT[3:],
                "ghs_***",
                id="a dash before the first dot",
            ),
            pytest.param(
                _APP_TOKEN + "gh" + "o_1a-2b",
                "ghs_***",
                id="a prefix inside the signature",
            ),
        ],
    )
    def test_github_app_token_of_the_stateless_format(self, text, redacted):
        # Every installation token GitHub issues since 2026 has this format,
        # about 520 characters. The rule for the prefix stops at the first "."
        # or "-" of the JWT, so the payload and the signature stayed in the log
        # line. The full stop behind the token goes with it: a token holds dots.
        # A signature is random and can hold a prefix of the first rule, which
        # that rule replaces by a second marker. The rest behind that marker
        # belongs to the token as well.
        assert redact_secrets(text) == redacted

    @pytest.mark.parametrize("prefix", ["gh" + "p_", "gh" + "o_", "gh" + "r_", "github" + "_pat_"])
    def test_rest_of_a_token_goes_whatever_prefix_of_the_first_rule_it_has(self, prefix):
        # No such token is issued today; the rule is the same for every prefix.
        assert redact_secrets(prefix + "11AB22." + "cd-EF_gh") == prefix + "***"

    def test_token_in_three_parts_with_a_prefix_only_the_catch_all_rule_knows(self):
        token = "gh" + "u_42_" + _JWT
        assert redact_secrets(f"remote: {token} rejected") == "remote: *** rejected"
        # and with a prefix of the first rule inside its signature
        token += "gh" + "o_1a-2b"
        assert redact_secrets(f"remote: {token} rejected") == "remote: *** rejected"

    def test_keyword_behind_a_token_is_still_seen_by_its_own_rule(self):
        # Why the first rule keeps its narrow class and the rest of a token is
        # taken at the very end: with "." in its class the first rule would take
        # "authorization" into the token, and the rule for that keyword, which
        # runs after it, would leave the credential behind it in the line.
        text = "gh" + "s_abc.authorization: bearer s3cr3t"
        assert "s3cr3t" not in redact_secrets(text)

    def test_prefix_without_a_token_behind_it_is_left_alone(self):
        text = "token prefixes: gh" + "p_, gh" + "o_ and gh" + "s_."
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

    def test_credential_is_redacted_before_the_cut_can_split_it(self, monkeypatch):
        # The runner logs the first 200 characters of each tool result. A value
        # cut in two no longer equals the credential, so the redaction by value
        # in log() would let the part before the cut through.
        secret = "made-up-value-" + "0123456789" * 30
        monkeypatch.setenv("JIRA_API_TOKEN", secret)
        assert truncate(f"JIRA_API_TOKEN={secret}") == "JIRA_API_TOKEN=***"


class TestIsTransientCmdFailure:
    def test_dns_and_5xx_are_transient(self):
        assert is_transient_cmd_failure("fatal: Could not resolve host: github.com")
        assert is_transient_cmd_failure("The requested URL returned error: 503")
        assert is_transient_cmd_failure("npm ERR! 429 Too Many Requests")
        # git prints a rate limit as the status code alone (#801: the push preflight).
        assert is_transient_cmd_failure("The requested URL returned error: 429")
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
    so logging stderr alone made build-gate failures undebuggable (a red
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
        # Root cause of the tooling gap: a PARALLEL mise DAG interleaves
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

    def test_marker_line_with_noise_term_is_filtered_by_allowlist(self):
        # The LOAD-BEARING allowlist case. A line that hits a real marker
        # (`error:`) AND a noise term (`0 errors`) must be filtered OUT of the
        # surfaced set. Placed in the MIDDLE (before the tail window) so it is
        # only reachable via the marker scan — if _FAILURE_LINE_NOISE were
        # deleted, this line WOULD be surfaced and the assertion would fail.
        # A genuine failure line follows so the scan still produces a match set.
        noisy = "error: eslint produced 0 errors after autofix retry"  # marker + noise
        real = "[//cdk:test] FAIL test/handlers/bar.test.ts — boom"
        # 30 trailing passing lines push both lines above out of the tail window,
        # so `noisy` is only reachable via the marker scan (where the allowlist runs).
        stdout = f"{noisy}\n{real}\n" + "\n".join(f"[//agent:test] passing {i}" for i in range(30))
        proc = self._completed(1, stdout=stdout, stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        assert "FAIL test/handlers/bar.test.ts" in blob  # real failure surfaced
        assert "0 errors after autofix retry" not in blob  # noisy marker filtered by allowlist

    @pytest.mark.parametrize(
        "totals",
        [
            "Tests:       10 failed, 290 passed, 300 total",
            "==== 10 failed, 290 passed in 41.2s ====",
            "✖ 20 problems (20 errors, 0 warnings)",
        ],
        ids=["jest", "pytest", "eslint"],
    )
    def test_totals_line_with_a_count_ending_in_zero_is_surfaced(self, totals):
        # "0 failed" is noise; "10 failed" is the line that says how bad the run
        # was. The noise terms were matched as substrings, so the totals line was
        # dropped exactly when the count ended in 0 (10, 20, 100 ...). The 30
        # passing lines after it keep it out of the tail window.
        stdout = f"{totals}\n" + "\n".join(f"[//agent:test] passing {i}" for i in range(30))
        logs = self._run_capturing_logs(self._completed(1, stdout=stdout, stderr=""))
        assert f"  {totals}" in [text for _, text in logs]

    @pytest.mark.parametrize(
        "noisy",
        ["Tests: 0 failed, 300 passed, 300 total", "✖ 0 problems"],
        ids=["failed", "problems"],
    )
    def test_a_count_of_zero_is_still_noise(self, noisy):
        # The other two counts of the allowlist ("0 errors" is covered above).
        real = "[//cdk:test] FAIL test/handlers/bar.test.ts — boom"
        stdout = f"{noisy}\n{real}\n" + "\n".join(f"[//agent:test] passing {i}" for i in range(30))
        logs = self._run_capturing_logs(self._completed(1, stdout=stdout, stderr=""))
        texts = [text for _, text in logs]
        assert f"  {real}" in texts
        assert f"  {noisy}" not in texts

    def test_surfaced_failure_lines_are_capped_and_truncation_marked(self):
        # A genuinely huge red run (more than _MAX_SURFACED_FAILURE_LINES
        # marker lines) must be capped, with an explicit truncation breadcrumb —
        # so it can't flood CloudWatch. Exercises the cap branch the other tests
        # never reach.
        from shell import _MAX_SURFACED_FAILURE_LINES

        n = _MAX_SURFACED_FAILURE_LINES + 10
        stdout = "\n".join(f"FAIL test/case_{i}.test.ts — assertion {i}" for i in range(n))
        proc = self._completed(1, stdout=stdout, stderr="")
        logs = self._run_capturing_logs(proc)
        blob = "\n".join(text for _, text in logs)
        # The marker-scan hit the cap and emitted the truncation breadcrumb.
        assert "… (more failure lines truncated)" in blob
        # The breadcrumb appears within the surfaced set BEFORE the tail divider —
        # i.e. the matched-line scan was capped, not the whole output dumped.
        head = blob.split("--- (trailing output) ---")[0]
        head_cases = sum(1 for i in range(n) if f"case_{i}.test.ts" in head)
        assert head_cases <= _MAX_SURFACED_FAILURE_LINES

    def test_no_truncation_breadcrumb_when_every_failure_line_is_shown(self):
        # Exactly as many failure lines as the cap: nothing was cut, so the
        # breadcrumb would send the reader looking for lines that do not exist.
        from shell import _MAX_SURFACED_FAILURE_LINES

        n = _MAX_SURFACED_FAILURE_LINES
        stdout = "\n".join(f"FAIL test/case_{i}.test.ts — assertion {i}" for i in range(n))
        logs = self._run_capturing_logs(self._completed(1, stdout=stdout, stderr=""))
        blob = "\n".join(text for _, text in logs)
        assert all(f"case_{i}.test.ts" in blob for i in range(n))
        assert "more failure lines truncated" not in blob

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
    Popen + drain-thread path (the buffered summary hid build failures)."""

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

    def test_keeps_only_the_end_of_a_long_output(self, monkeypatch):
        # A build that floods its output must not grow the agent without bound.
        # Every line still goes to the log; the copy handed to the caller keeps
        # the end of each stream, where the failure summary and the callers'
        # stderr checks look.
        monkeypatch.setattr("shell._MAX_CAPTURED_LINES", 5)
        script = "for i in 1 2 3 4 5 6 7 8 9 10; do echo out-$i; echo err-$i 1>&2; done"
        result, blob = self._run(["sh", "-c", script])
        assert result.stdout.splitlines() == [f"out-{i}" for i in range(6, 11)]
        assert result.stderr.splitlines() == [f"err-{i}" for i in range(6, 11)]
        logged = blob.splitlines()
        assert all(f"  out-{i}" in logged and f"  err-{i}" in logged for i in range(1, 11))

    def test_nonzero_exit_surfaces_failing_line(self):
        # A mid-stream failure line is streamed AND flagged in the failing-lines
        # pointer — the whole reason streaming exists.
        result, blob = self._run(["sh", "-c", "echo passing; echo 'FAIL test/x.test.ts'; exit 1"])
        assert result.returncode == 1
        assert "FAIL test/x.test.ts" in blob
        assert "failing lines" in blob  # the streamed-path pointer

    def test_stream_redacts_secrets_in_live_output(self):
        # Redaction happens inside the real log(); assert redact_secrets covers the
        # streamed line (the test patches log(), so check the redactor directly on
        # what the drain thread hands it — that's the line that reaches CloudWatch).
        from shell import redact_secrets

        assert "ghp_streamedsecretABC123" not in redact_secrets("  token=ghp_streamedsecretABC123")

    def test_stream_redacts_a_credential_printed_from_the_environment(self, monkeypatch, capfd):
        # Through the real log(): every repository command inherits the agent's
        # environment, so a build step that prints it (`env`, a test runner dumping
        # process.env) used to write the Linear token to the log in cleartext.
        monkeypatch.setenv("LINEAR_API_TOKEN", "made-up-value-0123456789")
        run_cmd(["sh", "-c", "echo tok=$LINEAR_API_TOKEN"], "verify-build-pre", stream=True)
        out = capfd.readouterr().out
        assert "CMD   tok=***\n" in out
        assert "made-up-value-0123456789" not in out

    def test_stream_raises_on_check_true_failure(self):
        with pytest.raises(RuntimeError):
            self._run(["sh", "-c", "exit 3"], check=True)

    def _run_into_timeout(self, script):
        """Run *script* with a timeout of 1 s; return the seconds until run_cmd
        raised TimeoutExpired, and what was logged."""
        logs = []
        started = time.monotonic()
        with (
            patch("shell.log", side_effect=lambda prefix, text: logs.append(text)),
            pytest.raises(subprocess.TimeoutExpired),
        ):
            run_cmd(["sh", "-c", script], "verify-build-pre", timeout=1, stream=True)
        return time.monotonic() - started, logs

    def test_stream_timeout_stops_the_command_and_what_it_started(self):
        # A build that hangs has started compilers and test runners of its own.
        # The background `sleep` stands for them. It inherits both pipes, so
        # run_cmd can only raise at once when the sleep is gone as well: killing
        # `sh` alone left it running in the checkout, and run_cmd then waited 10 s
        # on each pipe (about 21 s for this command).
        #
        # The command is asked to stop before it is killed, which the trap shows:
        # a build tool that keeps its tasks in process groups of their own (mise)
        # can only take them down when it gets that chance.
        elapsed, logs = self._run_into_timeout("trap 'echo stopping; exit' TERM; sleep 30 & wait")
        assert elapsed < 10
        assert "  stopping" in logs

    def test_stream_timeout_kills_a_command_that_does_not_stop(self, monkeypatch):
        # The shell ignores SIGTERM, and so does the sleep it starts.
        monkeypatch.setattr("shell._TIMEOUT_GRACE_S", 1)
        elapsed, _ = self._run_into_timeout("trap '' TERM; sleep 30 & wait")
        assert elapsed < 10

    def test_stream_command_gets_a_process_group_but_not_a_session_of_its_own(self):
        # The group is what a timeout signals. A session would be one step too
        # far: mise, the default build tool, stops managing the processes of its
        # tasks when it is a session leader, and then leaves the other tasks of a
        # parallel build running when one of them fails.
        code = "import os; print(os.getpgid(0) == os.getpid(), os.getsid(0) == os.getpid())"
        result, _ = self._run([sys.executable, "-c", code])
        assert result.stdout == "True False"

    def test_stream_normalizes_a_signal_kill_to_the_shell_convention(self):
        # A signal death arrives from Popen as a NEGATIVE signal number, but the
        # OOM classifier keys on the shell's 128+signal form. Without normalizing,
        # an OOM-killed build reports as a genuine build failure — "your code is
        # broken" when the box ran out of memory.
        from post_hooks import is_infra_failure

        # 137 = 128 + SIGKILL(9). `kill -9 $$` makes the shell kill itself, so the
        # child really dies by signal rather than exiting with a code.
        result, _ = self._run(["sh", "-c", "kill -9 $$"])
        assert result.returncode == 137, "SIGKILL must surface as 137, not -9"
        # The point of the normalization: the classifier now sees infra, not a
        # genuine red build, with no stderr signature to help it.
        assert is_infra_failure(result.returncode, "") is True

    def test_stream_maps_an_unreaped_process_to_failure_not_success(self):
        # `returncode is None` cannot happen after wait(), but if it ever did,
        # mapping it to 0 would let an unverified build report as passing. The one
        # unsafe answer, so it is pinned.
        from shell import _exit_status

        assert _exit_status(None) != 0
        assert _exit_status(None) == -1
        # Ordinary exits pass through untouched.
        assert _exit_status(0) == 0
        assert _exit_status(1) == 1
        assert _exit_status(137) == 137
        # SIGTERM (-15) also normalizes.
        assert _exit_status(-15) == 143


class TestRunCmdUndecodableOutput:
    """A command may print a byte that is not valid UTF-8: a compiler quoting a
    Latin-1 source line, a test that prints raw bytes. run_cmd must still hand
    back all of the output and the command's own exit status; the byte itself
    arrives as U+FFFD."""

    # The byte 0xFF on a line of its own, between two lines of plain text.
    SCRIPT = "echo ok; printf '\\377\\n'; echo after"

    def test_streamed_command_keeps_its_output_and_its_exit_status(self):
        # Strict decoding raised in the drain thread, which then closed the pipe:
        # the lines after the byte were lost, and a command that was still writing
        # died of SIGPIPE (exit 141), so a passing build was reported as failed.
        argv = ["sh", "-c", self.SCRIPT]
        logs = []
        with patch("shell.log", side_effect=lambda prefix, text: logs.append(text)):
            result = run_cmd(argv, "verify-build-pre", check=False, stream=True)
        assert result.returncode == 0
        assert result.stdout.splitlines() == ["ok", "\N{REPLACEMENT CHARACTER}", "after"]
        assert "  after" in logs  # and the line reached the log

    def test_buffered_command_returns_instead_of_raising(self):
        # subprocess.run raised UnicodeDecodeError out of run_cmd, check=False or
        # not: a `mise install` that printed such a byte failed the task in setup.
        result = run_cmd(["sh", "-c", self.SCRIPT], "mise-install", check=False)
        assert result.returncode == 0
        assert result.stdout.splitlines() == ["ok", "\N{REPLACEMENT CHARACTER}", "after"]


class TestRunCmdStreamedText:
    """The streamed path reads the command's two pipes as text itself. What it
    hands back is what ``subprocess`` text mode gives the buffered path: the same
    decoding, with a replacement character for a byte that is no text, and every
    kind of line ending read as the end of a line."""

    @staticmethod
    def _both_ways(script: str) -> tuple[subprocess.CompletedProcess, subprocess.CompletedProcess]:
        argv = ["sh", "-c", script]
        with patch("shell.log"):
            return (
                run_cmd(argv, "verify-build-pre", check=False, stream=True),
                run_cmd(argv, "verify-build-pre", check=False),
            )

    def test_undecodable_byte_on_either_pipe_is_a_replacement_character(self):
        streamed, _ = self._both_ways("printf 'out \\377\\n'; printf 'err \\377\\n' 1>&2")

        assert streamed.stdout == "out \N{REPLACEMENT CHARACTER}"
        assert streamed.stderr == "err \N{REPLACEMENT CHARACTER}"

    def test_sequence_cut_off_at_the_end_of_the_output_is_replaced(self):
        # The first byte of a two-byte character, then the end of the output:
        # nothing follows that could complete it.
        streamed, buffered = self._both_ways("printf 'caf\\303'")

        assert streamed.stdout == "caf\N{REPLACEMENT CHARACTER}"
        assert streamed.stdout == buffered.stdout

    def test_text_that_is_not_ascii_is_decoded_as_on_the_buffered_path(self):
        streamed, buffered = self._both_ways("printf 'caf\\303\\251 \\342\\234\\223\\n'")

        assert streamed.stdout == "caf\N{LATIN SMALL LETTER E WITH ACUTE} \N{CHECK MARK}"
        assert streamed.stdout == buffered.stdout.rstrip("\n")

    def test_every_line_ending_ends_a_line(self):
        # A Windows tool in the build prints CRLF, a progress bar a bare CR. The
        # last line has no ending at all.
        streamed, buffered = self._both_ways("printf 'one\\r\\ntwo\\rthree\\nfour'")

        assert streamed.stdout.split("\n") == ["one", "two", "three", "four"]
        assert streamed.stdout == buffered.stdout

    def test_line_is_logged_while_the_command_still_runs(self):
        # Live output is what the streamed path is for: a line reaches the log
        # when the command prints it, not when the command ends.
        logged: dict[str, float] = {}
        argv = ["sh", "-c", "echo first; sleep 1; echo second"]
        with patch(
            "shell.log", side_effect=lambda _prefix, text: logged.update({text: time.monotonic()})
        ):
            run_cmd(argv, "verify-build-pre", stream=True)

        assert logged["  second"] - logged["  first"] > 0.5


# Prints, as JSON, the variables of its own environment that the tests below set.
_PRINT_ENV = (
    "import json, os; print(json.dumps({k: v for k, v in os.environ.items()"
    " if k.startswith('OTEL_') or k in ('PYTHONPATH', 'KEPT_FOR_THE_COMMAND')}))"
)
_INSTRUMENTATION = "/opt/venv/lib/opentelemetry/instrumentation/auto_instrumentation"


class TestCommandEnvironment:
    """What a command inherits from the agent's own process. The agent runs under
    the opentelemetry-instrument wrapper; a Python that a repository command starts
    (its build, its tests) must not try to instrument itself with packages that
    only the agent has."""

    @staticmethod
    def _seen_by_a_command(stream: bool) -> dict:
        result = run_cmd([sys.executable, "-c", _PRINT_ENV], "env", stream=stream)
        return json.loads(result.stdout)

    @pytest.mark.parametrize("stream", [False, True], ids=["buffered", "streamed"])
    def test_instrumentation_of_the_agent_is_not_inherited(self, monkeypatch, stream):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
        monkeypatch.setenv("OTEL_PYTHON_DISTRO", "aws_distro")
        monkeypatch.setenv("PYTHONPATH", os.pathsep.join((_INSTRUMENTATION, "/repo/src")))
        monkeypatch.setenv("KEPT_FOR_THE_COMMAND", "1")

        # The entry the repository's own tooling may need stays.
        assert self._seen_by_a_command(stream) == {
            "PYTHONPATH": "/repo/src",
            "KEPT_FOR_THE_COMMAND": "1",
        }

    def test_python_path_that_only_names_the_instrumentation_is_dropped(self, monkeypatch):
        monkeypatch.setenv("PYTHONPATH", _INSTRUMENTATION)

        assert self._seen_by_a_command(stream=False) == {}


class _StubLogs:
    """CloudWatch Logs as far as ``put_log_event`` uses it: a stream can be created once."""

    class exceptions:
        class ResourceAlreadyExistsException(Exception):
            pass

    def __init__(self):
        self.streams: dict[tuple[str, str], list[dict]] = {}

    def create_log_stream(self, *, logGroupName, logStreamName):
        if (logGroupName, logStreamName) in self.streams:
            raise self.exceptions.ResourceAlreadyExistsException(logStreamName)
        self.streams[logGroupName, logStreamName] = []

    def put_log_events(self, *, logGroupName, logStreamName, logEvents):
        self.streams[logGroupName, logStreamName].extend(logEvents)


class TestPutLogEvent:
    def test_creates_the_stream_and_puts_one_event_on_it_per_call(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "eu-west-1")
        monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-central-1")
        logs = _StubLogs()
        started = int(time.time() * 1000)

        with patch("aws_session.platform_client", return_value=logs) as client_for:
            put_log_event("/abca/application", "metrics/t-1", "first")
            # The stream exists now: CreateLogStream answers ResourceAlreadyExistsException.
            put_log_event("/abca/application", "metrics/t-1", "second")

        client_for.assert_called_with("logs", region_name="eu-west-1")
        ((stream, events),) = logs.streams.items()
        assert stream == ("/abca/application", "metrics/t-1")
        assert [event["message"] for event in events] == ["first", "second"]
        assert all(started <= event["timestamp"] <= int(time.time() * 1000) for event in events)

    @pytest.mark.parametrize("call", ["create_log_stream", "put_log_events"])
    def test_failure_other_than_an_existing_stream_reaches_the_caller(self, call, monkeypatch):
        monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-central-1")
        logs = _StubLogs()

        with (
            patch("aws_session.platform_client", return_value=logs) as client_for,
            patch.object(logs, call, side_effect=RuntimeError("denied")),
            pytest.raises(RuntimeError, match="denied"),
        ):
            put_log_event("/abca/application", "metrics/t-1", "lost")

        client_for.assert_called_once_with("logs", region_name="eu-central-1")
        assert not any(logs.streams.values())
