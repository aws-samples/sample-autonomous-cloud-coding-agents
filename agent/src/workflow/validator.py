from __future__ import annotations

import re
from typing import Any

from .deliverers import DELIVER_OUTCOMES as _DELIVER_OUTCOMES
from .deliverers import DELIVERERS as _DELIVERERS
from .deliverers import produced_outcomes as _deliverer_produces
from .loader import WorkflowValidationError, validate_shape
from .runner import STEP_HANDLERS

_HANDLER_KINDS = frozenset(STEP_HANDLERS)

_SIDE_EFFECTING_KINDS = frozenset({"ensure_pr", "post_review", "deliver_artifact"})

_REPO_ONLY_KINDS = frozenset(
    {"clone_repo", "ensure_pr", "post_review", "verify_build", "verify_lint"}
)

_BUILTIN_REF = re.compile(r"^builtin/[a-z][a-z0-9_]*$")
_REGISTRY_REF = re.compile(
    r"^registry://[a-z][a-z0-9_-]*/[a-z0-9][a-z0-9./-]*(?:/[a-z0-9][a-z0-9._-]*)?(?:@[\^~]?\S+)?$"
)

_MUTATING_TOOLS = frozenset({"Write", "Edit"})

_ELEVATED_ONLY_FIELDS = ("mcp_servers", "plugins", "skills")

_INPUT_TO_SOURCE = {
    "issue_number": "issue",
    "pr_number": "pull_request",
    "task_description": "task_description",
}

_OUTCOME_REQUIRES_STEP = {
    "pr_url": "ensure_pr",
    "review_posted": "post_review",
    "artifact": "deliver_artifact",
    "comment": "deliver_artifact",
}


def _resolved_requires_repo(data: dict[str, Any]) -> bool:
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


def _rule_1_id_version(data: dict[str, Any]) -> list[str]:
    wid, version = data.get("id"), data.get("version")
    if not isinstance(wid, str) or not isinstance(version, str):
        return []
    m = re.search(r"-v(\d+)$", wid)
    if not m:
        return []
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
    if not data.get("read_only", False):
        return []
    return [
        f"read_only workflow may not ensure_pr with strategy {strategy!r}"
        for s in data.get("steps", [])
        if (
            isinstance(s, dict)
            and s.get("kind") == "ensure_pr"
            and (strategy := s.get("strategy") or "create") in ("create", "push_resolve")
        )
    ]


def _rule_5_policy_floor(data: dict[str, Any]) -> list[str]:
    if data.get("read_only", False):
        return []
    modules = _refs(data, "cedar_policy_modules")
    if "builtin/soft_deny" not in modules:
        return [
            (
                "writeable workflow (read_only:false) must include builtin/soft_deny in "
                "agent_config.cedar_policy_modules (policy floor)"
            )
        ]
    return []


def _rule_6_tier_ceiling(data: dict[str, Any]) -> list[str]:
    ac = data.get("agent_config", {})
    tier = ac.get("tier")
    msgs = []
    tools = set(ac.get("allowed_tools", []) or [])
    if tier == "read-only":
        bad = sorted(tools & _MUTATING_TOOLS)
        if bad:
            msgs.append(f"read-only tier may not grant mutating tools: {bad}")
    if tier in ("standard", "read-only"):
        msgs.extend(
            f"{tier} tier may not declare {field} (extended reach requires tier: elevated)"
            for field in _ELEVATED_ONLY_FIELDS
            if ac.get(field)
        )
    return msgs


def _rule_7_repo_config_gating(data: dict[str, Any]) -> list[str]:
    if _resolved_requires_repo(data):
        return []
    rc = data.get("repo_config")
    if rc is None:
        return []
    msgs = []
    if rc.get("discover", True) is not False:
        msgs.append("repo-less workflow must set repo_config.discover: false")
    if "provider" in rc:
        msgs.append("repo-less workflow must not set repo_config.provider")
    return msgs


def _rule_8_refs_resolve(data: dict[str, Any]) -> list[str]:
    msgs = [
        f"step kind {kind!r} has no registered handler"
        for kind in _step_kinds(data)
        if kind not in _HANDLER_KINDS
    ]
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
        msgs.extend(
            f"{field} ref {ref!r} does not resolve (expected builtin/* or registry://)"
            for ref in _refs(data, field)
            if not _ref_resolves(ref)
        )
    return msgs


def _rule_9_required_inputs_satisfiable(data: dict[str, Any]) -> list[str]:
    ri = data.get("required_inputs")
    if not ri:
        return []
    sources = set(data.get("hydration", {}).get("sources", []))

    def _satisfiable(name: str) -> bool:
        need = _INPUT_TO_SOURCE.get(name)
        return need is None or need in sources

    msgs = [
        (
            f"required input {name!r} needs hydration source "
            f"{_INPUT_TO_SOURCE[name]!r}, which is not declared"
        )
        for name in ri.get("all_of", []) or []
        if not _satisfiable(name)
    ]
    one_of = ri.get("one_of", []) or []
    if one_of and not any(_satisfiable(n) for n in one_of):
        msgs.append(
            f"none of required inputs one_of={one_of} is satisfiable from "
            f"hydration sources {sorted(sources)}"
        )
    return msgs


def _rule_11_outcome_step_consistency(data: dict[str, Any]) -> list[str]:
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
            return primary in _deliverer_produces(step.get("target"))

        if not any(_produces(s) for s in deliver_steps):
            return [
                (
                    f"terminal outcome {primary!r} requires a deliver_artifact step whose "
                    f"target produces it; none of the declared targets do"
                )
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
    first; cross-field rules still run on a shape-invalid file, and a rule that
    raises counts as ``"schema"``.
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
            if "schema" not in violations:
                violations.append("schema")
    return violations


def assert_valid(data: dict[str, Any]) -> None:
    """Raise ``WorkflowValidationError`` if the workflow has any violation."""
    violations = validate_workflow(data)
    if violations:
        raise WorkflowValidationError(f"workflow failed validation: {', '.join(violations)}")
