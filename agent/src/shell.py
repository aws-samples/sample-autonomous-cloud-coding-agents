"""Shell utilities: logging, command execution, and text helpers."""

import collections
import contextlib
import io
import os
import re
import signal
import subprocess
import threading
import time


def log(prefix: str, text: str):
    """Print a timestamped, redacted log line.

    Emits via ``os.write(1, ...)`` rather than ``print``. Tests observing this
    output must use ``capfd``, not ``capsys``.
    """
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {prefix} {redact_secrets(text)}\n".encode("utf-8", errors="replace")
    try:
        while line:
            n = os.write(1, line)
            line = line[n:]
    except OSError:
        pass


def log_error_cw(message: str, *, task_id: str | None = None) -> None:
    """Emit an ERROR line to stdout AND the APPLICATION_LOGS CloudWatch group.

    ``log("ERROR", ...)`` writes to container stdout, which AgentCore routes to
    ``/aws/bedrock-agentcore/runtimes/<runtime>-DEFAULT`` rather than the
    APPLICATION_LOGS group.

    The CloudWatch write runs in a fire-and-forget daemon thread. Delivery
    failures are swallowed silently.
    """
    log("ERROR", message)

    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    stamped = f"[agent/error] {redact_secrets(message)}"
    _t = threading.Thread(
        target=_log_error_cw_blocking,
        args=(log_group, task_id, stamped),
        name="agent-error-cw-write",
        daemon=True,
    )
    _t.start()


def _log_error_cw_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
    try:
        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("logs", region_name=region)
        stream = f"agent_error/{task_id or 'unknown'}"
        with contextlib.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=stream)
        client.put_log_events(
            logGroupName=log_group,
            logStreamName=stream,
            logEvents=[{"timestamp": int(time.time() * 1000), "message": stamped}],
        )
    except Exception:  # noqa: S110 - best-effort telemetry; stdout path already logged
        pass


def truncate(text: str, max_len: int = 200) -> str:
    if not text:
        return ""
    text = redact_secrets(text).replace("\n", " ").strip()
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


def slugify(text: str, max_len: int = 40) -> str:
    """Convert text to a URL-safe slug for branch names."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text)
    text = text.strip("-")
    if len(text) > max_len:
        text = text[:max_len].rstrip("-")
    return text or "task"


_SECRET_ENV_VARS = (
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "LINEAR_API_TOKEN",
    "JIRA_API_TOKEN",
    "JIRA_APP_ACTOR_SHARED_SECRET",
)

_MIN_REDACTABLE_SECRET_LEN = 12


def redact_secrets(text: str) -> str:
    for name in _SECRET_ENV_VARS:
        secret = os.environ.get(name, "")
        if len(secret) >= _MIN_REDACTABLE_SECRET_LEN:
            text = text.replace(secret, "***")
    text = re.sub(r"(ghp_|github_pat_|gho_|ghs_|ghr_)[A-Za-z0-9_]+", r"\1***", text)
    text = re.sub(r"(x-access-token:)[^\s@]+", r"\1***", text)
    text = re.sub(
        r"(authorization:\s*(?:bearer|token)\s+)[^\s]+", r"\1***", text, flags=re.IGNORECASE
    )
    text = re.sub(
        r"([?&](?:token|access_token|api_key|apikey|password)=)[^&\s]+",
        r"\1***",
        text,
        flags=re.IGNORECASE,
    )
    # A GitHub App installation token is ghs_<app id>_<JWT>: "." joins the three
    # parts of the JWT and "-" occurs inside them.
    text = re.sub(r"(gh[opusr]_[A-Za-z0-9_][A-Za-z0-9_.*-]*)", "***", text)
    return re.sub(r"((?:gh[opusr]|github_pat)_\*{3})[.-][A-Za-z0-9_.*-]*", r"\1", text)


def _clean_env() -> dict[str, str]:
    """Return a copy of os.environ with OTEL auto-instrumentation vars removed.

    The ``opentelemetry-instrument`` wrapper injects PYTHONPATH and OTEL_*
    env vars that would cause child Python processes to attempt OTEL
    auto-instrumentation and fail because the target repo's Python environment
    doesn't have the OTEL packages installed.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
    pythonpath = env.get("PYTHONPATH", "")
    if pythonpath:
        cleaned = os.pathsep.join(
            p for p in pythonpath.split(os.pathsep) if "opentelemetry" not in p
        )
        if cleaned:
            env["PYTHONPATH"] = cleaned
        else:
            env.pop("PYTHONPATH", None)
    return env


_FAILURE_LINE_MARKERS = (
    "fail ",  # jest "FAIL test/foo.test.ts", pytest "FAILED"
    "failed",
    "✕",
    "✗",
    "✖",
    "●",  # jest failed-assertion bullet
    "error ts",  # tsc "error TS2345:"
    "error:",
    "elifecycle",  # yarn/npm lifecycle failure
    "npm err!",
    "does not meet",  # jest coverage-threshold "global … does not meet threshold"
    "coverage threshold",
    'jest: "global"',
    "not trusted",  # mise untrusted config
    "no task ",  # mise "no task named"
    "missing script",  # npm missing script
    "assertionerror",
    "traceback (most recent call last)",
    "task failed",  # mise "[//pkg:task] ERROR task failed"
)

_FAILURE_LINE_NOISE = re.compile(
    r"(?<![0-9])0 (?:errors|failed|problems)"
    r"|no error"
    r"|--no-error"
    r"|may fail"
)

_MAX_SURFACED_FAILURE_LINES = 40
_FAILURE_TAIL_LINES = 15


def _surface_failure_lines(stdout: str) -> list[str]:
    lines = stdout.strip().splitlines()
    matched: list[str] = []
    for ln in lines:
        low = ln.lower()
        if any(m in low for m in _FAILURE_LINE_MARKERS) and not _FAILURE_LINE_NOISE.search(low):
            if len(matched) >= _MAX_SURFACED_FAILURE_LINES:
                matched.append("… (more failure lines truncated)")
                break
            matched.append(ln.rstrip())
    tail = [ln.rstrip() for ln in lines[-_FAILURE_TAIL_LINES:]]
    seen = set(matched)
    out = list(matched)
    if matched and tail:
        out.append("--- (trailing output) ---")
    for ln in tail:
        if ln not in seen:
            out.append(ln)
            seen.add(ln)
    return out or tail


# A process killed by a signal surfaces on ``Popen.returncode`` as the NEGATIVE
# signal number (SIGKILL -> -9), whereas a shell reports the same death as
# ``128 + signal`` (-> 137).
_SIGNAL_EXIT_BASE = 128


def _exit_status(returncode: int | None) -> int:
    if returncode is None:
        return -1
    if returncode < 0:
        return _SIGNAL_EXIT_BASE - returncode
    return returncode


_MAX_CAPTURED_LINES = 200_000

_TIMEOUT_GRACE_S = 10


def _run_cmd_streaming(
    cmd: list[str], cwd: str | None, timeout: int
) -> subprocess.CompletedProcess:
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        # Popen's own text mode would need its ``errors`` argument, which the
        # SAST rule pack reports (python36-compatibility-Popen1).
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_env(),
        # Not a session of its own: mise stops managing the processes of its
        # tasks when it is a session leader.
        process_group=0,
    )
    out_lines: collections.deque[str] = collections.deque(maxlen=_MAX_CAPTURED_LINES)
    err_lines: collections.deque[str] = collections.deque(maxlen=_MAX_CAPTURED_LINES)

    def _drain(pipe, buf: collections.deque[str]) -> None:
        lines = io.TextIOWrapper(pipe, errors="replace")
        try:
            for line in lines:
                line = line.rstrip("\n")
                buf.append(line)
                log("CMD", f"  {line}")
        finally:
            lines.close()

    t_out = threading.Thread(target=_drain, args=(proc.stdout, out_lines), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, err_lines), daemon=True)
    t_out.start()
    t_err.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if proc.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, sig)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    proc.wait(timeout=_TIMEOUT_GRACE_S)
        t_out.join(timeout=10)
        t_err.join(timeout=10)
        raise
    t_out.join(timeout=10)
    t_err.join(timeout=10)
    return subprocess.CompletedProcess(
        cmd, _exit_status(proc.returncode), "\n".join(out_lines), "\n".join(err_lines)
    )


def run_cmd(
    cmd: list[str],
    label: str,
    cwd: str | None = None,
    timeout: int = 600,
    check: bool = True,
    stream: bool = False,
) -> subprocess.CompletedProcess:
    """Run a command with logging.

    ``stream=True`` tees the command's output to the log line-by-line as it runs.
    """
    log("CMD", redact_secrets(f"{label}: {' '.join(cmd)}"))
    if stream:
        result = _run_cmd_streaming(cmd, cwd, timeout)
    else:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env=_clean_env(),
        )
    if result.returncode != 0:
        log("CMD", f"{label}: FAILED (exit {result.returncode})")
        if stream:
            surfaced = _surface_failure_lines(result.stdout or "")
            if surfaced:
                log("CMD", f"{label}: failing lines (full output streamed above):")
                for line in surfaced:
                    log("CMD", f"  {redact_secrets(line)}")
        else:
            if result.stderr:
                for line in result.stderr.strip().splitlines()[:20]:
                    log("CMD", f"  {line}")
            if result.stdout:
                surfaced = _surface_failure_lines(result.stdout)
                for line in surfaced:
                    log("CMD", f"  {redact_secrets(line)}")
        if check:
            stderr_snippet = redact_secrets(result.stderr.strip()[:500]) if result.stderr else ""
            raise RuntimeError(f"{label} failed (exit {result.returncode}): {stderr_snippet}")
    else:
        log("CMD", f"{label}: OK")
    return result


_TRANSIENT_CMD_SIGNATURES: tuple[str, ...] = (
    "could not resolve host",
    "temporary failure in name resolution",
    "connection timed out",
    "connection reset",
    "operation timed out",
    "timeout was reached",
    "the requested url returned error: 5",  # curl/git HTTP 5xx
    "503 service unavailable",
    "502 bad gateway",
    "504 gateway",
    "429 too many requests",
    "the requested url returned error: 429",  # git's form of a rate limit
    "eai_again",
    "network is unreachable",
    "tls handshake timeout",
    "unexpected eof",
)


def is_transient_cmd_failure(stderr: str) -> bool:
    """True if *stderr* looks like a transient (retryable) dependency failure.

    Permanent failures (auth denied, repo not found, 4xx other than 429) return
    False.
    """
    low = (stderr or "").lower()
    return any(sig in low for sig in _TRANSIENT_CMD_SIGNATURES)


_UNRESOLVABLE_HOST_RE = re.compile(
    r"could not resolve host:?\s+[A-Za-z0-9._-]+"
    r"|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\s+[A-Za-z0-9._-]+"
    r"|Failed to resolve '[A-Za-z0-9._-]+'",
    re.IGNORECASE,
)


def _names_unresolvable_host(stderr: str) -> bool:
    return bool(_UNRESOLVABLE_HOST_RE.search(stderr or ""))


def run_cmd_with_backoff(
    cmd: list[str],
    label: str,
    *,
    cwd: str | None = None,
    timeout: int = 600,
    max_attempts: int = 3,
    base_delay_s: float = 2.0,
    on_retry=None,
    sleep=time.sleep,
) -> subprocess.CompletedProcess:
    """Run ``cmd`` with bounded retries on *transient* failures.

    Retries up to ``max_attempts`` times with exponential backoff
    (``base_delay_s * 2**(attempt-1)``) ONLY when the failure looks transient
    (:func:`is_transient_cmd_failure`). Permanent failures return immediately.
    Always runs with ``check=False`` internally so the caller inspects
    ``returncode``.

    ``on_retry(attempt, max_attempts, stderr)`` is an optional callback fired
    before each backoff sleep. ``sleep`` is injectable so tests don't actually
    wait.

    Only re-invokes the exact same ``cmd`` with the same environment.
    """
    result = run_cmd(cmd, label, cwd=cwd, timeout=timeout, check=False)
    for attempt in range(1, max(1, max_attempts) + 1):
        if attempt > 1:
            result = run_cmd(cmd, label, cwd=cwd, timeout=timeout, check=False)
        if result.returncode == 0:
            return result
        stderr = result.stderr or ""
        exhausted = attempt >= max_attempts
        if exhausted or not is_transient_cmd_failure(stderr) or _names_unresolvable_host(stderr):
            break
        if on_retry is not None:
            on_retry(attempt, max_attempts, stderr)
        delay = base_delay_s * (2 ** (attempt - 1))
        log(
            "CMD",
            f"{label}: transient failure — retrying in {delay:.0f}s ({attempt}/{max_attempts})",
        )
        sleep(delay)
    return result
