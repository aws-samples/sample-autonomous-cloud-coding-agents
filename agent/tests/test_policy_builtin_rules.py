"""Behaviour table for the built-in Cedar rules shipped in ``agent/policies/``.

Every rule is pinned to the tool calls it must catch and to one similar,
legitimate call it must leave alone. Removing a rule, moving it to the softer
tier, dropping one of its patterns, limiting it to some task types or to tasks
that are not read-only, or turning it into a catch-all fails here. Narrowing a
pattern fails here when a call listed for the rule no longer matches it. The
calls are chosen with that in mind (see ``BUILTIN_RULES``), but they are
examples: a pattern that still matches every one of them passes.

The calls go through ``PolicyEngine.evaluate_tool_use``, the only place the
shipped rules are evaluated. ``cdk/src/handlers/shared/builtin-policies.ts``
carries the same text for the API handlers, which parse it but never evaluate
it, and ``cdk/test/handlers/shared/builtin-policies.test.ts`` keeps that copy
byte-identical: a rule cannot be weakened there without being weakened here.

``contracts/cedar-parity/`` is a different check. It compares the two Cedar
engines on policy text written into each fixture, not on the shipped rules.
"""

import json
from typing import NamedTuple

# Hard import (not importorskip): without cedarpy the engine denies every call
# and no row below would mean anything.
import cedarpy
import pytest

import policy
from policy import Outcome, PolicyDecision, PolicyEngine
from workflow.loader import _PRINCIPAL_BY_ID


class Call(NamedTuple):
    """A tool call as the PreToolUse hook hands it to the engine."""

    tool: str
    target: str  # Bash: the command. Write and Edit: the file path.
    read_only: bool = False  # the task runs a read-only workflow


# rule id -> (tier, calls it must catch, a similar call it must leave alone)
#
# Calls it must catch: at least two for each ``like`` pattern, and every ``*``
# of the pattern stands for different text in them. Where an ordinary call can
# leave the ``*`` empty, one call does and another does not: the bare call and
# the call inside a longer command or path. A pattern that lost a ``*``, or
# was narrowed to the text of one call, then no longer matches another. The
# file rules are reached through Write and through Edit.
BUILTIN_RULES: dict[str, tuple[str, list[Call], Call]] = {
    "read_only_forbid_write": (
        "hard",
        [Call("Write", "src/main.py", read_only=True)],
        Call("Write", "src/main.py"),
    ),
    "read_only_forbid_edit": (
        "hard",
        [Call("Edit", "src/main.py", read_only=True)],
        Call("Edit", "src/main.py"),
    ),
    "rm_slash": (
        "hard",
        [Call("Bash", "rm -rf /"), Call("Bash", "sudo rm -rf /var/lib/app")],
        Call("Bash", "rm -rf ./build"),
    ),
    "write_git_internals": (
        "hard",
        [Call("Write", ".git/config"), Call("Edit", ".git/hooks/pre-commit")],
        Call("Write", ".gitignore"),
    ),
    "write_git_internals_nested": (
        "hard",
        [Call("Write", "vendor/lib/.git/config"), Call("Edit", "packages/app/.git/HEAD")],
        Call("Write", "vendor/lib/.gitignore"),
    ),
    "drop_table": (
        "hard",
        [Call("Bash", 'psql -c "DROP TABLE users"'), Call("Bash", "mysql -e 'DROP TABLE orders'")],
        Call("Bash", 'psql -c "SELECT count(*) FROM users"'),
    ),
    "force_push_any": (
        "soft",
        [
            Call("Bash", "git push --force origin feature/login"),
            Call("Bash", "git push -f origin feature/login"),
            Call("Bash", "git push -f"),
            Call("Bash", "cd repo && git push --force"),
            Call("Bash", "cd repo && git push -f upstream fix/typo"),
            Call("Bash", "cd repo && git push -f"),
        ],
        Call("Bash", "git push origin feature/login"),
    ),
    "force_push_main": (
        "soft",
        [
            Call("Bash", "git push --force origin main"),
            Call("Bash", "git push --force origin prod"),
            Call("Bash", "git push -f origin main"),
            Call("Bash", "git push -f origin prod"),
            Call("Bash", "cd repo && git push --force origin main && git status"),
            Call("Bash", "cd repo && git push --force origin prod && git status"),
            Call("Bash", "cd repo && git push -f origin main && git status"),
            Call("Bash", "cd repo && git push -f origin prod && git status"),
        ],
        # Still needs approval, but from force_push_any alone.
        Call("Bash", "git push --force origin feature/login"),
    ),
    "push_to_protected_branch": (
        "soft",
        [
            Call("Bash", "git push origin main"),
            Call("Bash", "git push origin master"),
            Call("Bash", "git push origin prod"),
            Call("Bash", "git push origin release/1.2"),
            Call("Bash", "cd repo && git push origin main && git status"),
            Call("Bash", "cd repo && git push origin master && git status"),
            Call("Bash", "cd repo && git push origin prod && git status"),
            Call("Bash", "cd repo && git push origin release/2026.11 && git status"),
        ],
        Call("Bash", "git push origin feature/login"),
    ),
    "write_env_files": (
        "soft",
        [Call("Write", "config/.env"), Call("Edit", ".env")],
        Call("Write", "src/env.py"),
    ),
    "write_credentials": (
        "soft",
        [Call("Write", ".aws/credentials"), Call("Edit", "credentials.json")],
        Call("Write", "src/auth/login.py"),
    ),
}

# Every task type a workflow can run as: the Cedar principal. A built-in rule
# holds for all of them, so each call it must catch is evaluated as each one.
_TASK_TYPES = sorted(set(_PRINCIPAL_BY_ID.values()))

_OUTCOME = {"hard": Outcome.DENY, "soft": Outcome.REQUIRE_APPROVAL}
_ON_PURPOSE = (
    "If agent/policies/ was changed on purpose, update BUILTIN_RULES in this file in the "
    "same commit; removing or loosening a built-in rule needs a security review."
)


def _decide(call: Call, task_type: str = "new_task") -> PolicyDecision:
    engine = PolicyEngine(task_type=task_type, repo="owner/repo", read_only=call.read_only)
    key = "command" if call.tool == "Bash" else "file_path"
    return engine.evaluate_tool_use(call.tool, {key: call.target})


def _rules_behind(decision: PolicyDecision) -> list[str]:
    """Rule ids the engine names for a decision. An allow names none."""
    if decision.outcome == Outcome.ALLOW:
        return []
    kind, _, rule_ids = decision.reason.partition(": ")
    assert kind in ("Hard-deny", "Soft-deny"), f"not decided by a rule: {decision!r}"
    return rule_ids.split(", ")


def test_table_covers_exactly_the_shipped_rules() -> None:
    shipped = {}
    for tier, text in zip(("hard", "soft"), policy._load_builtin_policies(), strict=True):
        for rule in json.loads(cedarpy.policies_to_json_str(text))["staticPolicies"].values():
            if rule["effect"] == "forbid":
                shipped[rule["annotations"]["rule_id"]] = tier
    pinned = {rule_id: tier for rule_id, (tier, caught, _) in BUILTIN_RULES.items() if caught}
    assert pinned == shipped, (
        f"agent/policies/ ships the rules {shipped} but BUILTIN_RULES pins {pinned}. Every "
        "built-in rule needs an entry: its tier, the calls it must catch (at least two for each "
        "pattern, with different text for each `*`: see the comment above BUILTIN_RULES) and a "
        f"similar call it must leave alone. {_ON_PURPOSE}"
    )


@pytest.mark.parametrize(
    ("rule_id", "tier", "call", "task_type"),
    [
        pytest.param(
            rule_id,
            tier,
            call._replace(read_only=read_only),
            task_type,
            id=f"{rule_id}: {call.tool} {call.target} as {task_type}"
            + (", read-only" if read_only else ""),
        )
        for rule_id, (tier, caught, _) in BUILTIN_RULES.items()
        for call in caught
        for task_type in _TASK_TYPES
        # A command rule holds in a read-only task as well: the review workflow
        # is read-only and runs Bash. A file rule shows only in a task that may
        # write: in a read-only one the two read_only rules deny Write and Edit
        # before a file rule is reached.
        for read_only in ((False, True) if call.tool == "Bash" else (call.read_only,))
    ],
)
def test_rule_catches_the_call_it_exists_for(
    rule_id: str, tier: str, call: Call, task_type: str
) -> None:
    decision = _decide(call, task_type)
    hint = (
        f"agent/policies/{tier}_deny.cedar: rule {rule_id!r} must catch {call} in a "
        f"{task_type!r} task with outcome {_OUTCOME[tier].value!r}, but the engine returned "
        f"{decision!r}. The rule was removed, moved to another tier, limited to some task types "
        "or to tasks that are not read-only, or narrowed so that its pattern no longer matches "
        f"this call, or policy.py no longer evaluates this tool against it. {_ON_PURPOSE}"
    )
    assert decision.outcome == _OUTCOME[tier], hint
    assert rule_id in _rules_behind(decision), hint


@pytest.mark.parametrize(
    ("rule_id", "call"),
    [
        pytest.param(rule_id, near_miss, id=f"{rule_id}: {near_miss.target}")
        for rule_id, (_, _, near_miss) in BUILTIN_RULES.items()
    ],
)
def test_rule_leaves_a_similar_call_alone(rule_id: str, call: Call) -> None:
    decision = _decide(call)
    assert rule_id not in _rules_behind(decision), (
        f"agent/policies/: rule {rule_id!r} must not catch {call}, but the engine returned "
        f"{decision!r}. The rule now matches more than the calls listed for it in "
        f"BUILTIN_RULES, so that table no longer describes it. {_ON_PURPOSE}"
    )
