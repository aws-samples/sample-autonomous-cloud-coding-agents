"""Cedar-HITL Day-1 spike: cedarpy annotation round-trip contract.

Locks the assumption (decision #22 / §15.6 of docs/design/CEDAR_HITL_GATES.md)
that ``cedarpy.policies_to_json_str()`` preserves all five annotations the
engine relies on — ``@rule_id``, ``@tier``, ``@approval_timeout_s``,
``@severity``, ``@category`` — verbatim as string-valued entries under
``staticPolicies.<policy_id>.annotations``.

If cedarpy's annotation surface ever changes shape (renamed key, dropped
values, typed coercion), this test flips red BEFORE the engine's
annotation-merging logic starts returning subtly-wrong answers.

Parity with the TypeScript side is tested separately in
``test_cedar_parity.py`` against the shared ``contracts/cedar-parity/``
fixtures; this module validates only the agent-side API shape.
"""

import json

import pytest

cedarpy = pytest.importorskip("cedarpy")


_ANNOTATED_POLICY = (
    '@tier("soft") '
    '@rule_id("force_push_any") '
    '@approval_timeout_s("300") '
    '@severity("medium") '
    '@category("destructive") '
    'forbid (principal, action == Agent::Action::"execute_bash", resource) '
    'when { context.command like "*git push --force*" };'
)


def _first_static_policy(policies_text: str) -> dict:
    """Parse a Cedar policy set and return the first staticPolicies entry."""
    parsed = json.loads(cedarpy.policies_to_json_str(policies_text))
    statics = parsed.get("staticPolicies", {})
    assert statics, f"expected at least one static policy, got keys={list(parsed)}"
    return next(iter(statics.values()))


class TestAnnotationsRoundTrip:
    """All five annotations round-trip verbatim as strings."""

    def test_policies_to_json_str_returns_static_policies_wrapper(self):
        parsed = json.loads(cedarpy.policies_to_json_str(_ANNOTATED_POLICY))
        # The design's annotation-merging code keys off ``staticPolicies`` —
        # if cedarpy ever flattens this wrapper, the engine's lookup table
        # construction breaks silently.
        assert "staticPolicies" in parsed

    def test_annotations_key_present_on_parsed_policy(self):
        body = _first_static_policy(_ANNOTATED_POLICY)
        assert "annotations" in body, (
            f"cedarpy dropped the annotations key from parsed policy; body keys were {list(body)}"
        )

    def test_rule_id_annotation_preserved(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        assert annotations.get("rule_id") == "force_push_any"

    def test_tier_annotation_preserved(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        assert annotations.get("tier") == "soft"

    def test_approval_timeout_s_annotation_preserved_as_string(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        # Cedar annotations are always string-valued; the engine coerces to
        # int inside ``_merge_annotations`` (§6.3). If cedarpy ever switches
        # to int coercion on its side, the merge code's ``try: int(...)``
        # still works, but the documented contract (§5.2) says "string".
        assert annotations.get("approval_timeout_s") == "300"
        assert isinstance(annotations.get("approval_timeout_s"), str)

    def test_severity_annotation_preserved(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        assert annotations.get("severity") == "medium"

    def test_category_annotation_preserved(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        assert annotations.get("category") == "destructive"

    def test_all_five_annotations_present_exactly(self):
        annotations = _first_static_policy(_ANNOTATED_POLICY)["annotations"]
        expected = {
            "tier": "soft",
            "rule_id": "force_push_any",
            "approval_timeout_s": "300",
            "severity": "medium",
            "category": "destructive",
        }
        assert annotations == expected, f"annotations drift: expected {expected}, got {annotations}"


class TestDiagnosticsShape:
    """The is_authorized result carries matching policy IDs under diagnostics.reasons."""

    def test_diagnostics_reasons_is_a_list(self):
        # The engine's three-outcome branching walks ``diagnostics.reasons``
        # to recover matching policy IDs, which the annotation lookup table
        # then maps back to ``@rule_id`` values.  If cedarpy ever renames
        # this attribute (singular ``.reason``, nested object, etc.) the
        # engine silently loses the ability to surface rule IDs to users.
        req = {
            "principal": 'Agent::TaskAgent::"new_task"',
            "action": 'Agent::Action::"execute_bash"',
            "resource": 'Agent::BashCommand::"command"',
            "context": {"command": "git push --force origin main"},
        }
        entities = [
            {"uid": {"type": "Agent::TaskAgent", "id": "new_task"}, "attrs": {}, "parents": []},
            {"uid": {"type": "Agent::BashCommand", "id": "command"}, "attrs": {}, "parents": []},
        ]
        r = cedarpy.is_authorized(req, _ANNOTATED_POLICY, entities)
        assert hasattr(r.diagnostics, "reasons"), (
            "cedarpy.Diagnostics no longer exposes .reasons — engine rule-ID "
            "recovery will break. Update §15.6 IMPL-29 before proceeding."
        )
        assert isinstance(r.diagnostics.reasons, list)
        assert len(r.diagnostics.reasons) >= 1


class TestMultiMatchDiagnostics:
    """Multi-match produces multiple policy IDs in diagnostics.reasons."""

    def test_two_matching_policies_produce_two_reasons(self):
        policies = (
            _ANNOTATED_POLICY
            + "\n"
            + (
                '@tier("soft") '
                '@rule_id("force_push_main") '
                '@approval_timeout_s("600") '
                '@severity("high") '
                'forbid (principal, action == Agent::Action::"execute_bash", resource) '
                'when { context.command like "*git push --force origin main*" };'
            )
        )
        req = {
            "principal": 'Agent::TaskAgent::"new_task"',
            "action": 'Agent::Action::"execute_bash"',
            "resource": 'Agent::BashCommand::"command"',
            "context": {"command": "git push --force origin main"},
        }
        entities = [
            {"uid": {"type": "Agent::TaskAgent", "id": "new_task"}, "attrs": {}, "parents": []},
            {"uid": {"type": "Agent::BashCommand", "id": "command"}, "attrs": {}, "parents": []},
        ]
        r = cedarpy.is_authorized(req, policies, entities)
        # §6.3 annotation-merging depends on receiving both policy IDs here;
        # if cedarpy short-circuits on first match, the "max severity" and
        # "min timeout" merge rules never fire.
        assert len(r.diagnostics.reasons) == 2, (
            f"expected 2 matching policies, got {r.diagnostics.reasons}"
        )
