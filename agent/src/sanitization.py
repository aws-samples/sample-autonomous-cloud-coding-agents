import re
from collections.abc import Callable
from functools import partial

_DANGEROUS_OPENER = re.compile(
    r"<(script|style|iframe|object|embed|form|input)[^>]*>", re.IGNORECASE
)
_DANGEROUS_PAIR = re.compile(
    r"<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?</\1>", re.IGNORECASE
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

_MAX_STRIP_PASSES = 20
_NESTED_TAGS_MARKER = "[SANITIZED_NESTED_TAGS]"


def _strip_dangerous_tags(text: str) -> str:
    unclosed: set[str] = set()
    kept: list[str] = []
    start = 0
    while opener := _DANGEROUS_OPENER.search(text, start):
        end = opener.end()
        # lower(), not casefold(): under IGNORECASE "<\u017fcript>" (long s) is an
        # opener, but its ``\1`` matches "</\u017fcript>" and not "</script>".
        name = opener.group(1).lower()
        if name not in unclosed:
            pair = _DANGEROUS_PAIR.match(text, opener.start())
            if pair:
                end = pair.end()
            else:
                unclosed.add(name)
        kept.append(text[start : opener.start()])
        start = end
    kept.append(text[start:])
    return "".join(kept)


def _strip_until_stable(s: str, strip: Callable[[str], str]) -> str:
    for _ in range(_MAX_STRIP_PASSES):
        end = s.rfind(">") + 1
        head = s[:end]
        stripped = strip(head)
        if stripped == head:
            return s
        s = stripped + s[end:]
    first = s.find("<")
    return s if first < 0 else s[:first] + _NESTED_TAGS_MARKER


def sanitize_external_content(text: str | None) -> str:
    """Sanitize external content before it enters the agent's context.

    Neutralizes rather than blocks: suspicious patterns are replaced with
    bracketed markers. The exception is a text whose tags are not gone after
    _MAX_STRIP_PASSES passes: it is cut at its first "<".
    """
    if not text:
        return text or ""
    s = _CONTROL_CHARS.sub("", text)
    s = _BIDI_CHARS.sub("", s)
    s = _MISPLACED_BOM.sub("", s)
    s = _strip_until_stable(s, _strip_dangerous_tags)
    s = _strip_until_stable(s, partial(_HTML_TAGS.sub, ""))
    s = _INSTRUCTION_PREFIXES.sub(r"[SANITIZED_PREFIX] \1:", s)
    return _INJECTION_PHRASES.sub("[SANITIZED_INSTRUCTION]", s)
