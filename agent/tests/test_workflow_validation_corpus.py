from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from workflow import validate_workflow

_FIXTURE_DIR = (
    Path(os.path.dirname(__file__)) / ".." / ".." / "contracts" / "workflow-validation"
).resolve()


def _validate_fixture_shape(fixture: dict, path: Path) -> None:
    for required in ("name", "workflow", "expected"):
        if required not in fixture:
            raise AssertionError(f"{path.name}: missing required field {required!r}")
    expected = fixture["expected"]
    if "valid" not in expected or "violations" not in expected:
        raise AssertionError(f"{path.name}: expected missing valid/violations")
    violations = expected["violations"]
    if expected["valid"] != (len(violations) == 0):
        raise AssertionError(
            f"{path.name}: expected.valid={expected['valid']} is inconsistent with "
            f"violations={violations}"
        )


def _load_fixtures() -> list[dict]:
    assert _FIXTURE_DIR.is_dir(), (
        f"expected fixture dir at {_FIXTURE_DIR}; see contracts/workflow-validation/README.md"
    )
    fixtures = []
    for path in sorted(_FIXTURE_DIR.glob("*.json")):
        fixture = json.loads(path.read_text(encoding="utf-8"))
        _validate_fixture_shape(fixture, path)
        fixtures.append(fixture)
    assert fixtures, f"no fixtures under {_FIXTURE_DIR}; at least one golden file is required"
    return fixtures


_FIXTURES = _load_fixtures()


@pytest.mark.parametrize("fixture", _FIXTURES, ids=[f["name"] for f in _FIXTURES])
def test_validator_matches_fixture(fixture: dict) -> None:
    observed = sorted(validate_workflow(fixture["workflow"]))
    expected = sorted(fixture["expected"]["violations"])
    assert observed == expected, (
        f"fixture {fixture['name']!r}: verdict drift — validator returned "
        f"{observed!r}, fixture expects {expected!r}"
    )


def test_fixture_dir_present_and_nonempty() -> None:
    assert _FIXTURE_DIR.is_dir()
    assert len(_FIXTURES) >= 1


def test_corpus_covers_each_valid_and_invalid() -> None:
    valids = [f for f in _FIXTURES if f["expected"]["valid"]]
    invalids = [f for f in _FIXTURES if not f["expected"]["valid"]]
    assert valids, "corpus must include at least one valid workflow"
    assert invalids, "corpus must include at least one invalid workflow"
