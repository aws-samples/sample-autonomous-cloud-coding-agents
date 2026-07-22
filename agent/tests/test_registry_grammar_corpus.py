"""Registry URI grammar parity — agent side (#246).

Loads every ``contracts/registry-resolution/grammar-*.json`` fixture and asserts
that ``workflow.is_registry_ref(ref)`` agrees with the fixture's ``expected.valid``.
This is the golden contract that the TypeScript ``parseRef``
(cdk/src/handlers/shared/registry-resolver.ts) must also reproduce — mirroring
the cross-engine pattern in ``test_cedar_parity.py`` and the workflow-validation
corpus.

If the regex and a fixture disagree, CI fails before the change ships: either
the grammar regressed, or the fixture must be updated as a recorded decision.
See ``contracts/registry-resolution/README.md`` and REGISTRY.md §6.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from workflow import is_registry_ref

_FIXTURE_DIR = (
    Path(os.path.dirname(__file__)) / ".." / ".." / "contracts" / "registry-resolution"
).resolve()


def _load_grammar_fixtures() -> list[dict]:
    assert _FIXTURE_DIR.is_dir(), (
        f"expected fixture dir at {_FIXTURE_DIR}; "
        "see contracts/registry-resolution/README.md"
    )
    fixtures = []
    for path in sorted(_FIXTURE_DIR.glob("grammar-*.json")):
        fixture = json.loads(path.read_text(encoding="utf-8"))
        for required in ("name", "ref", "expected"):
            if required not in fixture:
                raise AssertionError(f"{path.name}: missing required field {required!r}")
        if "valid" not in fixture["expected"]:
            raise AssertionError(f"{path.name}: expected missing 'valid'")
        fixtures.append(fixture)
    assert fixtures, f"no grammar-*.json fixtures under {_FIXTURE_DIR}"
    return fixtures


_FIXTURES = _load_grammar_fixtures()


@pytest.mark.parametrize("fixture", _FIXTURES, ids=[f["name"] for f in _FIXTURES])
def test_grammar_matches_fixture(fixture: dict) -> None:
    observed = is_registry_ref(fixture["ref"])
    expected = fixture["expected"]["valid"]
    assert observed == expected, (
        f"fixture {fixture['name']!r}: grammar drift — is_registry_ref({fixture['ref']!r}) "
        f"returned {observed}, fixture expects {expected}"
    )


def test_corpus_covers_valid_and_invalid() -> None:
    """The corpus must exercise both accept and reject paths."""
    valids = [f for f in _FIXTURES if f["expected"]["valid"]]
    invalids = [f for f in _FIXTURES if not f["expected"]["valid"]]
    assert valids, "grammar corpus must include at least one valid ref"
    assert invalids, "grammar corpus must include at least one invalid ref"
