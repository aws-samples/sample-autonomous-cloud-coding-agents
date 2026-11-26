import json

import cedarpy

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
    parsed = json.loads(cedarpy.policies_to_json_str(policies_text))
    statics = parsed.get("staticPolicies", {})
    assert statics, f"expected at least one static policy, got keys={list(parsed)}"
    return next(iter(statics.values()))


class TestAnnotationsRoundTrip:
    def test_policies_to_json_str_returns_static_policies_wrapper(self):
        parsed = json.loads(cedarpy.policies_to_json_str(_ANNOTATED_POLICY))
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
    def test_diagnostics_reasons_is_a_list(self):
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
        assert len(r.diagnostics.reasons) == 2, (
            f"expected 2 matching policies, got {r.diagnostics.reasons}"
        )
