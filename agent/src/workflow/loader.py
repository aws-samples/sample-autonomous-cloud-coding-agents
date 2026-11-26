from __future__ import annotations

import json
from functools import cache, lru_cache
from pathlib import Path
from typing import Any

import jsonschema
import jsonschema.protocols
import jsonschema.validators
import yaml
from pydantic import ValidationError

from .models import Workflow

_AGENT_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS_ROOT = _AGENT_ROOT / "workflows"
_SCHEMA_PATH = _WORKFLOWS_ROOT / "schema" / "workflow.schema.json"


class WorkflowValidationError(ValueError):
    """A workflow file failed schema (shape) or parse validation.

    Cross-field rule failures are raised by ``workflow.validator`` with the same
    type.
    """


@lru_cache(maxsize=1)
def _schema() -> dict[str, Any]:
    try:
        return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise WorkflowValidationError(
            f"could not load workflow JSON Schema at {_SCHEMA_PATH}: {e}"
        ) from e


@lru_cache(maxsize=1)
def _validator() -> jsonschema.protocols.Validator:
    schema = _schema()
    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    return cls(schema)


def validate_shape(data: dict[str, Any]) -> None:
    """Validate a raw workflow dict against the JSON Schema.

    Raises ``WorkflowValidationError`` with all violations joined.
    """
    errors = sorted(_validator().iter_errors(data), key=lambda e: list(e.path))
    if errors:
        detail = "; ".join(
            f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors
        )
        raise WorkflowValidationError(f"workflow failed schema validation: {detail}")


def parse_workflow(data: dict[str, Any]) -> Workflow:
    """Shape-validate a raw dict and return a typed ``Workflow``."""
    validate_shape(data)
    try:
        return Workflow.model_validate(data)
    except ValidationError as e:
        detail = "; ".join(
            f"{'/'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()
        )
        raise WorkflowValidationError(f"workflow failed model validation: {detail}") from e


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


# Registry-resolved refs (Phase 4, #246) are out of scope here.
def _ref_to_path(workflow_id: str) -> Path:
    if "/" not in workflow_id or ".." in workflow_id or workflow_id.startswith("/"):
        raise WorkflowValidationError(f"invalid workflow id: {workflow_id!r}")
    return _WORKFLOWS_ROOT.joinpath(f"{workflow_id}.yaml")


_PRINCIPAL_BY_ID = {
    "coding/new-task-v1": "new_task",
    "coding/pr-iteration-v1": "pr_iteration",
    "coding/pr-review-v1": "pr_review",
}


def policy_principal_for(workflow: Workflow) -> str:
    """Derive the Cedar principal identity for a resolved workflow.

    Maps by id (see ``_PRINCIPAL_BY_ID``), defaulting to ``"new_task"``.
    """
    return _PRINCIPAL_BY_ID.get(workflow.id, "new_task")


@cache
def load_workflow(workflow_id: str) -> Workflow:
    """Resolve a first-party workflow id to its parsed ``Workflow``.

    The id in the file must match the requested id.
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
