"""Cedar cross-engine parity — agent side (cedarpy).

Loads every ``contracts/cedar-parity/*.json`` fixture, runs each
``(policies, input)`` through ``cedarpy.is_authorized``, and asserts the
observed ``(decision, matching_rule_ids)`` equals the fixture's
``expected`` payload.

The companion test ``cdk/test/handlers/shared/cedar-parity.test.ts`` runs
the same fixtures through ``@cedar-policy/cedar-wasm``. If either side
disagrees with the fixture, CI fails BEFORE deploy — satisfying the
cross-engine parity contract (decision #23, finding #1, §15.6 of
``docs/design/CEDAR_HITL_GATES.md``).

Fixture path resolution mirrors the pattern in
``test_prompts.py::TestCrossLanguageHashParity`` for
``contracts/memory-hash-vectors.json``.
"""

import json
import os
from pathlib import Path

# Hard import (not importorskip): the parity contract REQUIRES cedarpy.
# A dependency regression that drops cedarpy must fail loudly, not be
# silently skipped — skipping would let divergence reach production.
# See silent-failure audit finding #8 (Chunk 1 review, 2026-05-07).
import cedarpy
import pytest

_FIXTURE_DIR = Path(os.path.dirname(__file__)) / ".." / ".." / "contracts" / "cedar-parity"
_FIXTURE_DIR = _FIXTURE_DIR.resolve()

_VALID_DECISIONS = frozenset({"allow", "deny"})


def _validate_fixture(fixture: dict, path: Path) -> None:
    """Reject malformed fixtures at load time so bad data fails loud."""
    for required in ("name", "policies", "input", "expected"):
        if required not in fixture:
            raise AssertionError(f"{path.name}: missing required field {required!r}")
    for required in ("principal", "action", "resource"):
        if required not in fixture["input"]:
            raise AssertionError(f"{path.name}: input missing {required!r}")
    expected = fixture["expected"]
    if "decision" not in expected or "matching_rule_ids" not in expected:
        raise AssertionError(f"{path.name}: expected missing decision/matching_rule_ids")
    # Enforce lowercase canonical form — both engines report lowercase
    # natively (cedar-wasm) or are normalized on read (cedarpy via .value.lower()).
    # Rejecting case drift at load prevents a fixture author from writing
    # "Deny" and having only one engine's comparator hit the case-mismatch.
    if expected["decision"] not in _VALID_DECISIONS:
        raise AssertionError(
            f"{path.name}: decision must be lowercase in {_VALID_DECISIONS}, "
            f"got {expected['decision']!r}"
        )


def _load_fixtures() -> list[dict]:
    """Load every parity fixture; skip README.md."""
    assert _FIXTURE_DIR.is_dir(), (
        f"expected fixture dir at {_FIXTURE_DIR}; see contracts/cedar-parity/README.md"
    )
    fixtures = []
    for path in sorted(_FIXTURE_DIR.glob("*.json")):
        with path.open() as f:
            fixture = json.load(f)
        _validate_fixture(fixture, path)
        fixtures.append(fixture)
    assert fixtures, f"no fixtures found under {_FIXTURE_DIR}; at least one golden file is required"
    return fixtures


def _entity_uid(entity_ref: dict) -> str:
    """Format an entity reference dict as a Cedar UID string literal."""
    return f'{entity_ref["type"]}::"{entity_ref["id"]}"'


def _build_entities(fixture_input: dict) -> list[dict]:
    """Build cedarpy's entities list from principal/action/resource references.

    Includes ``action`` so the two engines receive equivalent entity sets;
    cedarpy tolerates undeclared actions today but the TS side passes an
    empty entities list — keeping both sides symmetric prevents silent
    asymmetric failures if a future fixture attaches attributes to the
    action entity. See silent-failure audit finding #3.
    """
    entities = []
    for key in ("principal", "action", "resource"):
        ref = fixture_input.get(key)
        if ref and isinstance(ref, dict) and "type" in ref and "id" in ref:
            entities.append(
                {
                    "uid": {"type": ref["type"], "id": ref["id"]},
                    "attrs": {},
                    "parents": [],
                }
            )
    return entities


def _build_request(fixture_input: dict) -> dict:
    """Translate the fixture input into the cedarpy is_authorized request shape."""
    return {
        "principal": _entity_uid(fixture_input["principal"]),
        "action": _entity_uid(fixture_input["action"]),
        "resource": _entity_uid(fixture_input["resource"]),
        "context": fixture_input.get("context", {}),
    }


def _recover_rule_ids(policies: str, matching_policy_ids: list[str]) -> list[str]:
    """Map engine-internal positional IDs (policy0, ...) back to @rule_id annotations.

    Enforces that EVERY matching policy must carry a ``@rule_id`` annotation.
    Dropping unannotated matches would silently hide genuine cross-engine
    disagreement (e.g. one engine matching the base ``permit`` alongside a
    ``forbid``) — the whole point of this test is to fail such disagreement,
    not bury it. See silent-failure audit finding #1 (Chunk 1 review,
    2026-05-07). Fixture policies are expected to annotate every rule
    including the base permit (``@rule_id("base_permit")``); a missing
    annotation raises rather than silently coerces to empty.
    """
    try:
        parsed = json.loads(cedarpy.policies_to_json_str(policies))
    except Exception as exc:
        raise AssertionError(
            f"cedarpy.policies_to_json_str returned an unparseable result: "
            f"{type(exc).__name__}: {exc}"
        ) from exc
    id_map = {
        pid: body.get("annotations", {}).get("rule_id")
        for pid, body in parsed.get("staticPolicies", {}).items()
    }
    recovered = []
    for pid in matching_policy_ids:
        rule_id = id_map.get(pid)
        if not rule_id:
            raise AssertionError(
                f"cedarpy matched policy {pid!r} but the fixture's policies define "
                f"no @rule_id annotation for it; every fixture policy (including the "
                f"base permit) must carry a rule_id so cross-engine disagreement "
                f"surfaces rather than being silently dropped"
            )
        recovered.append(rule_id)
    return sorted(recovered)


_FIXTURES = _load_fixtures()


@pytest.mark.parametrize("fixture", _FIXTURES, ids=[f["name"] for f in _FIXTURES])
def test_cedarpy_matches_fixture_decision(fixture: dict) -> None:
    """cedarpy's decision + recovered rule IDs must match the fixture's expected payload."""
    policies = fixture["policies"]
    request = _build_request(fixture["input"])
    entities = _build_entities(fixture["input"])

    result = cedarpy.is_authorized(request, policies, entities)

    # cedarpy decision enum: Decision.Allow / Decision.Deny.  Fixture stores
    # lowercase to match cedar-wasm's native format; normalize before compare.
    # Fixture-side case was already validated at load (see _validate_fixture).
    observed_decision = result.decision.value.lower()
    expected_decision = fixture["expected"]["decision"]
    assert observed_decision == expected_decision, (
        f"fixture {fixture['name']!r}: decision drift — "
        f"cedarpy returned {observed_decision!r}, fixture expects {expected_decision!r}"
    )

    observed_rule_ids = _recover_rule_ids(policies, result.diagnostics.reasons)
    expected_rule_ids = sorted(fixture["expected"]["matching_rule_ids"])
    assert observed_rule_ids == expected_rule_ids, (
        f"fixture {fixture['name']!r}: matching_rule_ids drift — "
        f"cedarpy returned {observed_rule_ids!r}, fixture expects {expected_rule_ids!r}"
    )


def test_fixture_dir_exists() -> None:
    """Guard against silent empty-dir regressions if glob picks up nothing."""
    assert _FIXTURE_DIR.is_dir()
    assert len(_FIXTURES) >= 1
