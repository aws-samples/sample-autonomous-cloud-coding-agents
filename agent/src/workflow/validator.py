"""The single cross-field workflow validator (#248).

This is the *one* implementation of the cross-field validation rules from
WORKFLOWS.md §"Validation rules" — the rules the JSON Schema cannot express.
Per WORKFLOWS.md §"Single source of truth and validator parity", keeping exactly
one implementation (run at author/CI time) is what prevents the cedar-style
two-language drift hazard; the runtime loader does shape-only validation and
trusts this CI-gated verdict. When Phase 4 (#246) adds an out-of-band publish
path that must validate in a second language, the ``contracts/workflow-validation/``
golden corpus is the contract both implementations must reproduce.

``validate_workflow(data)`` returns the *full* verdict — JSON-Schema shape
violations (reported under the ``"schema"`` code) followed by cross-field rule
violations (``"rule-N"`` codes matching WORKFLOWS.md's numbering). An empty list
means the workflow is valid.
"""

from __future__ import annotations

import re
from typing import Any

from .deliverers import DELIVER_OUTCOMES as _DELIVER_OUTCOMES
from .deliverers import DELIVERERS as _DELIVERERS
from .deliverers import produced_outcomes as _deliverer_produces
from .loader import WorkflowValidationError, validate_shape
from .runner import STEP_HANDLERS

# --- rule support data -------------------------------------------------------

# Steps the runner has a handler for (rule 8). Derived from the runner's
# STEP_HANDLERS registry — the single source of truth for "kind has a registered
# handler" — rather than a hand-maintained copy that could silently drift from
# the registry it is supposed to mirror. (Importing runner here is cycle-free:
# runner imports only shell/models, never the validator.)
_HANDLER_KINDS = frozenset(STEP_HANDLERS)

# Steps that produce an external side effect — may not be marked on_failure:
# continue (rule 12), and used by the repo-less shape check (rule 3).
_SIDE_EFFECTING_KINDS = frozenset({"ensure_pr", "post_review", "deliver_artifact"})

# Steps that only make sense when a repo is cloned (rule 3 / rule 7).
_REPO_ONLY_KINDS = frozenset(
    {"clone_repo", "ensure_pr", "post_review", "verify_build", "verify_lint"}
)

# Built-in (Phase 1-3) policy modules / MCP servers. Registry refs (registry://)
# are accepted syntactically now and resolved against #246 in Phase 4 (rule 8).
_BUILTIN_REF = re.compile(r"^builtin/[a-z][a-z0-9_]*$")
_REGISTRY_REF = re.compile(r"^registry://[a-z][a-z0-9-]*/[a-z0-9][a-z0-9./-]*$")

# Mutating built-in tools — forbidden under the read-only tier (rule 6) and when
# read_only:true (rule 4, shape half is in the schema).
_MUTATING_TOOLS = frozenset({"Write", "Edit"})

# Reach that requires the elevated tier (rule 6). Maps to SECURITY.md's
# "Extended (opt-in per repo)" scope: MCP servers and plugins. Declaring any of
# these on a `standard` workflow exceeds the tier ceiling.
_ELEVATED_ONLY_FIELDS = ("mcp_servers", "plugins", "skills")

# Maps a required-input name (rule 9) to the hydration source that must supply
# it. Inputs not in this map (e.g. free-form) are treated as always satisfiable.
_INPUT_TO_SOURCE = {
    "issue_number": "issue",
    "pr_number": "pull_request",
    "task_description": "task_description",
}

# Maps a terminal outcome to the step kind that must be present to produce it
# (rule 11). `comment` and `artifact` are both produced by deliver_artifact —
# but by *different* deliverers, so the kind-presence check is refined by the
# deliverer registry (workflow.deliverers) below.
_OUTCOME_REQUIRES_STEP = {
    "pr_url": "ensure_pr",
    "review_posted": "post_review",
    "artifact": "deliver_artifact",
    "comment": "deliver_artifact",
}

# Which terminal outcomes a deliver_artifact ``target`` produces is owned by the
# deliverer registry (ADR-014 addendum 2026-06-08): ``target`` is an open
# string naming a registered Python deliverer, each of which declares its
# produced outcomes. The validator consults that single source of truth (imported
# at module top as _DELIVER_OUTCOMES / _deliverer_produces) instead of a
# hardcoded enum, so a new deliverer needs no validator edit.


def _resolved_requires_repo(data: dict[str, Any]) -> bool:
    """``requires_repo`` with the domain-derived default applied.

    Duplicated from ``Workflow.resolved_requires_repo`` because the validator
    runs on the raw dict (before model construction) so it can report *all*
    violations, including on files too malformed to parse into the model.
    """
    if data.get("requires_repo") is not None:
        return bool(data["requires_repo"])
    return data.get("domain") == "coding"


def _step_kinds(data: dict[str, Any]) -> list[str]:
    return [
        s["kind"]
        for s in data.get("steps", [])
        if isinstance(s, dict) and isinstance(s.get("kind"), str)
    ]


def _refs(data: dict[str, Any], field: str) -> list[str]:
    return list(data.get("agent_config", {}).get(field, []) or [])


def _ref_resolves(ref: str) -> bool:
    return bool(_BUILTIN_REF.match(ref) or _REGISTRY_REF.match(ref))


# --- the rules ---------------------------------------------------------------
# Each returns a list of human-readable messages (empty == passed). Rule numbers
# match WORKFLOWS.md §"Validation rules". Rules 3/4/7 also have a schema half;
# here we cover the cross-field remainder (notably the domain-default case the
# schema cannot see).


def _rule_1_id_version(data: dict[str, Any]) -> list[str]:
    """id's -vN suffix must equal the semver major."""
    wid, version = data.get("id"), data.get("version")
    if not isinstance(wid, str) or not isinstance(version, str):
        return []  # shape error already reported
    m = re.search(r"-v(\d+)$", wid)
    if not m:
        return []  # shape (pattern) error already reported
    id_major = m.group(1)
    semver_major = version.split(".", 1)[0]
    if id_major != semver_major:
        return [f"id major -v{id_major} does not match version major {semver_major}"]
    return []


def _rule_2_single_run_agent(data: dict[str, Any]) -> list[str]:
    n = _step_kinds(data).count("run_agent")
    if n != 1:
        return [f"exactly one run_agent step required, found {n}"]
    return []


def _rule_3_repo_less_steps(data: dict[str, Any]) -> list[str]:
    """requires_repo:false (incl. domain default) ⇒ no repo-only steps / sources."""
    if _resolved_requires_repo(data):
        return []
    msgs = []
    bad_steps = sorted({k for k in _step_kinds(data) if k in _REPO_ONLY_KINDS})
    if bad_steps:
        msgs.append(f"repo-less workflow may not declare repo-only steps: {bad_steps}")
    sources = set(data.get("hydration", {}).get("sources", []))
    bad_sources = sorted(sources & {"issue", "pull_request"})
    if bad_sources:
        msgs.append(f"repo-less workflow may not hydrate repo sources: {bad_sources}")
    return msgs


def _rule_4_read_only_no_pr_create(data: dict[str, Any]) -> list[str]:
    """read_only ⇒ no ensure_pr that creates/pushes (writes the tree)."""
    if not data.get("read_only", False):
        return []
    msgs = []
    for s in data.get("steps", []):
        if (
            isinstance(s, dict)
            and s.get("kind") == "ensure_pr"
            and s.get("strategy") in ("create", "push_resolve")
        ):
            msgs.append(f"read_only workflow may not ensure_pr with strategy {s.get('strategy')!r}")
    return msgs


def _rule_5_policy_floor(data: dict[str, Any]) -> list[str]:
    """Writeable workflows must keep the builtin/soft_deny floor."""
    if data.get("read_only", False):
        return []
    modules = _refs(data, "cedar_policy_modules")
    if "builtin/soft_deny" not in modules:
        return [
            "writeable workflow (read_only:false) must include builtin/soft_deny in "
            "agent_config.cedar_policy_modules (policy floor)"
        ]
    return []


def _rule_6_tier_ceiling(data: dict[str, Any]) -> list[str]:
    """Declared reach may not exceed the declared tier.

    Tier ordering is ``read-only < standard < elevated``. Extended reach
    (``mcp_servers``/``plugins``/``skills``) requires ``elevated``, so *any*
    sub-elevated tier declaring it exceeds its ceiling — not just ``standard``.
    Guarding only ``standard`` would let the strictest tier (``read-only``)
    declare extended reach unchecked.
    """
    ac = data.get("agent_config", {})
    tier = ac.get("tier")
    msgs = []
    tools = set(ac.get("allowed_tools", []) or [])
    if tier == "read-only":
        bad = sorted(tools & _MUTATING_TOOLS)
        if bad:
            msgs.append(f"read-only tier may not grant mutating tools: {bad}")
    if tier in ("standard", "read-only"):
        for field in _ELEVATED_ONLY_FIELDS:
            if ac.get(field):
                msgs.append(
                    f"{tier} tier may not declare {field} (extended reach requires tier: elevated)"
                )
    return msgs


def _rule_7_repo_config_gating(data: dict[str, Any]) -> list[str]:
    """requires_repo:false ⇒ repo_config.discover false and provider absent."""
    if _resolved_requires_repo(data):
        return []
    rc = data.get("repo_config")
    if rc is None:
        return []  # absent repo_config is fine for repo-less
    msgs = []
    if rc.get("discover", True) is not False:
        msgs.append("repo-less workflow must set repo_config.discover: false")
    if "provider" in rc:
        msgs.append("repo-less workflow must not set repo_config.provider")
    return msgs


def _rule_8_refs_resolve(data: dict[str, Any]) -> list[str]:
    """Every step kind has a handler; every asset ref is syntactically resolvable.

    Includes ``deliver_artifact.target`` (an open string since the ADR-014
    addendum): it must name a registered deliverer in ``DELIVERERS``, so a typo
    is caught universally here rather than only when it collides with the
    primary terminal outcome (rule 11).
    """
    msgs = []
    for kind in _step_kinds(data):
        if kind not in _HANDLER_KINDS:
            msgs.append(f"step kind {kind!r} has no registered handler")
    for step in data.get("steps", []):
        if isinstance(step, dict) and step.get("kind") == "deliver_artifact":
            target = step.get("target")
            if target is not None and target not in _DELIVERERS:
                msgs.append(
                    f"deliver_artifact target {target!r} is not a registered deliverer "
                    f"(known: {sorted(_DELIVERERS)})"
                )
    for field in (
        "cedar_policy_modules",
        "mcp_servers",
        "skills",
        "plugins",
        "subagents",
        "prompt_fragments",
    ):
        for ref in _refs(data, field):
            if not _ref_resolves(ref):
                msgs.append(
                    f"{field} ref {ref!r} does not resolve (expected builtin/* or registry://)"
                )
    return msgs


def _rule_9_required_inputs_satisfiable(data: dict[str, Any]) -> list[str]:
    """required_inputs must be satisfiable from declared hydration sources."""
    ri = data.get("required_inputs")
    if not ri:
        return []
    sources = set(data.get("hydration", {}).get("sources", []))
    msgs = []

    def _satisfiable(name: str) -> bool:
        need = _INPUT_TO_SOURCE.get(name)
        return need is None or need in sources

    for name in ri.get("all_of", []) or []:
        if not _satisfiable(name):
            msgs.append(
                f"required input {name!r} needs hydration source "
                f"{_INPUT_TO_SOURCE[name]!r}, which is not declared"
            )
    one_of = ri.get("one_of", []) or []
    if one_of and not any(_satisfiable(n) for n in one_of):
        msgs.append(
            f"none of required inputs one_of={one_of} is satisfiable from "
            f"hydration sources {sorted(sources)}"
        )
    return msgs


def _rule_11_outcome_step_consistency(data: dict[str, Any]) -> list[str]:
    """terminal_outcomes.primary must be backed by a step that produces it.

    Beyond the step *kind* being present, a ``deliver_artifact``-backed outcome
    (``comment`` / ``artifact``) must have at least one ``deliver_artifact`` step
    whose ``target`` actually produces that outcome — otherwise a workflow could
    declare ``primary: comment`` while delivering only to ``s3`` and never post
    the comment it claims as its terminal product.
    """
    primary = data.get("terminal_outcomes", {}).get("primary")
    need = _OUTCOME_REQUIRES_STEP.get(primary)
    if not need:
        return []
    if need not in _step_kinds(data):
        return [f"terminal outcome {primary!r} requires a {need} step, none present"]
    if primary in _DELIVER_OUTCOMES:
        deliver_steps = [
            s
            for s in data.get("steps", [])
            if isinstance(s, dict) and s.get("kind") == "deliver_artifact"
        ]

        def _produces(step: dict[str, Any]) -> bool:
            # Consult the deliverer registry: an unset target stays lenient, an
            # unknown name produces nothing (see workflow.deliverers).
            return primary in _deliverer_produces(step.get("target"))

        if not any(_produces(s) for s in deliver_steps):
            return [
                f"terminal outcome {primary!r} requires a deliver_artifact step whose "
                f"target produces it; none of the declared targets do"
            ]
    return []


def _rule_12_side_effect_no_continue(data: dict[str, Any]) -> list[str]:
    msgs = []
    for s in data.get("steps", []):
        if not isinstance(s, dict):
            continue
        if s.get("kind") in _SIDE_EFFECTING_KINDS and s.get("on_failure") == "continue":
            msgs.append(
                f"side-effecting step {s.get('name') or s.get('kind')!r} may not use "
                "on_failure: continue"
            )
    return msgs


def _rule_14_provider_github(data: dict[str, Any]) -> list[str]:
    rc = data.get("repo_config") or {}
    provider = rc.get("provider")
    if provider is not None and provider != "github":
        return [f"VCS provider {provider!r} is not yet supported (only 'github')"]
    return []


# Rule 13 (model allow-list) is intentionally NOT enforced here: the allow-list
# is a per-platform/per-repo (Blueprint) fact checked at the create-task
# boundary, not a property of the workflow file in isolation. Documented so its
# absence here is a recorded decision, not an oversight.

_CROSS_FIELD_RULES = [
    ("rule-1", _rule_1_id_version),
    ("rule-2", _rule_2_single_run_agent),
    ("rule-3", _rule_3_repo_less_steps),
    ("rule-4", _rule_4_read_only_no_pr_create),
    ("rule-5", _rule_5_policy_floor),
    ("rule-6", _rule_6_tier_ceiling),
    ("rule-7", _rule_7_repo_config_gating),
    ("rule-8", _rule_8_refs_resolve),
    ("rule-9", _rule_9_required_inputs_satisfiable),
    ("rule-11", _rule_11_outcome_step_consistency),
    ("rule-12", _rule_12_side_effect_no_continue),
    ("rule-14", _rule_14_provider_github),
]


def validate_workflow(data: dict[str, Any]) -> list[str]:
    """Return the full list of violation codes for a workflow dict.

    Empty list ⇒ valid. Codes are ``"schema"`` (any JSON-Schema shape failure)
    and ``"rule-N"`` (cross-field rule N from WORKFLOWS.md). Shape is checked
    first; cross-field rules still run on a shape-invalid file so the corpus can
    capture the complete verdict, but a shape failure short-circuits rules that
    would raise on malformed data.
    """
    violations: list[str] = []
    try:
        validate_shape(data)
    except WorkflowValidationError:
        violations.append("schema")
    if not isinstance(data, dict):
        return violations
    for code, rule in _CROSS_FIELD_RULES:
        try:
            if rule(data):
                violations.append(code)
        except Exception:
            # Defensive: a rule that trips on shape-invalid data must not crash
            # the validator; the shape violation is already recorded. A
            # malformed file always also carries the "schema" code below.
            if "schema" not in violations:
                violations.append("schema")
    return violations


def assert_valid(data: dict[str, Any]) -> None:
    """Raise ``WorkflowValidationError`` if the workflow has any violation."""
    violations = validate_workflow(data)
    if violations:
        raise WorkflowValidationError(f"workflow failed validation: {', '.join(violations)}")
