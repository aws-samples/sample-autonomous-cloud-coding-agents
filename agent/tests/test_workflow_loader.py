"""Unit tests for the workflow models + loader (#248).

Covers shape validation against the JSON Schema, YAML/file loading, the
domain-derived ``requires_repo`` default, id/path agreement, and path-traversal
defense. Cross-field rules are tested separately against the golden corpus.
"""

from __future__ import annotations

import textwrap
from typing import TYPE_CHECKING

import pytest
from pydantic import ValidationError

from workflow import (
    Convergence,
    Workflow,
    WorkflowValidationError,
    load_workflow,
    load_workflow_file,
)
from workflow.loader import parse_workflow, validate_shape

if TYPE_CHECKING:
    from pathlib import Path


def _valid_new_task() -> dict:
    """A minimal valid ``coding`` workflow body (mirrors the WORKFLOWS.md example)."""
    return {
        "id": "coding/new-task-v1",
        "version": "1.0.0",
        "domain": "coding",
        "description": "Implement a GitHub issue and open a PR.",
        "requires_repo": True,
        "read_only": False,
        "prompt": {"template": "registry://prompt/coding-new-task-workflow"},
        "hydration": {"sources": ["issue", "memory", "task_description"]},
        "agent_config": {
            "tier": "standard",
            "allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"],
            "cedar_policy_modules": ["builtin/hard_deny", "builtin/soft_deny"],
        },
        "repo_config": {"provider": "github", "discover": True},
        "required_inputs": {"one_of": ["issue_number", "task_description"]},
        "steps": [
            {"kind": "clone_repo", "name": "setup"},
            {"kind": "hydrate_context", "name": "context"},
            {"kind": "run_agent", "name": "implement"},
            {"kind": "verify_build", "name": "build", "gate": "regression_only"},
            {"kind": "ensure_pr", "name": "open_pr", "strategy": "create"},
        ],
        "terminal_outcomes": {"primary": "pr_url"},
        "convergence": {
            "mode": "test_gated",
            "required_sensors": ["verify_build"],
            "terminal_outcomes": ["pr_opened"],
            "early_exit": {"allow_on_policy_deny": True},
        },
        "limits": {"max_turns": 100},
        "promotion_gate": {"requires": ["tests:agent/new_task"]},
        "status": "production",
    }


class TestParseWorkflow:
    def test_parses_valid_coding_workflow(self):
        wf = parse_workflow(_valid_new_task())
        assert isinstance(wf, Workflow)
        assert wf.id == "coding/new-task-v1"
        assert wf.agent_config.tier == "standard"
        assert wf.steps[3].kind == "verify_build"
        assert wf.steps[3].gate == "regression_only"
        assert wf.steps[4].strategy == "create"
        assert wf.terminal_outcomes.primary == "pr_url"
        assert wf.convergence is not None
        assert wf.convergence.mode == "test_gated"
        assert wf.convergence.required_sensors == ["verify_build"]
        assert wf.convergence.terminal_outcomes == ["pr_opened"]
        assert wf.convergence.early_exit is not None
        assert wf.convergence.early_exit.allow_on_policy_deny is True

    def test_unknown_top_level_field_rejected(self):
        body = _valid_new_task()
        body["surprise"] = True
        with pytest.raises(WorkflowValidationError):
            parse_workflow(body)

    def test_missing_required_field_rejected(self):
        body = _valid_new_task()
        del body["status"]
        with pytest.raises(WorkflowValidationError, match="status"):
            parse_workflow(body)

    def test_bad_id_pattern_rejected(self):
        body = _valid_new_task()
        body["id"] = "CodingNewTask"  # no domain/name-vN structure
        with pytest.raises(WorkflowValidationError):
            parse_workflow(body)

    def test_read_only_must_exclude_write_edit_via_schema(self):
        """The schema's allOf conditional enforces rule 4's shape half."""
        body = _valid_new_task()
        body["read_only"] = True  # still lists Write/Edit -> schema rejection
        with pytest.raises(WorkflowValidationError, match="allowed_tools"):
            parse_workflow(body)

    def test_requires_repo_false_forbids_clone_repo_via_schema(self):
        body = _valid_new_task()
        body["requires_repo"] = False
        with pytest.raises(WorkflowValidationError):
            parse_workflow(body)

    def test_convergence_is_optional_for_existing_workflows(self):
        body = _valid_new_task()
        del body["convergence"]
        assert parse_workflow(body).convergence is None

    def test_early_exit_policy_deny_defaults_false(self):
        body = _valid_new_task()
        body["convergence"]["early_exit"] = {}
        workflow = parse_workflow(body)
        assert workflow.convergence is not None
        assert workflow.convergence.early_exit is not None
        assert workflow.convergence.early_exit.allow_on_policy_deny is False

    def test_parses_valid_human_approved_convergence(self):
        body = _valid_new_task()
        body["convergence"] = {
            "mode": "human_approved",
            "terminal_outcomes": ["human_approved"],
        }
        workflow = parse_workflow(body)
        assert workflow.convergence is not None
        assert workflow.convergence.mode == "human_approved"
        assert workflow.convergence.required_sensors is None
        assert workflow.convergence.terminal_outcomes == ["human_approved"]

    def test_model_rejects_explicit_empty_required_sensors(self):
        with pytest.raises(ValidationError, match="required_sensors"):
            Convergence(
                mode="review_submitted",
                required_sensors=[],
                terminal_outcomes=["review_published"],
            )

    @pytest.mark.parametrize(
        ("convergence", "error_path"),
        [
            (
                {
                    "mode": "fixed_iterations",
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/mode",
            ),
            (
                {
                    "mode": "test_gated",
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence",
            ),
            (
                {
                    "mode": "test_gated",
                    "required_sensors": [],
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/required_sensors",
            ),
            (
                {
                    "mode": "test_gated",
                    "required_sensors": ["verify_tests"],
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/required_sensors/0",
            ),
            (
                {
                    "mode": "review_submitted",
                    "terminal_outcomes": ["review_published"],
                    "early_exit": {"ignore_failures": True},
                },
                "convergence/early_exit",
            ),
            (
                {
                    "mode": "review_submitted",
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/terminal_outcomes",
            ),
            (
                {
                    "mode": "artifact_delivered",
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/terminal_outcomes",
            ),
            (
                {
                    "mode": "human_approved",
                    "terminal_outcomes": ["pr_opened"],
                },
                "convergence/terminal_outcomes",
            ),
        ],
    )
    def test_invalid_convergence_rejected_with_clear_path(self, convergence, error_path):
        body = _valid_new_task()
        body["convergence"] = convergence
        with pytest.raises(WorkflowValidationError) as exc:
            parse_workflow(body)
        assert f"{error_path}:" in str(exc.value)

    @pytest.mark.parametrize("sensor", ["verify_build", "verify_lint"])
    def test_required_sensor_must_have_matching_step(self, sensor):
        body = _valid_new_task()
        body["convergence"]["required_sensors"] = [sensor]
        body["steps"] = [step for step in body["steps"] if step["kind"] != sensor]
        with pytest.raises(WorkflowValidationError) as exc:
            parse_workflow(body)
        assert "steps:" in str(exc.value)


class TestRequiresRepoDefault:
    def test_coding_defaults_true(self):
        body = _valid_new_task()
        del body["requires_repo"]
        assert parse_workflow(body).resolved_requires_repo is True

    def test_knowledge_defaults_false(self):
        body = _valid_new_task()
        del body["requires_repo"]
        del body["repo_config"]
        body["id"] = "knowledge/web-research-v1"
        body["domain"] = "knowledge"
        body["hydration"] = {"sources": ["task_description", "attachments"]}
        body["steps"] = [
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "deliver_artifact", "target": "s3_and_comment"},
        ]
        body["terminal_outcomes"] = {"primary": "artifact"}
        body["convergence"] = {
            "mode": "artifact_delivered",
            "terminal_outcomes": ["artifact_delivered"],
        }
        assert parse_workflow(body).resolved_requires_repo is False

    def test_explicit_value_overrides_domain_default(self):
        body = _valid_new_task()
        body["requires_repo"] = True
        assert parse_workflow(body).resolved_requires_repo is True


class TestValidateShape:
    def test_collects_all_errors(self):
        body = {"id": "BAD", "domain": "nope"}  # multiple violations
        with pytest.raises(WorkflowValidationError) as exc:
            validate_shape(body)
        # at least the missing-required and bad-enum errors surface together
        assert ";" in str(exc.value)


class TestLoadWorkflowFile:
    def test_loads_yaml(self, tmp_path: Path):
        body = textwrap.dedent(
            """\
            id: knowledge/note-v1
            version: 1.0.0
            domain: knowledge
            requires_repo: false
            prompt:
              template: "respond to the request"
            hydration:
              sources: [task_description]
            agent_config:
              tier: standard
              allowed_tools: [Read]
            repo_config:
              discover: false
            steps:
              - { kind: hydrate_context }
              - { kind: run_agent }
              - { kind: deliver_artifact, target: comment }
            terminal_outcomes: { primary: comment }
            status: production
            """
        )
        f = tmp_path / "note-v1.yaml"
        f.write_text(body, encoding="utf-8")
        wf = load_workflow_file(f)
        assert wf.id == "knowledge/note-v1"
        assert wf.resolved_requires_repo is False

    def test_non_mapping_rejected(self, tmp_path: Path):
        f = tmp_path / "bad.yaml"
        f.write_text("- just\n- a\n- list\n", encoding="utf-8")
        with pytest.raises(WorkflowValidationError, match="mapping"):
            load_workflow_file(f)

    def test_invalid_yaml_rejected(self, tmp_path: Path):
        f = tmp_path / "bad.yaml"
        f.write_text("key: : :\n", encoding="utf-8")
        with pytest.raises(WorkflowValidationError, match="valid YAML"):
            load_workflow_file(f)


class TestLoadWorkflow:
    @pytest.mark.parametrize(
        ("workflow_id", "mode", "outcome"),
        [
            ("coding/new-task-v1", "test_gated", "pr_opened"),
            ("coding/pr-iteration-v1", "test_gated", "pr_opened"),
            ("coding/pr-review-v1", "review_submitted", "review_published"),
        ],
    )
    def test_shipped_coding_workflow_declares_convergence(self, workflow_id, mode, outcome):
        workflow = load_workflow(workflow_id)
        assert workflow.convergence is not None
        assert workflow.convergence.mode == mode
        assert workflow.convergence.terminal_outcomes == [outcome]

    def test_missing_id_raises(self):
        with pytest.raises(WorkflowValidationError, match="not found"):
            load_workflow("coding/does-not-exist-v9")

    @pytest.mark.parametrize("bad", ["../etc/passwd", "/abs/path", "no-slash"])
    def test_path_traversal_rejected(self, bad: str):
        with pytest.raises(WorkflowValidationError):
            load_workflow(bad)
