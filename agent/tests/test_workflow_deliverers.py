"""Tests for the deliver_artifact deliverer registry (ADR-014 addendum)."""

from __future__ import annotations

from workflow.deliverers import DELIVER_OUTCOMES, DELIVERERS, produced_outcomes


def test_first_party_deliverers_present():
    assert set(DELIVERERS) == {"s3", "comment", "s3_and_comment"}


def test_produced_outcomes_match_first_party_contract():
    # These sets must equal the pre-addendum enum behavior so no existing
    # workflow / fixture changes verdict.
    assert produced_outcomes("s3") == frozenset({"artifact"})
    assert produced_outcomes("comment") == frozenset({"comment"})
    assert produced_outcomes("s3_and_comment") == frozenset({"artifact", "comment"})


def test_unset_target_is_lenient():
    # An unset target returns the full deliver outcome set (no false positive on
    # an unpinned runtime default).
    assert produced_outcomes(None) == DELIVER_OUTCOMES
    assert frozenset({"artifact", "comment"}) == DELIVER_OUTCOMES


def test_unknown_target_produces_nothing():
    assert produced_outcomes("nope") == frozenset()
