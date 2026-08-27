"""Semver RESOLUTION-ranking parity corpus runner (Python side) (#246).

Loads ``contracts/registry-resolution/resolution-cases.json`` and asserts the
Python ``registry.resolver.select_highest`` picks the golden winner for each
(candidates, constraint). The TypeScript runner
(``cdk/test/handlers/shared/registry-resolution-ranking-parity.test.ts``) runs
the same file against ``selectHighest``; both must agree, so caret/tilde/
prerelease ranking cannot drift between the API path (TS) and the orchestrator's
direct port path (Python).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from registry.ref import parse_constraint
from registry.resolver import select_highest

_CASES_FILE = (
    Path(os.path.dirname(__file__))
    / ".."
    / ".."
    / "contracts"
    / "registry-resolution"
    / "resolution-cases.json"
).resolve()


def _load_cases() -> list[dict]:
    assert _CASES_FILE.is_file(), (
        f"expected corpus at {_CASES_FILE}; see contracts/registry-resolution/README.md"
    )
    data = json.loads(_CASES_FILE.read_text(encoding="utf-8"))
    cases = data["cases"]
    assert cases, "corpus has no cases; at least one is required"
    return cases


_CASES = _load_cases()


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_select_highest_matches_fixture(case: dict) -> None:
    constraint = parse_constraint(case["constraint"])
    assert constraint is not None, f"{case['name']}: constraint should parse"
    winner = select_highest(case["candidates"], constraint)
    assert winner == case["winner"], (
        f"{case['name']}: winner drift — got {winner!r}, expected {case['winner']!r}"
    )


def test_corpus_present_and_nonempty() -> None:
    assert _CASES_FILE.is_file()
    assert len(_CASES) >= 1
