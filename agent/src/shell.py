"""Shell utilities: logging, command execution, and text helpers."""

import contextlib
import os
import re
import subprocess
import threading
import time


def log(prefix: str, text: str):
    """Print a timestamped, redacted log line.

    Emits via ``os.write(1, ...)`` rather than ``print`` for parity with
    ``server._emit_stdout_line``: content is always routed through
    ``redact_secrets`` first, and the fd-level sink keeps CodeQL's
    cleartext-logging query (which models print/TextIOWrapper.write)
    from flagging the already-sanitized line. Tests observing this
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

    Chunk 10 observability gap: ``log("ERROR", ...)`` writes to container
    stdout, which AgentCore routes to
    ``/aws/bedrock-agentcore/runtimes/<runtime>-DEFAULT`` rather than
    the APPLICATION_LOGS group that ``TaskDashboard`` LogQueryWidgets
    and ``bgagent status`` read. Agent-fatal errors were therefore
    invisible in the two places operators normally look — discovered
    during E2E 2026-05-11 T2.2 when a ``missing built-in hard-deny
    policies`` crash surfaced only as a cryptic "unknown" on the CLI.

    This helper mirrors the ERROR line to APPLICATION_LOGS via a
    fire-and-forget daemon thread (so it cannot block the failing
    code path) using the same writer pattern as ``server.py::_warn_cw``.
    Delivery failures are swallowed silently — the stdout ``log`` call
    above still runs, and a caller that wants strict delivery should
    use ``server._warn_cw`` directly from the server-only code paths.
    """
    # Always log to stdout for local / docker-compose parity with the
    # normal ``log()`` path.
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
    """Blocking CloudWatch put for ``log_error_cw`` — daemon-thread only.

    Mirrors ``server.py::_warn_cw_write_blocking`` but targets a
    separate ``agent_error/<task_id>`` stream so operators can alarm
    on agent-runtime fatal errors distinctly from server-layer
    warnings. Failures are swallowed (any surfaceable alarm should
    fire on the absence of the expected stream, not on this helper).
    """
    try:
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("logs", region_name=region)
        stream = f"agent_error/{task_id or 'unknown'}"
        with contextlib.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=stream)
        client.put_log_events(
            logGroupName=log_group,
            logStreamName=stream,
            logEvents=[{"timestamp": int(time.time() * 1000), "message": stamped}],
        )
    except Exception:  # noqa: S110 - best-effort telemetry; stdout path already logged
        # Intentionally silent. The caller (``log_error_cw``) has
        # already written the same message to stdout via the regular
        # ``log("ERROR", ...)`` path, so a CloudWatch delivery failure
        # (IAM, network, quota) does not lose the signal — it only
        # degrades it to the runtime-DEFAULT log group. Raising here
        # would unwind the daemon thread mid-shutdown and emit a
        # confusing secondary traceback during a primary failure.
        pass


def truncate(text: str, max_len: int = 200) -> str:
    """Truncate text for log display."""
    if not text:
        return ""
    text = text.replace("\n", " ").strip()
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


def redact_secrets(text: str) -> str:
    """Redact tokens and secrets from log output."""
    # GitHub and generic token-like values.
    text = re.sub(r"(ghp_|github_pat_|gho_|ghs_|ghr_)[A-Za-z0-9_]+", r"\1***", text)
    text = re.sub(r"(x-access-token:)[^\s@]+", r"\1***", text)
    text = re.sub(r"(authorization:\s*(?:bearer|token)\s+)[^\s]+", r"\1***", text, flags=re.I)
    text = re.sub(
        r"([?&](?:token|access_token|api_key|apikey|password)=)[^&\s]+",
        r"\1***",
        text,
        flags=re.I,
    )
    text = re.sub(r"(gh[opusr]_[A-Za-z0-9_]+)", "***", text)
    return text


def _clean_env() -> dict[str, str]:
    """Return a copy of os.environ with OTEL auto-instrumentation vars removed.

    The ``opentelemetry-instrument`` wrapper injects PYTHONPATH and OTEL_*
    env vars that would cause child Python processes (e.g. mise run build →
    semgrep in the target repo) to attempt OTEL auto-instrumentation and fail
    because the target repo's Python environment doesn't have the OTEL
    packages installed.  Stripping these vars isolates target-repo commands
    from the agent's own instrumentation.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
    # Strip only OTEL-injected PYTHONPATH components (the sitecustomize.py
    # directory), preserving any entries the target repo's toolchain may need.
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


def run_cmd(
    cmd: list[str],
    label: str,
    cwd: str | None = None,
    timeout: int = 600,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a command with logging."""
    log("CMD", redact_secrets(f"{label}: {' '.join(cmd)}"))
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_clean_env(),
    )
    if result.returncode != 0:
        log("CMD", f"{label}: FAILED (exit {result.returncode})")
        if result.stderr:
            for line in result.stderr.strip().splitlines()[:20]:
                log("CMD", f"  {line}")
        if check:
            stderr_snippet = redact_secrets(result.stderr.strip()[:500]) if result.stderr else ""
            raise RuntimeError(f"{label} failed (exit {result.returncode}): {stderr_snippet}")
    else:
        log("CMD", f"{label}: OK")
    return result


# Signatures a transient (retryable) dependency/registry failure leaves in a
# command's stderr — network blips, DNS hiccups, registry 5xx / rate limits.
# NOT a permanent auth/not-found error: those are re-run-won't-help and would
# just waste backoff time. Deliberately conservative (#251 dependency_unreachable).
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
    "eai_again",
    "network is unreachable",
    "tls handshake timeout",
    "unexpected eof",
)


def is_transient_cmd_failure(stderr: str) -> bool:
    """True if *stderr* looks like a transient (retryable) dependency failure.

    Used by :func:`run_cmd_with_backoff` to decide whether another attempt is
    worthwhile. Permanent failures (auth denied, repo not found, 4xx other than
    429) return False so we fail fast instead of burning the backoff budget.
    """
    low = (stderr or "").lower()
    return any(sig in low for sig in _TRANSIENT_CMD_SIGNATURES)


# DNS name-resolution failures that NAME a host — a firewalled / non-existent
# endpoint whose name cannot be resolved. Retrying never helps, so backoff bails
# immediately (#251 review). Deliberately NARROWER than hooks.detect_egress_denial:
# a TCP-connect failure ("Failed to connect to <host> ... Connection timed out")
# to an ALLOWLISTED host is genuinely transient and must stay retryable — so
# ``Failed to connect``/``Connection refused`` are excluded here. A persistent
# TCP failure is still reclassified to egress_denied by _fail_setup_command
# AFTER the retries exhaust; only the pre-exhaustion bail is DNS-scoped.
_UNRESOLVABLE_HOST_RE = re.compile(
    r"could not resolve host:?\s+[A-Za-z0-9._-]+"
    r"|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\s+[A-Za-z0-9._-]+"
    r"|Failed to resolve '[A-Za-z0-9._-]+'",
    re.IGNORECASE,
)


def _names_unresolvable_host(stderr: str) -> bool:
    """True when *stderr* is a DNS name-resolution failure naming a host (#251).

    Such a host cannot be reached no matter how often we retry (non-existent or
    firewalled at DNS), so backoff bails immediately rather than burn its budget
    and emit misleading ``dependency_unreachable`` events. A host-less
    ``Temporary failure in name resolution`` (no nameable endpoint) and a
    transient TCP-connect timeout to an allowlisted host both stay retryable."""
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
    """Run ``cmd`` with bounded retries on *transient* failures (#251, Phase 2).

    Retries up to ``max_attempts`` times with exponential backoff
    (``base_delay_s * 2**(attempt-1)``) ONLY when the failure looks transient
    (:func:`is_transient_cmd_failure`). Permanent failures return immediately.
    Always runs with ``check=False`` internally so the caller inspects
    ``returncode`` — self-remediation must never raise mid-retry.

    ``on_retry(attempt, max_attempts, stderr)`` is an optional auditable-event
    callback fired before each backoff sleep (kept as a callback so ``shell``
    stays free of ``hooks``/``progress`` imports — the caller wires in the
    blocker event). ``sleep`` is injectable so tests don't actually wait.

    Self-remediation is scope-preserving BY CONSTRUCTION: it only re-invokes the
    exact same ``cmd`` with the same environment. It grants no new credentials
    and mutates no IAM policy or egress allowlist — a retried ``git clone`` uses
    the same token and DNS rules as the first attempt.
    """
    # ``max(1, ...)`` guarantees the loop body runs at least once, so ``result``
    # is always bound by the time we return it — no None-typed fall-through.
    result = run_cmd(cmd, label, cwd=cwd, timeout=timeout, check=False)
    for attempt in range(1, max(1, max_attempts) + 1):
        if attempt > 1:
            result = run_cmd(cmd, label, cwd=cwd, timeout=timeout, check=False)
        if result.returncode == 0:
            return result
        stderr = result.stderr or ""
        # A named-host failure is a firewalled/non-existent endpoint — retrying
        # never helps and would emit misleading dependency_unreachable events
        # (#251 review). Bail immediately so _fail_setup_command reclassifies it
        # to the non-retryable egress_denied remedy.
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
