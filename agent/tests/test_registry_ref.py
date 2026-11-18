"""Unit tests for registry.ref on inputs where Python and JavaScript differ.

``parse_ref`` has to give the verdict of its TypeScript mirror
(``cdk/src/handlers/shared/registry/ref.ts``) for every string. The parity corpus
(``contracts/registry-resolution/cases.json``) holds the cases both parsers run;
these are inputs it does not hold, on which the two regular-expression dialects or
the two number types differ. The expected reasons are what ``parseRef`` answers.
"""

from __future__ import annotations

import pytest

from registry.ref import RefError, parse_ref

_REF = "registry://mcp_server/acme/pdf-tools@"


def _reason(ref: str) -> str:
    with pytest.raises(RefError) as exc:
        parse_ref(ref)
    return exc.value.reason


class TestSameVerdictAsTheTypeScriptParser:
    def test_a_digit_outside_ascii_is_not_a_version_digit(self):
        # U+0662 ARABIC-INDIC DIGIT TWO. In Python, \d matches it and int() converts
        # it (minor 12); in JavaScript, \d is 0-9 only.
        assert _reason(_REF + "1.1\u0662.0") == "INVALID_CONSTRAINT"

    @pytest.mark.parametrize(
        "terminator", ["\r", "\u2028", "\u2029"], ids=["CR", "U+2028", "U+2029"]
    )
    def test_a_trailing_line_terminator_is_a_bad_ref_not_a_bad_constraint(self, terminator):
        # In JavaScript the dot matches none of the four line terminators; in Python
        # it stops at the line feed only, so the constraint used to swallow these.
        assert _reason(_REF + "1.0.0" + terminator) == "INVALID_REGISTRY_REF"

    def test_a_component_too_long_for_int_is_a_bad_constraint(self):
        # int() refuses a string of more than 4300 digits with a plain ValueError,
        # which carries no reason. In JavaScript the component is Infinity, not a
        # safe integer.
        assert _reason(_REF + "1." + "9" * 4301 + ".0") == "INVALID_CONSTRAINT"
