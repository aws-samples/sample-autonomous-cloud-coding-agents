import json
import os
from pathlib import Path

import cedarpy
import pytest

_FIXTURE_DIR = Path(os.path.dirname(__file__)) / ".." / ".." / "contracts" / "cedar-parity"
_FIXTURE_DIR = _FIXTURE_DIR.resolve()

_VALID_DECISIONS = frozenset({"allow", "deny"})


def _validate_fixture(fixture: dict, path: Path) -> None:
    for required in ("name", "policies", "input", "expected"):
        if required not in fixture:
            raise AssertionError(f"{path.name}: missing required field {required!r}")
    for required in ("principal", "action", "resource"):
        if required not in fixture["input"]:
            raise AssertionError(f"{path.name}: input missing {required!r}")
    expected = fixture["expected"]
    if "decision" not in expected or "matching_rule_ids" not in expected:
        raise AssertionError(f"{path.name}: expected missing decision/matching_rule_ids")
    if expected["decision"] not in _VALID_DECISIONS:
        raise AssertionError(
            f"{path.name}: decision must be lowercase in {_VALID_DECISIONS}, "
            f"got {expected['decision']!r}"
        )


def _load_fixtures() -> list[dict]:
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
    return f'{entity_ref["type"]}::"{entity_ref["id"]}"'


def _build_entities(fixture_input: dict) -> list[dict]:
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
    return {
        "principal": _entity_uid(fixture_input["principal"]),
        "action": _entity_uid(fixture_input["action"]),
        "resource": _entity_uid(fixture_input["resource"]),
        "context": fixture_input.get("context", {}),
    }


def _recover_rule_ids(policies: str, matching_policy_ids: list[str]) -> list[str]:
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
    policies = fixture["policies"]
    request = _build_request(fixture["input"])
    entities = _build_entities(fixture["input"])

    result = cedarpy.is_authorized(request, policies, entities)

    # cedarpy reports "Allow" / "Deny"; cedar-wasm reports the decision in lowercase.
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
    assert _FIXTURE_DIR.is_dir()
    assert len(_FIXTURES) >= 1
