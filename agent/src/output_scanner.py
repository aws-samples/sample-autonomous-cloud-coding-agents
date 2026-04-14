"""Regex-based secret and PII scanner for tool output screening.

Scans tool outputs for sensitive content (secrets, tokens, private keys,
connection strings) and produces redacted versions suitable for re-injection
into agent context.  Patterns are compiled once at module level.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Scan result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScanResult:
    """Result of scanning tool output for sensitive content."""

    has_sensitive_content: bool
    redacted_content: str
    findings: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


# ---------------------------------------------------------------------------
# Pattern registry
# ---------------------------------------------------------------------------

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # AWS access key IDs
    ("AWS_KEY", re.compile(r"AKIA[0-9A-Z]{16}")),
    # AWS secret access keys (40-char base64 near common keywords)
    (
        "AWS_SECRET",
        re.compile(
            r"(?:aws_secret_access_key|SecretAccessKey|AWS_SECRET_ACCESS_KEY)"
            r"[\s=:\"']+([A-Za-z0-9/+=]{40})",
            re.IGNORECASE,
        ),
    ),
    # GitHub tokens (PAT, OAuth, App, user-to-server, fine-grained)
    ("GITHUB_TOKEN", re.compile(r"(?:ghp|gho|ghs|ghu)_[a-zA-Z0-9]{36}")),
    ("GITHUB_PAT", re.compile(r"github_pat_[a-zA-Z0-9_]{22,}")),
    # Private keys (PEM blocks)
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        ),
    ),
    # Generic Bearer / token patterns (min 20-char token to avoid false positives
    # on natural English like "bearer of good news")
    ("BEARER_TOKEN", re.compile(r"Bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*", re.IGNORECASE)),
    # Connection strings with embedded passwords (protocol name capped at 20
    # chars to avoid quadratic backtracking on long alphabetic strings)
    (
        "CONNECTION_STRING",
        re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]{0,20}://[^:]+:[^@]+@[^\s\"']+"),
    ),
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

# Scan only the first 5 MB of tool output to bound regex execution time.
_MAX_SCAN_LENGTH = 5_000_000


def scan_tool_output(content: str | None) -> ScanResult:
    """Scan *content* for secrets/PII and return a ``ScanResult``.

    Non-string values should be converted to ``str`` before calling.
    ``None`` and empty strings short-circuit to a clean result.
    Content exceeding ``_MAX_SCAN_LENGTH`` is truncated before scanning.
    """
    if not content:
        return ScanResult(has_sensitive_content=False, redacted_content=content or "")

    if len(content) > _MAX_SCAN_LENGTH:
        content = content[:_MAX_SCAN_LENGTH]

    start = time.monotonic()
    findings: list[str] = []
    redacted = content

    for label, pattern in _PATTERNS:
        if pattern.search(redacted):
            findings.append(f"{label} detected")
            redacted = pattern.sub(f"[REDACTED-{label}]", redacted)

    elapsed_ms = (time.monotonic() - start) * 1000
    return ScanResult(
        has_sensitive_content=len(findings) > 0,
        redacted_content=redacted,
        findings=findings,
        duration_ms=elapsed_ms,
    )
