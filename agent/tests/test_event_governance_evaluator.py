"""Tests for event governance rule matching."""

from __future__ import annotations

import json
from pathlib import Path

from event_governance.evaluator import match_rules, parse_rules

FIXTURES = Path(__file__).resolve().parents[1] / "event-rules" / "fixtures"


def _load_fixture(name: str) -> dict:
    with (FIXTURES / f"{name}.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def test_observe_repo_setup_fixture():
    fx = _load_fixture("observe-repo-setup")
    rules = parse_rules(fx["rules"])
    matched = match_rules(
        rules,
        event_type=fx["event"]["event_type"],
        metadata=fx["event"]["metadata"],
        evaluation="sync",
    )
    assert [r.id for r in matched] == fx["expected_matches"]


def test_async_notify_pr_fixture():
    fx = _load_fixture("async-notify-pr")
    rules = parse_rules(fx["rules"])
    matched = match_rules(
        rules,
        event_type=fx["event"]["event_type"],
        metadata=fx["event"]["metadata"],
        evaluation="async",
    )
    assert [r.id for r in matched] == fx["expected_matches"]


def test_aggregate_cost_cancel_fixture():
    fx = _load_fixture("aggregate-cost-cancel")
    rules = parse_rules(fx["rules"])
    matched = match_rules(
        rules,
        event_type=fx["event"]["event_type"],
        metadata=fx["event"]["metadata"],
        evaluation="async",
        aggregate_state=fx.get("aggregate_state"),
    )
    assert [r.id for r in matched] == fx["expected_matches"]


def test_when_fields_no_match():
    rules = parse_rules(
        [
            {
                "id": "x",
                "on": "repo_setup_complete",
                "when": {"fields": {"workflow_ref": "other"}},
                "action": "observe_only",
                "mode": "observe_only",
                "evaluation": "sync",
            }
        ]
    )
    matched = match_rules(
        rules,
        event_type="agent_milestone",
        metadata={"milestone": "repo_setup_complete", "workflow_ref": "coding/new-task-v1"},
        evaluation="sync",
    )
    assert matched == []
