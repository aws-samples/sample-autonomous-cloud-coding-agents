"""Workflow-driven tasks (#248).

A *workflow* is a versioned, declarative description of how the agent executes
one kind of task: the ordered ``steps`` to run inside the container, the system
prompt, the agent configuration, what context to hydrate, and what "done" means.
Workflows replace the hardcoded ``task_type`` branches that were previously
scattered across the agent runtime.

See ``docs/design/WORKFLOWS.md`` and ``docs/decisions/ADR-014-workflow-driven-tasks.md``.

Public surface:
  - ``Workflow`` and the sub-models (``models``) — the parsed workflow file.
  - ``load_workflow`` / ``load_workflow_file`` (``loader``) — resolve + parse + shape-validate.
  - ``WorkflowValidationError`` — raised on schema or cross-field violations.
"""

from __future__ import annotations

from .loader import (
    WorkflowValidationError,
    load_workflow,
    load_workflow_file,
    policy_principal_for,
)
from .models import (
    AgentConfig,
    Hydration,
    Limits,
    ModelPreference,
    PromotionGate,
    RepoConfig,
    Step,
    TerminalOutcomes,
    Workflow,
)
from .runner import (
    STEP_HANDLERS,
    StepContext,
    StepOutcome,
    WorkflowCheckpoint,
    WorkflowResult,
    gate_status,
    run_workflow,
)
from .validator import assert_valid, validate_workflow

__all__ = [
    "STEP_HANDLERS",
    "AgentConfig",
    "Hydration",
    "Limits",
    "ModelPreference",
    "PromotionGate",
    "RepoConfig",
    "Step",
    "StepContext",
    "StepOutcome",
    "TerminalOutcomes",
    "Workflow",
    "WorkflowCheckpoint",
    "WorkflowResult",
    "WorkflowValidationError",
    "assert_valid",
    "gate_status",
    "load_workflow",
    "load_workflow_file",
    "policy_principal_for",
    "run_workflow",
    "validate_workflow",
]
