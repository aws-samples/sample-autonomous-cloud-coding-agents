"""Regex-based secret and PII scanner for tool output screening.

Scans tool outputs for sensitive content (secrets, tokens, private keys,
connection strings) and produces redacted versions suitable for re-injection
into agent context.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ScanResult:
    has_sensitive_content: bool
    redacted_content: str
    findings: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


_NOT_ONLY_A_PLACEHOLDER = (
    r"(?!(?:\$?(?:\{[A-Za-z_.]*\}|\{[0-9]{1,2}\}|\{\{[A-Za-z_.]*\}\})"
    r"|%[sv]|%\([A-Za-z_.]+\)s|<[a-z_-]+>|<[A-Z_-]+>)@)"
)

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "AWS_KEY",
        re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}(?::[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?"),
    ),
    (
        "AWS_SECRET",
        re.compile(
            r"(?:aws_secret_access_key|SecretAccessKey|AWS_SECRET_ACCESS_KEY)"
            r"[\s=:\"']+([A-Za-z0-9/+=]{40})",
            re.IGNORECASE,
        ),
    ),
    ("GITHUB_TOKEN", re.compile(r"(?:ghp|gho|ghs|ghu|ghr)_[a-zA-Z0-9]{36,}")),
    ("GITHUB_PAT", re.compile(r"github_pat_[a-zA-Z0-9_]{22,}")),
    (
        "GITHUB_URL_TOKEN",
        re.compile(
            r"x-access-token:" + _NOT_ONLY_A_PLACEHOLDER + r"(?:[^\s@:\"']+|[^\s@\"']{1,512})@"
        ),
    ),
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        ),
    ),
    ("SLACK_TOKEN", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("BEARER_TOKEN", re.compile(r"Bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*", re.IGNORECASE)),
    (
        "CONNECTION_STRING",
        re.compile(
            r"[a-zA-Z][a-zA-Z0-9+.-]{0,20}://"
            r"(?:[^\s:/\"']*:" + _NOT_ONLY_A_PLACEHOLDER + r"(?:[^\s@/\"']+"
            r"|(?!(?:[^\s@/\"']*\]:)?[0-9]{1,5}/(?:[^\s@:\"']*/)?@)"
            r"(?:[^\s@:\"']+|[^\s@\"']{1,256}))"
            r"|[^\s:/\"']*\[REDACTED-AWS_KEY\](?::?[^\s@:\"'\[]*|[^\s@\"']{0,256}))"
            r"@[^\s\"']+"
        ),
    ),
    ("GITHUB_APP_TOKEN", re.compile(r"ghs_[0-9]+_eyJ(?:[A-Za-z0-9._-]+|\[REDACTED-[A-Z_]+\])+")),
    (
        "BEARER_TOKEN",
        re.compile(r"\[REDACTED-BEARER_TOKEN\](?:\[REDACTED-[A-Z_]+\][a-zA-Z0-9\-._~+/=]*)+"),
    ),
]


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
