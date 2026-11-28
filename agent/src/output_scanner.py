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

# Where the password of a URL would stand: not a placeholder and nothing else.
# The placeholders are {name} and ${NAME}, also with doubled braces, %s, %v,
# %(name)s and <name>. A name is letters, "_" and "."; in <name> it is small
# letters or capitals, not both, "_" and "-". A digit is taken only as a
# positional argument, {0}. That keeps out a password that somebody left the
# brackets of a placeholder around (MongoDB Atlas hands out "<password>"):
# it usually holds a digit or mixes small letters and capitals. A URL with a
# placeholder for a password is a template in source code or documentation,
# not a credential, and is left as it is: the agent reads files through this
# scanner, and a marker in place of such a line would keep it from editing the
# line and could end up in what it writes. Forms that a real password can have
# are not among them ($NAME, [name], a plain word), and a password that only
# begins or ends with a placeholder is replaced as before.
_NOT_ONLY_A_PLACEHOLDER = (
    r"(?!(?:\$?(?:\{[A-Za-z_.]*\}|\{[0-9]{1,2}\}|\{\{[A-Za-z_.]*\}\})"
    r"|%[sv]|%\([A-Za-z_.]+\)s|<[a-z_-]+>|<[A-Z_-]+>)@)"
)

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # AWS access key IDs: long-term (AKIA) and temporary (ASIA). A secret access
    # key that follows the id after a colon goes with it (<id>:<secret>, in a
    # URL or not). CONNECTION_STRING counts on this pattern running first.
    (
        "AWS_KEY",
        re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}(?::[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?"),
    ),
    # AWS secret access keys (40-char base64 near common keywords)
    (
        "AWS_SECRET",
        re.compile(
            r"(?:aws_secret_access_key|SecretAccessKey|AWS_SECRET_ACCESS_KEY)"
            r"[\s=:\"']+([A-Za-z0-9/+=]{40})",
            re.IGNORECASE,
        ),
    ),
    # GitHub tokens (PAT, OAuth, App, user-to-server, refresh, fine-grained).
    # Length is variable across token generations — match 36+ chars rather
    # than exactly 36 so newer/longer formats are still caught.
    ("GITHUB_TOKEN", re.compile(r"(?:ghp|gho|ghs|ghu|ghr)_[a-zA-Z0-9]{36,}")),
    ("GITHUB_PAT", re.compile(r"github_pat_[a-zA-Z0-9_]{22,}")),
    # Credentials embedded in git remote URLs (https://x-access-token:TOKEN@github.com/...).
    # The agent authenticates via env-based credential helper, but tool output
    # may still echo such URLs from other sources. A token holds no ":" and has
    # no length limit (GitHub App tokens are about 520 characters since 2026,
    # and vary). Any other text before the "@" counts up to 512 characters:
    # unlimited, a text that repeats "x-access-token:" is scanned from each
    # one to the end of the run, which is quadratic.
    (
        "GITHUB_URL_TOKEN",
        re.compile(
            r"x-access-token:" + _NOT_ONLY_A_PLACEHOLDER + r"(?:[^\s@:\"']+|[^\s@\"']{1,512})@"
        ),
    ),
    # Private keys (PEM blocks)
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        ),
    ),
    # Slack tokens (xoxb-, xoxp-, ...)
    ("SLACK_TOKEN", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    # Linear personal API keys (lin_api_), OAuth access and refresh tokens
    # (lin_oauth_, lin_refresh_) and webhook signing secrets (lin_wh_).
    ("LINEAR_TOKEN", re.compile(r"\blin_(?:api|oauth|refresh|wh)_[A-Za-z0-9]{16,}")),
    # Generic Bearer / token patterns (min 20-char token to avoid false positives
    # on natural English like "bearer of good news")
    ("BEARER_TOKEN", re.compile(r"Bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*", re.IGNORECASE)),
    # Connection strings with embedded passwords (protocol name capped at 20
    # chars to avoid quadratic backtracking on long alphabetic strings). The
    # user and the password hold no whitespace and no quote, so a URL is not
    # matched up to a ":" and an "@" that merely follow it in the text. The
    # user holds no "/", may hold an "@" (an e-mail address as login) and may
    # be empty (redis://:<password>@host); the password holds no "@". The
    # password has three alternatives: text without "/", text without ":"
    # (base64 text holds "/" and no ":"), and any other text of up to 256
    # characters: without that bound, a text that repeats "x://" is scanned
    # from each one to the end of the run, which is quadratic. The look-ahead
    # in front of the last two keeps a URL without a password as it is when
    # its host has a port and the first "@" behind the port begins a path
    # segment (https://host:8443/@scope/package): there the ":" stands
    # between the host and the port (1 to 5 digits, also behind the rest of
    # an IPv6 address, "]:"). It reads from the port to that segment only
    # while no further ":" comes, which keeps the scan linear as well.
    # Only the user and the password are replaced, and the query and the
    # fragment, which can hold a secret as well (AWS_SESSION_TOKEN:... in a
    # MongoDB URL): the scheme, the "@", the host and the path stay, so a
    # reader still sees where the URL points (see _connection_string_marker).
    # Second form: the user ends in the marker that AWS_KEY has put there.
    # What follows up to the "@" (the rest of a password, or ":" and a
    # password or session token) may have any length while it holds no
    # further ":" and no "["; any other text counts up to 256 characters.
    # Without this form the rest of such a URL, with any secret in it, would
    # stay readable. The limit, and the stop at "[" (where the next marker
    # would begin), keep the scan linear.
    # The scanner of deny reasons (cdk/src/handlers/shared/deny-reason-scanner.ts)
    # has the same pattern. contracts/secret-scan-vectors.json holds the cases
    # that the tests of both scanners run.
    (
        "CONNECTION_STRING",
        re.compile(
            r"(?P<keep>[a-zA-Z][a-zA-Z0-9+.-]{0,20}://)"
            r"(?:[^\s:/\"']*:" + _NOT_ONLY_A_PLACEHOLDER + r"(?:[^\s@/\"']+"
            r"|(?!(?:[^\s@/\"']*\]:)?[0-9]{1,5}/(?:[^\s@:\"']*/)?@)"
            r"(?:[^\s@:\"']+|[^\s@\"']{1,256}))"
            r"|[^\s:/\"']*\[REDACTED-AWS_KEY\](?::?[^\s@:\"'\[]*|[^\s@\"']{0,256}))"
            r"@(?=[^\s\"'])(?P<host>[^\s\"'?#]*)(?P<query>[?#][^\s\"']*)?"
        ),
    ),
    # GitHub App installation tokens of the stateless format that GitHub issues
    # since 2026: ghs_<app id>_<JWT>, about 520 characters. The JWT is known by
    # its first characters, "eyJ"; its three base64url parts and the dots
    # between them are taken as one run, which keeps the scan linear. Behind
    # the patterns above on purpose: they meet the text they met before this
    # one was added, so what they replace (such a token after "Bearer", in a
    # git URL or as the password of a URL) stays as it was, and this one takes
    # the tokens they leave. A token runs on through a marker: its signature
    # is random text, and where that holds by chance what a pattern above
    # replaces (36 letters and digits behind "ghp_", say), the marker of that
    # pattern stands inside the token, with the rest of the token behind it.
    ("GITHUB_APP_TOKEN", re.compile(r"ghs_[0-9]+_eyJ(?:[A-Za-z0-9._-]+|\[REDACTED-[A-Z_]+\])+")),
    # The rest of a bearer token. What stands behind "Bearer" ends in random
    # text as well (the signature of a JWT). Where a pattern above has put its
    # marker inside such a token, the Bearer pattern stopped at that marker.
    # This entry takes the Bearer marker, each marker that follows it directly
    # and the characters of a bearer token behind it, and leaves the one
    # Bearer marker, which is why it has that pattern's label. Last, so that
    # each pattern above meets the text it met before.
    (
        "BEARER_TOKEN",
        re.compile(r"\[REDACTED-BEARER_TOKEN\](?:\[REDACTED-[A-Z_]+\][a-zA-Z0-9\-._~+/=]*)+"),
    ),
]


def _connection_string_marker(match: re.Match[str]) -> str:
    """``scheme://[REDACTED-CONNECTION_STRING]@host/path``, and a marker for a query."""
    marker = "[REDACTED-CONNECTION_STRING]"
    query = match.group("query")
    tail = query[0] + marker if query else ""
    return f"{match.group('keep')}{marker}@{match.group('host')}{tail}"


# What a pattern's match is replaced by, where it is not ``[REDACTED-<label>]``.
_REPLACEMENTS = {"CONNECTION_STRING": _connection_string_marker}

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
            replace = _REPLACEMENTS.get(label, lambda _m, label=label: f"[REDACTED-{label}]")
            redacted = pattern.sub(replace, redacted)

    elapsed_ms = (time.monotonic() - start) * 1000
    return ScanResult(
        has_sensitive_content=len(findings) > 0,
        redacted_content=redacted,
        findings=findings,
        duration_ms=elapsed_ms,
    )
