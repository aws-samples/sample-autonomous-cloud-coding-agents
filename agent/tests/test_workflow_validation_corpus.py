"""Workflow validation parity — agent side.

Loads every ``contracts/workflow-validation/*.json`` fixture and asserts that
``workflow.validate_workflow(fixture.workflow)`` returns exactly the fixture's
``expected`` violation set. This is the golden contract that a Phase-4 (#246)
second validator implementation must also reproduce — mirroring the
cross-engine pattern in ``test_cedar_parity.py``.

If the validator and a fixture disagree, CI fails before the change ships:
either the validator regressed, or the fixture must be updated as a recorded
decision. See ``contracts/workflow-validation/README.md`` and WORKFLOWS.md
§"Single source of truth and validator parity".
"""

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
    """Reject malformed fixtures at load so bad data fails loud, not silently."""
    for required in ("name", "workflow", "expected"):
        if required not in fixture:
            raise AssertionError(f"{path.name}: missing required field {required!r}")
    expected = fixture["expected"]
    if "valid" not in expected or "violations" not in expected:
        raise AssertionError(f"{path.name}: expected missing valid/violations")
    violations = expected["violations"]
    # valid must be consistent with the violations list — a fixture that says
    # valid:true with a non-empty list (or vice versa) is itself a bug.
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
    """Guard against a silent empty-glob regression."""
    assert _FIXTURE_DIR.is_dir()
    assert len(_FIXTURES) >= 1


def test_corpus_covers_each_valid_and_invalid() -> None:
    """The corpus must contain at least one valid and one invalid fixture."""
    valids = [f for f in _FIXTURES if f["expected"]["valid"]]
    invalids = [f for f in _FIXTURES if not f["expected"]["valid"]]
    assert valids, "corpus must include at least one valid workflow"
    assert invalids, "corpus must include at least one invalid workflow"
