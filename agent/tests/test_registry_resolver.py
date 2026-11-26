from __future__ import annotations

from registry.ref import ParsedConstraint, parse_constraint
from registry.resolver import parse_version, satisfies, select_highest


def _constraint(raw: str) -> ParsedConstraint:
    constraint = parse_constraint(raw)
    assert constraint is not None, f"fixture constraint should parse: {raw}"
    return constraint


class TestExactPin:
    def test_a_version_that_only_compares_equal_does_not_satisfy_the_pin(self):
        twin = parse_version("1.0.0-rc.01")
        pinned = parse_version("1.0.0-rc.1")
        assert twin is not None
        assert pinned is not None
        assert satisfies(twin, _constraint("1.0.0-rc.1")) is False
        assert satisfies(pinned, _constraint("1.0.0-rc.1")) is True

    def test_the_pinned_version_wins_whatever_the_order_of_the_candidates(self):
        assert (
            select_highest(["1.0.0-rc.01", "1.0.0-rc.1"], _constraint("1.0.0-rc.1")) == "1.0.0-rc.1"
        )
        assert (
            select_highest(["1.0.0-rc.1", "1.0.0-rc.01"], _constraint("1.0.0-rc.01"))
            == "1.0.0-rc.01"
        )


class TestCandidatesTheTypeScriptResolverSkips:
    def test_a_digit_outside_ascii_is_not_a_version_digit(self):
        assert parse_version("1.1\u0662.0") is None
        assert select_highest(["1.0.0", "1.1\u0662.0"], _constraint("^1.0.0")) == "1.0.0"

    def test_a_component_too_long_for_int_is_skipped(self):
        # int() refuses more than 4300 digits with a ValueError.
        assert parse_version("1." + "9" * 4301 + ".0") is None


class TestNumericPrereleaseIdentifiers:
    def test_identifiers_above_two_to_the_53_are_compared_exactly(self):
        # As doubles these two are the same value.
        candidates = ["1.0.0-9007199254740992", "1.0.0-9007199254740993"]
        assert select_highest(candidates, _constraint("^1.0.0-0")) == "1.0.0-9007199254740993"

    def test_an_identifier_too_long_for_int_is_compared_not_raised(self):
        # int() refuses more than 4300 digits with a ValueError.
        assert select_highest(["1.0.0-5"], _constraint("^1.0.0-" + "9" * 4301)) is None
