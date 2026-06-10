"""Load, shape-validate, and parse a workflow file.

This is the *shape* half of validation: a workflow file is parsed from YAML,
validated against the canonical JSON Schema
(``agent/workflows/schema/workflow.schema.json``), and returned as a typed
``Workflow`` model. The non-schema cross-field rules (WORKFLOWS.md §"Validation
rules") live in ``workflow.validator`` and run at author/CI time — the runtime
loader deliberately performs shape-only validation and trusts the CI-gated
cross-field verdict, so there is exactly one cross-field implementation in
Phases 1-3 (see WORKFLOWS.md §"Single source of truth and validator parity").
"""

from __future__ import annotations

import json
from functools import cache, lru_cache
from pathlib import Path
from typing import Any

import jsonschema
import jsonschema.protocols
import jsonschema.validators
import yaml

from .models import Workflow

# agent/src/workflow/loader.py -> agent/ ; workflows tree lives at agent/workflows/.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS_ROOT = _AGENT_ROOT / "workflows"
_SCHEMA_PATH = _WORKFLOWS_ROOT / "schema" / "workflow.schema.json"


class WorkflowValidationError(ValueError):
    """A workflow file failed schema (shape) or parse validation.

    Cross-field rule failures are raised by ``workflow.validator`` with the same
    type so callers can catch a single error class regardless of which stage
    rejected the file.
    """


@lru_cache(maxsize=1)
def _schema() -> dict[str, Any]:
    """Load and cache the canonical JSON Schema."""
    try:
        return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise WorkflowValidationError(
            f"could not load workflow JSON Schema at {_SCHEMA_PATH}: {e}"
        ) from e


@lru_cache(maxsize=1)
def _validator() -> jsonschema.protocols.Validator:
    """Build and cache a Draft 2020-12 validator for the workflow schema."""
    schema = _schema()
    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    return cls(schema)


def validate_shape(data: dict[str, Any]) -> None:
    """Validate a raw workflow dict against the JSON Schema.

    Raises ``WorkflowValidationError`` with all violations joined, so a bad file
    surfaces every shape problem at once rather than one-at-a-time.
    """
    errors = sorted(_validator().iter_errors(data), key=lambda e: list(e.path))
    if errors:
        detail = "; ".join(
            f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors
        )
        raise WorkflowValidationError(f"workflow failed schema validation: {detail}")


def parse_workflow(data: dict[str, Any]) -> Workflow:
    """Shape-validate a raw dict and return a typed ``Workflow``.

    Use when the workflow body is already in memory (tests, inline bodies). For
    files on disk use ``load_workflow_file``; to resolve a ref use
    ``load_workflow``.
    """
    validate_shape(data)
    return Workflow.model_validate(data)


def load_workflow_file(path: str | Path) -> Workflow:
    """Load a workflow from a YAML (or JSON) file on disk."""
    p = Path(path)
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    except OSError as e:
        raise WorkflowValidationError(f"could not read workflow file {p}: {e}") from e
    except yaml.YAMLError as e:
        raise WorkflowValidationError(f"workflow file {p} is not valid YAML: {e}") from e
    if not isinstance(raw, dict):
        raise WorkflowValidationError(
            f"workflow file {p} must be a YAML mapping, got {type(raw).__name__}"
        )
    return parse_workflow(raw)


def _ref_to_path(workflow_id: str) -> Path:
    """Map a workflow id (``<domain>/<name>-vN``) to its first-party file path.

    First-party workflows live at ``agent/workflows/<domain>/<name>-vN.yaml``.
    Registry-resolved refs (Phase 4, #246) are out of scope here.
    """
    # Defense-in-depth: the id pattern (schema rule 1) already forbids path
    # traversal, but the loader must never resolve outside the workflows tree.
    if "/" not in workflow_id or ".." in workflow_id or workflow_id.startswith("/"):
        raise WorkflowValidationError(f"invalid workflow id: {workflow_id!r}")
    return _WORKFLOWS_ROOT.joinpath(f"{workflow_id}.yaml")


# Maps a first-party workflow id to the legacy Cedar principal identity, keeping
# the existing Agent::TaskAgent::"<id>" principal scheme. Read-only enforcement
# no longer rides this principal: since #248 Phase 2a it keys off the
# ``read_only`` context attribute, so the principal is just an audit/identity
# tag and a read-only workflow keeps its own id-derived principal (the bridge
# that forced every read-only workflow onto "pr_review" is gone — see ADR-014
# addendum 2026-06-08).
_PRINCIPAL_BY_ID = {
    "coding/new-task-v1": "new_task",
    "coding/pr-iteration-v1": "pr_iteration",
    "coding/pr-review-v1": "pr_review",
}


def policy_principal_for(workflow: Workflow) -> str:
    """Derive the Cedar principal identity for a resolved workflow.

    Maps by id (see ``_PRINCIPAL_BY_ID``), defaulting to ``"new_task"``. This is
    an identity/audit tag only — read-only enforcement is driven by
    ``context.read_only`` in the Cedar request (#248 Phase 2a), not by this
    principal, so hard/soft deny apply regardless of which principal a workflow
    resolves to.
    """
    return _PRINCIPAL_BY_ID.get(workflow.id, "new_task")


@cache
def load_workflow(workflow_id: str) -> Workflow:
    """Resolve a first-party workflow id to its parsed ``Workflow``.

    The resolved ``{id, version}`` pin is computed at the create-task boundary
    (orchestrator); the agent loads the pinned file from the image here. The id
    in the file must match the requested id (guards against a misfiled
    workflow).

    Memoized: first-party workflow files are baked into the image and immutable
    per process, and ``Workflow`` (and its whole model graph) is ``frozen=True``,
    so the parsed result is safe to share. A single task resolves the same id
    3-4x (build_config, the run_agent step dispatch, the post-hook reload — see
    PR review #296); caching parses each file once instead of re-reading and
    re-validating it every time.
    """
    path = _ref_to_path(workflow_id)
    if not path.is_file():
        raise WorkflowValidationError(
            f"workflow {workflow_id!r} not found at {path} (first-party workflows "
            "live under agent/workflows/<domain>/<name>-vN.yaml)"
        )
    workflow = load_workflow_file(path)
    if workflow.id != workflow_id:
        raise WorkflowValidationError(
            f"workflow file {path} declares id {workflow.id!r} but was loaded as "
            f"{workflow_id!r} — file path and declared id must agree"
        )
    return workflow
