"""Shell utilities: logging, command execution, and text helpers."""

import os
import re
import subprocess
import time


def log(prefix: str, text: str):
    """Print a timestamped, redacted log line."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {prefix} {redact_secrets(text)}", flush=True)


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
