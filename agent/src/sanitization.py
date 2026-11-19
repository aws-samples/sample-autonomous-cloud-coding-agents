"""Content sanitization for external/untrusted inputs.

Mirrors the TypeScript sanitizeExternalContent() in
cdk/src/handlers/shared/sanitization.ts. Both implementations
must produce identical output for the same input. No shared fixture
checks that: change the two together and give both the same test cases.

Applied to: memory records (before hashing on write, before injection
on read), GitHub issue/PR content (TS side only — Python agent receives
already-sanitized content from the orchestrator's hydrated context).
"""

import re
from collections.abc import Callable
from functools import partial

# The opener of a tag whose content is stripped with it: the name and everything up to
# the next ">".
_DANGEROUS_OPENER = re.compile(
    r"<(script|style|iframe|object|embed|form|input)[^>]*>", re.IGNORECASE
)
# A dangerous opener and everything up to the first closing tag of its name.
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

# How many passes _strip_until_stable makes over one text. Ordinary text is stable after
# two (the second finds nothing); only tags nested as fragments, so that each pass
# completes the next one, need more.
_MAX_STRIP_PASSES = 20
# What stands for the part of a text that _strip_until_stable gives up; the steps after
# the tag stripping leave it as it is. The same in sanitization.ts.
_NESTED_TAGS_MARKER = "[SANITIZED_NESTED_TAGS]"


def _strip_dangerous_tags(text: str) -> str:
    """One pass over the dangerous tags of *text*.

    Every opener goes, with everything up to the first closing tag of its name when one
    follows, and alone when none does. That is one ``sub`` of "_DANGEROUS_PAIR, or else
    _DANGEROUS_OPENER", in time proportional to the length: a search for a closing tag
    that fails has read to the end of the text and would fail again for every later
    opener of the same name, so it is made once per name.
    """
    unclosed: set[str] = set()
    kept: list[str] = []
    start = 0
    while opener := _DANGEROUS_OPENER.search(text, start):
        end = opener.end()
        # lower(), not casefold(): the pattern compares a closing tag with the opener's
        # name letter by letter in lower case, and casefold() would take for one name
        # two spellings that are closed by different closing tags.
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
    """Apply the tag-stripping pass *strip* repeatedly until the string stops changing.

    A single pass can be bypassed by nesting fragments
    (e.g. "<scrip<script></script>t>" reassembles after inner tag removal).

    The work is proportional to the length of the text:

    - A pass sees the text up to its last ">" only. Every tag ends with a ">", so
      nothing behind the last one is a tag, and a pattern would read that rest once
      per "<" in it.
    - The passes are limited. A text that the last of _MAX_STRIP_PASSES still changes
      is given up: a tag that only a later pass completes would otherwise stay in it.
      Every tag starts at a "<", so what stands before the first "<" that is left can
      change no more: that part is kept and _NESTED_TAGS_MARKER stands for the rest;
      a text with no "<" left is complete. A "<" that starts no tag is no exception:
      it can start one after a removal, as the first of "<<b>a>" does.
    """
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

    Neutralizes rather than blocks — suspicious patterns are replaced with
    bracketed markers so content is still visible to the LLM (for legitimate
    discussion of prompts/instructions) but structurally defanged.

    The exception is a text whose tags are not gone after _MAX_STRIP_PASSES passes:
    it is cut at its first "<" (see _strip_until_stable).
    """
    if not text:
        return text or ""
    # Invisible characters go first: removed last, one of them inside a tag,
    # a prefix or a phrase would hide it from the patterns below.
    s = _CONTROL_CHARS.sub("", text)
    s = _BIDI_CHARS.sub("", s)
    s = _MISPLACED_BOM.sub("", s)
    s = _strip_until_stable(s, _strip_dangerous_tags)
    s = _strip_until_stable(s, partial(_HTML_TAGS.sub, ""))
    s = _INSTRUCTION_PREFIXES.sub(r"[SANITIZED_PREFIX] \1:", s)
    return _INJECTION_PHRASES.sub("[SANITIZED_INSTRUCTION]", s)
