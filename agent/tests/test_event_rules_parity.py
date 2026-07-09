"""Cross-language parity for event rule fixtures (issue #230)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from event_governance.evaluator import match_rules, parse_rules

FIXTURES = Path(__file__).resolve().parents[1] / "event-rules" / "fixtures"


def _fixture_paths() -> list[Path]:
    return sorted(FIXTURES.glob("*.json"))


@pytest.mark.parametrize("fixture_path", _fixture_paths(), ids=lambda p: p.stem)
def test_event_rules_parity(fixture_path: Path) -> None:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    rules = parse_rules(fixture["rules"])
    matched = [
        r.id
        for r in match_rules(
            rules,
            event_type=fixture["event"]["event_type"],
            metadata=fixture["event"].get("metadata", {}),
            aggregate_state=fixture.get("aggregate_state"),
        )
    ]
    assert sorted(matched) == sorted(fixture["expected_matches"])
