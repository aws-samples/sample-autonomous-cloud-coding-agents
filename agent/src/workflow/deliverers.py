"""Registry of ``deliver_artifact`` deliverers (#248, ADR-014 addendum 2026-06-08).

A workflow's ``deliver_artifact`` step names a *deliverer* in its ``target``
field; that name resolves here. This mirrors the step-handler registry pattern
(``STEP_HANDLERS`` in ``runner.py``): a new delivery method is a registered
deliverer, **not** a schema change — ``target`` is an open string, and the
closed set of valid names lives in ``DELIVERERS`` rather than a JSON-Schema enum.

Each deliverer declares the terminal outcomes it ``produces`` so the cross-field
validator (rule 11) can check a workflow's declared ``terminal_outcomes.primary``
is actually produced by some step — the single source of truth for the old
``_DELIVER_TARGET_OUTCOMES`` map, now registry-driven.

The shared *plumbing* contract every deliverer builds on is frozen in the
ADR-014 addendum: artifacts upload to a task-scoped key ``artifacts/{task_id}/``
in the platform artifacts bucket, the agent SessionRole carries a prefix-scoped
IAM grant, a per-artifact size limit applies, and the delivered URL surfaces on
``TaskDetail``. The deliverer *implementations* land in Phase 3 (#248); this
module pins only the contract — names + produced outcomes — so the Phase-0
schema can freeze.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Deliverer:
    """A named ``deliver_artifact`` target and the terminal outcomes it yields.

    ``produces`` is the set of ``terminal_outcomes`` values this deliverer can
    satisfy (e.g. an S3 upload produces ``artifact``; a comment post produces
    ``comment``). Used by validator rule 11; the runtime handler (Phase 3) will
    look up the same registry to dispatch.
    """

    name: str
    produces: frozenset[str] = field(default_factory=frozenset)


# First-party deliverers. The three names preserve the exact produced-outcome
# sets of the pre-addendum ``_DELIVER_TARGET_OUTCOMES`` enum, so no existing
# workflow / fixture / golden vector changes behavior — the closed enum is
# widened to an open string + this registry, not redefined.
DELIVERERS: dict[str, Deliverer] = {
    "s3": Deliverer("s3", frozenset({"artifact"})),
    "comment": Deliverer("comment", frozenset({"comment"})),
    "s3_and_comment": Deliverer("s3_and_comment", frozenset({"artifact", "comment"})),
}

# Terminal outcomes that any deliver_artifact deliverer can produce (union over
# the registry) — the set rule 11 treats as "deliver_artifact-backed".
DELIVER_OUTCOMES: frozenset[str] = frozenset().union(
    *(d.produces for d in DELIVERERS.values())
)


def produced_outcomes(target: str | None) -> frozenset[str]:
    """Terminal outcomes a deliver_artifact ``target`` produces.

    An unset target stays **lenient** (returns the full deliver outcome set):
    the runtime default deliverer is not pinned in the schema, so the validator
    must not flag a false positive on an unset field. An unknown name returns
    the empty set (it produces nothing the validator can vouch for).
    """
    if target is None:
        return DELIVER_OUTCOMES
    deliverer = DELIVERERS.get(target)
    return deliverer.produces if deliverer is not None else frozenset()
