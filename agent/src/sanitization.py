"""Content sanitization for external/untrusted inputs.

Mirrors the TypeScript sanitizeExternalContent() in
cdk/src/handlers/shared/sanitization.ts. Both implementations
must produce identical output for the same input — cross-language
parity is verified by shared test fixtures.

Applied to: memory records (before hashing on write, before injection
on read), GitHub issue/PR content (TS side only — Python agent receives
already-sanitized content from the orchestrator's hydrated context).
"""

import re

_DANGEROUS_TAGS = re.compile(
    r"(<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?</\2>"
    r"|<(script|style|iframe|object|embed|form|input)[^>]*\/?>)",
    re.IGNORECASE,
)
_HTML_TAGS = re.compile(r"</?[a-z][^>]*>", re.IGNORECASE)
_INSTRUCTION_PREFIXES = re.compile(r"^(SYSTEM|ASSISTANT|Human)\s*:", re.MULTILINE | re.IGNORECASE)
_INJECTION_PHRASES = re.compile(
    r"(?:ignore previous instructions|disregard (?:above|previous|all)|new instructions\s*:)",
    re.IGNORECASE,
)
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_BIDI_CHARS = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_MISPLACED_BOM = re.compile(r"(?!^)\ufeff")


def _strip_until_stable(s: str, pattern: re.Pattern[str]) -> str:
    """Apply *pattern* repeatedly until the string stops changing.

    A single pass can be bypassed by nesting fragments
    (e.g. "<scrip<script></script>t>" reassembles after inner tag removal).
    """
    while True:
        prev = s
        s = pattern.sub("", s)
        if s == prev:
            return s


def sanitize_external_content(text: str | None) -> str:
    """Sanitize external content before it enters the agent's context.

    Neutralizes rather than blocks — suspicious patterns are replaced with
    bracketed markers so content is still visible to the LLM (for legitimate
    discussion of prompts/instructions) but structurally defanged.
    """
    if not text:
        return text or ""
    s = _strip_until_stable(text, _DANGEROUS_TAGS)
    s = _strip_until_stable(s, _HTML_TAGS)
    s = _INSTRUCTION_PREFIXES.sub(r"[SANITIZED_PREFIX] \1:", s)
    s = _INJECTION_PHRASES.sub("[SANITIZED_INSTRUCTION]", s)
    s = _CONTROL_CHARS.sub("", s)
    s = _BIDI_CHARS.sub("", s)
    s = _MISPLACED_BOM.sub("", s)
    return s
