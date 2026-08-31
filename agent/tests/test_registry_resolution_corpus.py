"""Grammar parity corpus runner (Python side) for registry:// refs (#246).

Loads ``contracts/registry-resolution/cases.json`` and asserts the Python parser
(``registry.ref.parse_ref``) agrees with each golden verdict. The TypeScript
runner (``cdk/test/handlers/shared/registry-resolution-parity.test.ts``) runs the
same file against ``parseRef``; both must agree, so the two grammars cannot drift.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from registry.ref import RefError, parse_ref

_CASES_FILE = (
    Path(os.path.dirname(__file__))
    / ".."
    / ".."
    / "contracts"
    / "registry-resolution"
    / "cases.json"
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
def test_parse_matches_fixture(case: dict) -> None:
    ref = case["ref"]
    expected = case["expected"]

    if not expected["ok"]:
        with pytest.raises(RefError) as exc:
            parse_ref(ref)
        assert exc.value.reason == expected["reason"], (
            f"{case['name']}: reason drift — got {exc.value.reason!r}, "
            f"expected {expected['reason']!r}"
        )
        return

    parsed = parse_ref(ref)
    assert parsed.kind == expected["kind"]
    assert parsed.namespace == expected["namespace"]
    assert parsed.name == expected["name"]
    assert parsed.constraint.op == expected["op"]
    assert parsed.constraint.major == expected["major"]
    assert parsed.constraint.minor == expected["minor"]
    assert parsed.constraint.patch == expected["patch"]
    assert parsed.constraint.prerelease == expected["prerelease"]


def test_corpus_present_and_nonempty() -> None:
    assert _CASES_FILE.is_file()
    assert len(_CASES) >= 1
