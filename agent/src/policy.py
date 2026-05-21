"""Cedar policy engine — three-outcome (allow / deny / require-approval).

Uses cedarpy (in-process Cedar evaluation) to enforce per-task-type tool
restrictions. See ``docs/design/CEDAR_HITL_GATES.md`` for the full design;
short summary below.

**Three outcomes** (§2, §6.2). Each ``evaluate_tool_use`` call walks up to
two Cedar evaluations interleaved with in-process caches:

    1. Hard-deny Cedar eval (agent/policies/hard_deny.cedar + blueprint hard).
       Absolute; no --pre-approve scope or blueprint disable can bypass.
    2. Approval allowlist fast-path (tool_type, tool_group, bash_pattern,
       write_path, all_session scopes). Skips human prompt for pre-approved
       patterns.
    2.5 Recent-decision cache: same (tool_name, input_sha256) within 60s of a
        DENIED/TIMED_OUT outcome auto-denies. Session-scoped, cleared on
        container restart (§12.8).
    3. Soft-deny Cedar eval (agent/policies/soft_deny.cedar + blueprint soft).
       Match → REQUIRE_APPROVAL with merged annotations; rule-scope allowlist
       match → ALLOW; no match → fall through to step 4.
    4. Default ALLOW.

**Cedar-entity conventions** preserved from Phase 1: user-supplied values
(bash commands, file paths) use sentinel resource IDs (``Agent::File::file``,
``Agent::BashCommand::command``) with the real value in ``context.command`` /
``context.file_path``, because Cedar entity UIDs cannot contain arbitrary
characters.

**Annotations** expected on every rule in hard_deny/soft_deny files
(§5.2): ``@rule_id`` (globally unique, kebab/snake_case), ``@tier``
("hard"|"soft"), ``@approval_timeout_s`` (int seconds ≥ 30; soft-deny
only), ``@severity`` ("low"|"medium"|"high"; soft-deny only), ``@category``
(free-form; UX grouping). Annotation recovery goes through cedarpy's
``policies_to_json_str()``; the round-trip contract is locked by
``tests/test_cedarpy_annotations_contract.py``.

**Fail-closed posture** (§13): any cedarpy exception during evaluation
returns ``Outcome.DENY`` with reason ``"fail-closed: <ExceptionType>"``.
Invalid blueprint policies raise at ``PolicyEngine.__init__`` (task fails
to start rather than running with broken rules).

Example — correct custom policy::

    @tier("soft")
    @rule_id("webfetch_any")
    @severity("medium")
    forbid (principal, action == Agent::Action::"invoke_tool",
            resource == Agent::Tool::"WebFetch");

Example — WILL NOT WORK (resource is always the sentinel UID)::

    forbid (principal, action == Agent::Action::"execute_bash",
        resource == Agent::BashCommand::"curl http://evil.com");
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from fnmatch import fnmatch
from pathlib import Path
from typing import TYPE_CHECKING

from shell import log

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

# ---------------------------------------------------------------------------
# Constants (§3, §5.2, §12.9)
# ---------------------------------------------------------------------------

FLOOR_TIMEOUT_S: int = 30  # §6 decision #6: rejected below this at load
WARN_TIMEOUT_S: int = 120  # IMPL-25: sub-120s emits WARN on blueprint load
DEFAULT_TASK_TIMEOUT_S: int = 300  # §6 decision #6 default


def _load_shared_constants() -> dict:
    """Read ``contracts/constants.json`` (S9 — see ``contracts/constants.md``).

    Two candidate paths cover both the deployed image
    (``/app/contracts/constants.json`` — Dockerfile copies ``contracts/``
    to ``/app/contracts``) and the local repo layout
    (``<repo>/contracts/constants.json`` — for tests + dev). Fail-fast on
    missing: a missing contract should crash import, not silently fall
    back to literals that would re-introduce the drift the contract is
    designed to prevent.
    """
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "contracts" / "constants.json",  # /app/contracts/
        here.parent.parent.parent / "contracts" / "constants.json",  # <repo>/contracts/
    ]
    for path in candidates:
        if path.is_file():
            return json.loads(path.read_text())
    raise FileNotFoundError(
        "contracts/constants.json not found; checked: " + ", ".join(str(p) for p in candidates),
    )


_SHARED_CONSTANTS = _load_shared_constants()
_AGC = _SHARED_CONSTANTS["approval_gate_cap"]
DEFAULT_APPROVAL_GATE_CAP: int = int(_AGC["default"])  # decision #13 default
APPROVAL_GATE_CAP_MIN: int = int(_AGC["min"])
APPROVAL_GATE_CAP_MAX: int = int(_AGC["max"])
CACHE_MAX_ENTRIES: int = 50  # §12.9: decoupled from approvalGateCap
CACHE_TTL_S: float = 60.0  # §12.8 sliding-window TTL on DENIED/TIMED_OUT
POLICIES_MAX_BYTES: int = 64 * 1024  # finding #12: reject blueprints > 64 KB
APPROVAL_RATE_LIMIT: int = 20  # §12.9 per-container per-minute approval writes
APPROVAL_RATE_WINDOW_S: float = 60.0  # sliding window paired with APPROVAL_RATE_LIMIT

_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2}
_DEFAULT_SEVERITY = "medium"
_VALID_SEVERITIES = frozenset(_SEVERITY_ORDER)
_VALID_TIERS = frozenset({"hard", "soft"})

# Tool group membership (§6.4 decision #21). Resolves tool_group:file_write
# scope to {Write, Edit} at runtime.
TOOL_GROUPS: dict[str, frozenset[str]] = {
    "file_write": frozenset({"Write", "Edit"}),
}

# Location of built-in policy files. Resolved relative to this module so the
# Docker image can ship them alongside src/.
_POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"


# ---------------------------------------------------------------------------
# Outcome + PolicyDecision (§6.1)
# ---------------------------------------------------------------------------


class Outcome(StrEnum):
    """Three-outcome model returned by ``evaluate_tool_use``.

    REQUIRE_APPROVAL is the soft-deny surface: the hook pauses the tool call
    and awaits a human decision. ALLOW / DENY are absolute from the engine's
    perspective — the hook maps them to the SDK's binary permit/forbid API.
    """

    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


class PolicyDecision:
    """Result of a Cedar policy evaluation.

    Fields beyond ``outcome`` + ``reason`` + ``duration_ms`` are populated
    only on ``REQUIRE_APPROVAL``. ``.allowed`` is the backward-compat shim
    for Phase 1a/1b/2 callers that predate the three-outcome engine and
    treat this as a simple allow/deny boolean.

    Not a dataclass — a custom ``__init__`` supports BOTH the new
    ``outcome=...``-keyed form and the legacy ``allowed=...``-keyed form
    so Phase 1 tests keep working without caller changes. Instances are
    immutable by convention (no mutator methods); callers should treat
    them as read-only.
    """

    __slots__ = (
        "cache_hit_metadata",
        "duration_ms",
        "matching_rule_ids",
        "outcome",
        "reason",
        "severity",
        "timeout_s",
    )

    def __init__(
        self,
        *,
        outcome: Outcome | None = None,
        allowed: bool | None = None,  # Legacy Phase 1 kwarg
        reason: str = "",
        timeout_s: int | None = None,
        severity: str | None = None,
        matching_rule_ids: tuple[str, ...] = (),
        duration_ms: float = 0.0,
        cache_hit_metadata: dict | None = None,
    ) -> None:
        if outcome is None and allowed is None:
            raise TypeError("PolicyDecision requires either outcome= or allowed=")
        if outcome is not None and allowed is not None:
            raise TypeError("PolicyDecision: pass either outcome= or allowed=, not both")
        if outcome is None:
            outcome = Outcome.ALLOW if allowed else Outcome.DENY
        self.outcome = outcome
        self.reason = reason
        self.timeout_s = timeout_s
        self.severity = severity
        self.matching_rule_ids = matching_rule_ids
        self.duration_ms = duration_ms
        # IMPL-23: populated only when Step 2.5 of evaluate_tool_use returns
        # a cache-hit DENY. Contains the payload for the `policy_decision`
        # milestone with `decision_source="recent_decision_cache"`; the hook
        # forwards it to progress_writer.write_policy_decision_cached().
        # Observability-only — NOT part of __eq__/__hash__: two cache-hit
        # decisions with different original_decision_ts values still
        # represent the same deny outcome.
        self.cache_hit_metadata = cache_hit_metadata

    @property
    def allowed(self) -> bool:
        """True only when outcome == ALLOW. DENY and REQUIRE_APPROVAL both
        map to False so legacy ``if not decision.allowed: return deny`` callers
        keep blocking soft-deny hits (preserving at-rest behavior until the
        PreToolUse hook is extended to the three-outcome path in Chunk 3).
        """
        return self.outcome == Outcome.ALLOW

    def __repr__(self) -> str:
        base = (
            f"PolicyDecision(outcome={self.outcome.value!r}, "
            f"reason={self.reason!r}, duration_ms={self.duration_ms}"
        )
        if self.outcome == Outcome.REQUIRE_APPROVAL:
            return (
                f"{base}, timeout_s={self.timeout_s}, "
                f"severity={self.severity!r}, "
                f"matching_rule_ids={self.matching_rule_ids!r})"
            )
        return base + ")"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, PolicyDecision):
            return NotImplemented
        return (
            self.outcome == other.outcome
            and self.reason == other.reason
            and self.timeout_s == other.timeout_s
            and self.severity == other.severity
            and self.matching_rule_ids == other.matching_rule_ids
            and self.duration_ms == other.duration_ms
        )

    def __hash__(self) -> int:
        return hash(
            (
                self.outcome,
                self.reason,
                self.timeout_s,
                self.severity,
                self.matching_rule_ids,
                self.duration_ms,
            )
        )

    @classmethod
    def allow(cls, reason: str = "permitted", duration_ms: float = 0.0) -> PolicyDecision:
        return cls(outcome=Outcome.ALLOW, reason=reason, duration_ms=duration_ms)

    @classmethod
    def deny(cls, reason: str, duration_ms: float = 0.0) -> PolicyDecision:
        return cls(outcome=Outcome.DENY, reason=reason, duration_ms=duration_ms)

    @classmethod
    def require_approval(
        cls,
        reason: str,
        timeout_s: int,
        severity: str,
        matching_rule_ids: tuple[str, ...],
        duration_ms: float = 0.0,
    ) -> PolicyDecision:
        return cls(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason=reason,
            timeout_s=timeout_s,
            severity=severity,
            matching_rule_ids=matching_rule_ids,
            duration_ms=duration_ms,
        )


# ---------------------------------------------------------------------------
# Allowlist (§6.4)
# ---------------------------------------------------------------------------


@dataclass
class _CachedDecision:
    """In-process recent-decision cache entry.

    ``inserted_at`` is a monotonic timestamp used for TTL/LRU; it is NOT
    safe to surface in events (monotonic clocks aren't wall-clock and
    restart at container boot). ``original_decision_ts`` is the ISO-8601
    wall-clock string captured at record time so IMPL-23 cache-hit
    events can report when the original decision landed.
    """

    decision: str  # "DENIED" | "TIMED_OUT"
    reason: str
    inserted_at: float
    original_decision_ts: str


class ApprovalAllowlist:
    """Runtime scope allowlist, seeded from ``initial_approvals`` at task start.

    See §6.4. ``matches`` checks tool-scope fast paths (all_session,
    tool_type, tool_group, bash_pattern, write_path); rule-scope matches
    are checked POST soft-deny-eval in ``evaluate_tool_use`` because
    rule_ids are not known until Cedar reports matching policies.
    """

    def __init__(self, initial_scopes: list[str] | None = None) -> None:
        self._all_session = False
        self._tool_types: set[str] = set()
        self._tool_groups: set[str] = set()
        self._rule_ids: set[str] = set()
        self._bash_patterns: list[str] = []
        self._write_path_patterns: list[str] = []

        for scope in initial_scopes or []:
            self.add(scope)

    def add(self, scope: str) -> None:
        """Parse + install a scope. Raises ValueError on unknown prefixes.

        Whitespace around both the prefix and the value is stripped so
        ``"tool_type: Read"`` and ``" tool_type:Read "`` normalize to the
        same internal state; empty-after-strip values are rejected so
        ``"tool_type:"`` fails loud (finding #6 from Chunk 2 review).
        Case is preserved verbatim — ``"tool_type:read"`` will not match
        the ``"Read"`` tool name at runtime. That's intentional (Cedar
        `like` is case-sensitive) but the CLI surfaces a WARN on uppercase
        ``write_path:`` globs to flag the dev-vs-prod fnmatch footgun
        (§5.5 finding #15).
        """
        normalized = scope.strip()
        if normalized == "all_session":
            self._all_session = True
            return
        prefix, sep, value = normalized.partition(":")
        if not sep:
            raise ValueError(f"unknown scope: {scope!r}")
        value = value.strip()
        if not value:
            raise ValueError(f"scope {prefix!r} missing value (got {scope!r})")
        if prefix == "tool_type":
            self._tool_types.add(value)
        elif prefix == "tool_group":
            if value not in TOOL_GROUPS:
                raise ValueError(f"unknown tool_group: {value!r}")
            self._tool_groups.add(value)
        elif prefix == "rule":
            self._rule_ids.add(value)
        elif prefix == "bash_pattern":
            self._bash_patterns.append(value)
        elif prefix == "write_path":
            self._write_path_patterns.append(value)
        else:
            raise ValueError(f"unknown scope: {scope!r}")

    @property
    def rule_ids(self) -> frozenset[str]:
        """Snapshot of rule-ID scopes, checked post-soft-deny in the engine."""
        return frozenset(self._rule_ids)

    def matches(self, tool_name: str, tool_input: dict) -> bool:
        """Return True if a non-rule scope pre-approves this tool call."""
        if self._all_session:
            return True
        if tool_name in self._tool_types:
            return True
        for group in self._tool_groups:
            if tool_name in TOOL_GROUPS[group]:
                return True
        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            # fnmatch semantics documented as Cedar-`like` superset (§5.5).
            if any(fnmatch(cmd, pat) for pat in self._bash_patterns):
                return True
        if tool_name in ("Write", "Edit"):
            fp = tool_input.get("file_path", "")
            if any(fnmatch(fp, pat) for pat in self._write_path_patterns):
                return True
        return False


# ---------------------------------------------------------------------------
# Recent-decision cache (§6.2, §12.8, §12.9)
# ---------------------------------------------------------------------------


class RecentDecisionCache:
    """In-process LRU cache of recent DENIED/TIMED_OUT outcomes.

    Bounded at 50 entries (``CACHE_MAX_ENTRIES``) INDEPENDENT of the per-task
    ``approvalGateCap`` (§12.9): a blueprint that raises the gate cap to 200
    does NOT get a larger cache. Two concerns, two bounds: cap = UX ceiling,
    cache = engine memory bound.

    TTL is 60s on each entry; ``get`` skips expired entries without eviction
    (eviction happens lazily on overflow). Cache is populated only on
    DENIED/TIMED_OUT — NEVER on APPROVED (so a just-approved call does not
    auto-deny on the next identical invocation).

    **Session-scoped**: cleared on container restart. Documented caveat in
    §12.8 — not a bug. Persistent cache is §17.5 future work.
    """

    def __init__(
        self,
        *,
        max_entries: int = CACHE_MAX_ENTRIES,
        ttl_s: float = CACHE_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._entries: OrderedDict[tuple[str, str], _CachedDecision] = OrderedDict()
        # Rule-level cache: keyed by ``(tool_name, rule_id)``, populated
        # alongside the input-hash cache whenever a DENIED outcome
        # carries ``matching_rule_ids``. The input-hash cache catches
        # literal retries of the same command; the rule cache catches
        # *semantic* retries — e.g. a user denied ``git push --force
        # origin branch-a`` should also fast-deny ``git push --force
        # origin branch-b`` because both resolve to the same
        # ``force_push_any`` rule. Without this the agent can burn
        # through its max_turns budget hammering on variations the
        # user has already said no to (observed in E2E Phase 4).
        self._rule_entries: OrderedDict[tuple[str, str], _CachedDecision] = OrderedDict()
        self._max_entries = max_entries
        self._ttl_s = ttl_s
        self._clock = clock

    def record(
        self,
        tool_name: str,
        input_sha256: str,
        decision: str,
        reason: str,
        original_decision_ts: str | None = None,
    ) -> None:
        """Insert a DENIED/TIMED_OUT entry. Evicts LRU on overflow.

        ``original_decision_ts`` is the ISO-8601 wall-clock time of the
        original approval decision that seeded this cache entry. Surfaced
        on subsequent cache-hit events (IMPL-23) so operators can correlate
        cache-driven denies back to the originating gate. Falsy values
        (``None`` or empty string) fall back to "now" at record time, so
        legacy test callers and corrupted outcome rows keep working.
        """
        if decision not in ("DENIED", "TIMED_OUT"):
            raise ValueError(f"RecentDecisionCache only accepts DENIED/TIMED_OUT, got {decision!r}")
        key = (tool_name, input_sha256)
        self._entries[key] = _CachedDecision(
            decision=decision,
            reason=reason,
            inserted_at=self._clock(),
            original_decision_ts=original_decision_ts
            or datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def record_rule_decision(
        self,
        tool_name: str,
        rule_id: str,
        decision: str,
        reason: str,
        original_decision_ts: str | None = None,
    ) -> None:
        """Insert a rule-level DENIED/TIMED_OUT entry.

        Called once per ``matching_rule_ids`` entry on a DENIED outcome
        so subsequent tool calls that hit the same rule are
        auto-denied without a fresh approval round-trip. Only ``DENIED``
        is recorded here — ``TIMED_OUT`` is more ambiguous (user was
        away, not actively refusing) so the existing input-hash cache
        is the safer bound for it.
        """
        if decision != "DENIED":
            raise ValueError(
                f"record_rule_decision only accepts DENIED, got {decision!r} "
                "(TIMED_OUT is handled by the input-hash cache only)"
            )
        key = (tool_name, rule_id)
        self._rule_entries[key] = _CachedDecision(
            decision=decision,
            reason=reason,
            inserted_at=self._clock(),
            original_decision_ts=original_decision_ts
            or datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )
        self._rule_entries.move_to_end(key)
        while len(self._rule_entries) > self._max_entries:
            self._rule_entries.popitem(last=False)

    def get(self, tool_name: str, input_sha256: str) -> _CachedDecision | None:
        """Return a non-expired cached entry or None."""
        key = (tool_name, input_sha256)
        entry = self._entries.get(key)
        if entry is None:
            return None
        if self._clock() - entry.inserted_at > self._ttl_s:
            # Expired; drop it opportunistically.
            del self._entries[key]
            return None
        # LRU-touch so an active retry pattern stays in the window.
        self._entries.move_to_end(key)
        return entry

    def get_rule_decision(
        self, tool_name: str, rule_ids: Iterable[str]
    ) -> tuple[str, _CachedDecision] | None:
        """Return ``(rule_id, entry)`` for the first non-expired rule hit, or None.

        Returns the matched rule_id separately from the entry so the
        caller can surface it on the cache-hit metadata for operators.
        """
        for rule_id in rule_ids:
            key = (tool_name, rule_id)
            entry = self._rule_entries.get(key)
            if entry is None:
                continue
            if self._clock() - entry.inserted_at > self._ttl_s:
                del self._rule_entries[key]
                continue
            self._rule_entries.move_to_end(key)
            return rule_id, entry
        return None

    def __len__(self) -> int:
        return len(self._entries)


# ---------------------------------------------------------------------------
# Annotation handling (§5.2, §6.3, §12.4)
# ---------------------------------------------------------------------------


@dataclass
class _ParsedRule:
    """Internal shape: one Cedar policy's annotations, keyed by policy_id."""

    policy_id: str  # Internal cedarpy ID (e.g. "policy0")
    rule_id: str | None
    tier: str | None
    effect: str | None  # "permit" or "forbid" — used to gate base_permit exemption
    approval_timeout_s: int | None
    severity: str | None
    category: str | None


def _parse_policy_annotations(cedarpy_module, policies_text: str) -> list[_ParsedRule]:
    """Parse every static policy's annotations via cedarpy.policies_to_json_str.

    Returns a list in cedarpy's positional order. Raises on malformed input.
    """
    try:
        parsed = json.loads(cedarpy_module.policies_to_json_str(policies_text))
    except Exception as exc:
        raise ValueError(f"Cedar policy parse failed: {type(exc).__name__}: {exc}") from exc

    rules: list[_ParsedRule] = []
    for pid, body in parsed.get("staticPolicies", {}).items():
        ann = body.get("annotations", {}) or {}
        timeout_raw = ann.get("approval_timeout_s")
        timeout: int | None = None
        if timeout_raw is not None:
            try:
                timeout = int(timeout_raw)
            except (TypeError, ValueError):
                raise ValueError(
                    f"policy {pid!r}: @approval_timeout_s must be integer, got {timeout_raw!r}"
                ) from None
        rules.append(
            _ParsedRule(
                policy_id=pid,
                rule_id=ann.get("rule_id"),
                tier=ann.get("tier"),
                effect=body.get("effect"),
                approval_timeout_s=timeout,
                severity=ann.get("severity"),
                category=ann.get("category"),
            )
        )
    return rules


def _validate_tier(rules: list[_ParsedRule], expected_tier: str, source: str) -> None:
    """Every rule in a tier file MUST declare matching @tier + @rule_id.

    Exception: ``base_permit`` is allowed without @tier ONLY when it's a
    ``permit`` effect — the neutral catch-all at the top of each tier.
    A misnamed ``forbid`` annotated ``@rule_id("base_permit")`` would
    otherwise bypass validation entirely (silent-failure finding #7 from
    Chunk 2 review); restricting the exemption to ``effect == "permit"``
    forces genuine forbid rules through the regular validation path.
    """
    seen_rule_ids: set[str] = set()
    for rule in rules:
        # Unannotated base permit with `permit` effect is the reserved
        # catch-all; any other shape (forbid with rule_id "base_permit",
        # permit with a non-neutral tier annotation) falls through to the
        # regular validation below.
        if rule.rule_id == "base_permit" and rule.tier is None and rule.effect == "permit":
            seen_rule_ids.add("base_permit")
            continue
        if rule.tier is None:
            raise ValueError(f"{source}: policy {rule.policy_id!r} missing @tier annotation")
        if rule.tier != expected_tier:
            raise ValueError(
                f"{source}: policy {rule.rule_id or rule.policy_id!r} has "
                f"@tier({rule.tier!r}) but lives in the {expected_tier!r} file"
            )
        if not rule.rule_id:
            raise ValueError(f"{source}: policy {rule.policy_id!r} missing @rule_id annotation")
        if rule.rule_id in seen_rule_ids:
            raise ValueError(f"{source}: duplicate @rule_id {rule.rule_id!r}")
        seen_rule_ids.add(rule.rule_id)
        if rule.tier == "soft":
            if rule.approval_timeout_s is not None:
                if rule.approval_timeout_s < FLOOR_TIMEOUT_S:
                    raise ValueError(
                        f"{source}: rule {rule.rule_id!r} has "
                        f"@approval_timeout_s({rule.approval_timeout_s}) below "
                        f"floor {FLOOR_TIMEOUT_S}s"
                    )
                if rule.approval_timeout_s < WARN_TIMEOUT_S:
                    # IMPL-25: advisory WARN, not strict reject.
                    log(
                        "WARN",
                        f"{source}: rule {rule.rule_id!r} has "
                        f"@approval_timeout_s({rule.approval_timeout_s}) below "
                        f"{WARN_TIMEOUT_S}s — humans rarely respond that fast; "
                        f"consider raising",
                    )
            if rule.severity and rule.severity not in _VALID_SEVERITIES:
                raise ValueError(
                    f"{source}: rule {rule.rule_id!r} @severity must be one of "
                    f"{sorted(_VALID_SEVERITIES)}, got {rule.severity!r}"
                )


def _merge_annotations(
    rules: list[_ParsedRule],
    matching_policy_ids: list[str],
    task_default_timeout_s: int,
) -> tuple[list[str], int, str]:
    """Merge annotations across multiple matching soft-deny policies (§6.3).

    Timeout: min across rules (clamped by FLOOR_TIMEOUT_S). Severity: max.
    rule_ids preserved in order of match. If a matching rule has no
    annotation data (shouldn't happen post-validation), falls back to the
    policy ID.
    """
    by_id = {r.policy_id: r for r in rules}
    rule_ids: list[str] = []
    timeouts: list[int] = []
    severities: list[str] = []
    for pid in matching_policy_ids:
        rule = by_id.get(pid)
        if rule is None:
            continue
        rule_ids.append(rule.rule_id or pid)
        if rule.approval_timeout_s is not None:
            timeouts.append(rule.approval_timeout_s)
        severities.append(rule.severity or _DEFAULT_SEVERITY)

    timeouts.append(task_default_timeout_s)
    # Defensive only: load-time validation already rejects below-floor values,
    # but the clamp costs nothing and protects against a future caller that
    # bypasses validation (e.g. programmatic rule injection).
    effective_timeout = max(FLOOR_TIMEOUT_S, min(timeouts))

    if severities:
        effective_severity = max(severities, key=lambda s: _SEVERITY_ORDER.get(s, 0))
    else:
        effective_severity = _DEFAULT_SEVERITY

    return rule_ids, effective_timeout, effective_severity


# ---------------------------------------------------------------------------
# Policy-text loaders
# ---------------------------------------------------------------------------


def _load_builtin_policies() -> tuple[str, str]:
    """Read hard_deny.cedar + soft_deny.cedar from the agent/policies/ dir.

    Returns (hard_text, soft_text). Raises on missing files so the engine
    fails loudly rather than running with stale or absent defaults.
    """
    hard_path = _POLICIES_DIR / "hard_deny.cedar"
    soft_path = _POLICIES_DIR / "soft_deny.cedar"
    if not hard_path.is_file():
        raise FileNotFoundError(f"missing built-in hard-deny policies: {hard_path}")
    if not soft_path.is_file():
        raise FileNotFoundError(f"missing built-in soft-deny policies: {soft_path}")
    return hard_path.read_text(), soft_path.read_text()


def _sha256_tool_input(tool_input: dict) -> str:
    """Stable SHA-256 over the tool_input dict (sorted keys, utf-8)."""
    return hashlib.sha256(json.dumps(tool_input, sort_keys=True).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# PolicyEngine — the main three-outcome engine (§6.2)
# ---------------------------------------------------------------------------


class PolicyEngine:
    """Evaluate tool-use requests against Cedar policies with three outcomes.

    Construction loads the built-in hard_deny + soft_deny policy files,
    concatenates any blueprint-provided rules (subject to 64 KB cap and
    disable-list validation), probes a test authorization to catch syntax
    errors early, and seeds the approval allowlist from ``initial_approvals``.

    Legacy callers that pass ``extra_policies=[...]`` (Phase 1 shape) are
    supported in backward-compat mode: the extra text is appended to the
    soft-deny tier WITHOUT strict annotation validation. New callers in
    Chunks 3+ should use ``blueprint_hard_policies`` / ``blueprint_soft_policies``
    / ``blueprint_disable`` / ``initial_approvals`` / ``approval_gate_cap``.
    """

    def __init__(
        self,
        task_type: str,
        repo: str,
        *,
        extra_policies: list[str] | None = None,
        blueprint_hard_policies: str | None = None,
        blueprint_soft_policies: str | None = None,
        blueprint_disable: list[str] | None = None,
        initial_approvals: list[str] | None = None,
        approval_gate_cap: int = DEFAULT_APPROVAL_GATE_CAP,
        initial_approval_gate_count: int = 0,
        task_default_timeout_s: int = DEFAULT_TASK_TIMEOUT_S,
    ) -> None:
        self._task_type = task_type
        self._repo = repo
        self._disabled = False
        self._task_default_timeout_s = task_default_timeout_s

        # Bounds check on approval_gate_cap (decision #13).
        if not APPROVAL_GATE_CAP_MIN <= approval_gate_cap <= APPROVAL_GATE_CAP_MAX:
            raise ValueError(
                f"approval_gate_cap must be in "
                f"[{APPROVAL_GATE_CAP_MIN}, {APPROVAL_GATE_CAP_MAX}], "
                f"got {approval_gate_cap}"
            )
        self._approval_gate_cap = approval_gate_cap

        # Negative seeds are a caller bug, not a container-restart state.
        if initial_approval_gate_count < 0:
            raise ValueError(
                f"initial_approval_gate_count must be >= 0, got {initial_approval_gate_count}"
            )

        # §12.9 per-task gate counter + per-container sliding-window rate limit.
        # The counter is session-scoped within a container but seeded from the
        # persisted TaskTable value (§13.6) so container restarts resume the
        # cumulative gate budget instead of resetting to 0. The rate-limit
        # window stays per-container by design (§13.6 finding #10 scenario).
        self._approval_gate_count: int = initial_approval_gate_count
        self._approvals_last_minute: deque[float] = deque()
        # §6.5 queue consumed by ``_denial_between_turns_hook``. Each entry
        # is ``{"request_id", "reason", "decided_at"}``; reason is already
        # sanitized by DenyTaskFn (§12.6).
        self._denial_injection_queue: list[dict] = []
        # IMPL-26: ``approval_ceiling_shrinking`` is emit-once per task.
        self._emitted_ceiling_shrinking: bool = False

        # Validate task_type (non-fatal WARN to match Phase 1 behavior).
        from models import TaskType

        try:
            TaskType(task_type)
        except ValueError:
            log("WARN", f"Unknown task_type '{task_type}' — using default deny-list policies")

        # Import cedarpy lazily so the module still loads in environments
        # without the native extension (tests can monkey-patch).
        try:
            import cedarpy

            self._cedarpy = cedarpy
        except ImportError:
            log("ERROR", "cedarpy not available — policy engine disabled (fail-closed)")
            self._cedarpy = None
            self._disabled = True
            # Still construct empty state so legacy callers do not crash
            # during attribute access.
            self._hard_policies = ""
            self._soft_policies = ""
            self._hard_rules: list[_ParsedRule] = []
            self._soft_rules: list[_ParsedRule] = []
            self._allowlist = ApprovalAllowlist()
            self._cache = RecentDecisionCache()
            return

        # Load built-in tiers.
        try:
            builtin_hard, builtin_soft = _load_builtin_policies()
        except FileNotFoundError as exc:
            # Fatal: without built-ins the engine's hard-deny invariants
            # (rm -rf /, .git writes, DROP TABLE) are missing.
            raise RuntimeError(str(exc)) from exc

        # Blueprint customization: append blueprint rules into the tiers.
        hard_text = builtin_hard
        if blueprint_hard_policies:
            hard_text = f"{hard_text}\n{blueprint_hard_policies}"
        soft_text = builtin_soft

        # Legacy ``extra_policies`` goes into soft tier with a synthetic
        # wrapper (@tier("soft") + @rule_id("legacy_extra_N")). Cedar's
        # annotation semantics on duplicate keys within a single policy
        # are implementation-defined (parse error in most versions), so
        # we REJECT legacy text that already declares @tier or @rule_id
        # (finding #2 from Chunk 2 review) instead of silently picking
        # one interpretation. Callers should migrate to
        # blueprint_soft_policies / blueprint_hard_policies with fully
        # annotated rules.
        legacy_extra: list[str] = []
        if extra_policies:
            for idx, policy_text in enumerate(extra_policies):
                if "@tier(" in policy_text or "@rule_id(" in policy_text:
                    raise ValueError(
                        f"extra_policies[{idx}] already declares @tier or "
                        f"@rule_id; the legacy extra_policies kwarg is for "
                        f"UNANNOTATED rules only. Migrate annotated rules "
                        f"to blueprint_soft_policies / blueprint_hard_policies."
                    )
                legacy_rule_id = f"legacy_extra_{idx}"
                legacy_extra.append(f'@tier("soft")\n@rule_id("{legacy_rule_id}")\n{policy_text}')
        if blueprint_soft_policies:
            soft_text = f"{soft_text}\n{blueprint_soft_policies}"
        if legacy_extra:
            soft_text = soft_text + "\n" + "\n".join(legacy_extra)

        # 64 KB cap on combined blueprint text (finding #12). Built-ins do
        # not count against the cap — they are trusted platform content.
        blueprint_text = "".join(filter(None, [blueprint_hard_policies, blueprint_soft_policies]))
        if len(blueprint_text.encode("utf-8")) > POLICIES_MAX_BYTES:
            raise ValueError(
                f"cedar_policies exceeds {POLICIES_MAX_BYTES // 1024} KB cap "
                f"({len(blueprint_text.encode('utf-8'))} bytes)"
            )

        # Parse + validate annotations on each tier.
        try:
            self._hard_rules = _parse_policy_annotations(self._cedarpy, hard_text)
            _validate_tier(self._hard_rules, "hard", "hard_deny")
        except ValueError as exc:
            # Blueprint or built-in problem — fail loud at task start.
            raise ValueError(f"hard-deny policy validation failed: {exc}") from exc

        try:
            self._soft_rules = _parse_policy_annotations(self._cedarpy, soft_text)
            # Legacy extra_policies synthetic rules get generic "legacy_extra_N"
            # @rule_id values; those are accepted by the validator.
            _validate_tier(self._soft_rules, "soft", "soft_deny")
        except ValueError as exc:
            raise ValueError(f"soft-deny policy validation failed: {exc}") from exc

        # blueprint_disable: reject any entry that names a built-in hard-deny
        # rule (finding #9, §5.1). Built-in hard rule IDs come from the
        # original builtin_hard text, NOT the concatenated hard_text.
        builtin_hard_rule_ids = {
            r.rule_id
            for r in _parse_policy_annotations(self._cedarpy, builtin_hard)
            if r.rule_id and r.tier == "hard"
        }
        for disable_id in blueprint_disable or []:
            if disable_id in builtin_hard_rule_ids:
                raise ValueError(
                    f"blueprint disable[{disable_id!r}]: cannot disable built-in "
                    f"hard-deny rule; hard-deny is absolute (§5.1, §12.5)"
                )
        # Disabled soft rules are filtered at evaluate_tool_use time: if a
        # soft-deny eval's matching rule_ids are ALL in the disable set,
        # the match is treated as no-match (fall through to ALLOW). If some
        # are disabled but others match, the surviving rule_ids drive the
        # REQUIRE_APPROVAL outcome. See evaluate_tool_use Step 3.
        self._disabled_rule_ids: set[str] = set(blueprint_disable or [])

        # Rule-ID uniqueness ACROSS tiers. The reserved ``base_permit`` ID
        # is expected to appear in both tiers (each tier needs its own
        # catch-all permit so cedarpy doesn't default-deny non-matching
        # inputs in isolation).
        hard_ids = {r.rule_id for r in self._hard_rules if r.rule_id}
        soft_ids = {r.rule_id for r in self._soft_rules if r.rule_id}
        cross = (hard_ids & soft_ids) - {"base_permit"}
        if cross:
            raise ValueError(f"duplicate @rule_id across tiers: {sorted(cross)}")

        # Probe authorizations on each tier to catch runtime Cedar errors
        # before the first evaluate_tool_use call.
        self._probe_cedar(hard_text, "hard")
        self._probe_cedar(soft_text, "soft")

        self._hard_policies = hard_text
        self._soft_policies = soft_text

        # Approval allowlist + recent-decision cache.
        try:
            self._allowlist = ApprovalAllowlist(initial_approvals)
        except ValueError as exc:
            raise ValueError(f"initial_approvals: {exc}") from exc
        self._cache = RecentDecisionCache()

        log(
            "AGENT",
            f"Cedar policy engine initialized: task_type={task_type}, "
            f"hard_rules={len(self._hard_rules)}, soft_rules={len(self._soft_rules)}, "
            f"pre_approvals={len(initial_approvals) if initial_approvals else 0}, "
            f"approval_gate_cap={approval_gate_cap}, "
            f"initial_approval_gate_count={initial_approval_gate_count}",
        )

    # ---- Public properties -------------------------------------------------

    @property
    def task_type(self) -> str:
        return self._task_type

    @property
    def repo(self) -> str:
        return self._repo

    @property
    def approval_gate_cap(self) -> int:
        return self._approval_gate_cap

    @property
    def task_default_timeout_s(self) -> int:
        return self._task_default_timeout_s

    @property
    def allowlist(self) -> ApprovalAllowlist:
        return self._allowlist

    @property
    def recent_decisions(self) -> RecentDecisionCache:
        return self._cache

    # ---- Approval-gate counters + denial queue (§6.5, §12.9) --------------

    @property
    def approval_gate_count(self) -> int:
        """Session-scoped count of REQUIRE_APPROVAL gates emitted this task."""
        return self._approval_gate_count

    def increment_approval_gate_count(self) -> None:
        """Bump the per-task gate counter (called at row-write time)."""
        self._approval_gate_count += 1

    def record_approval_gate_timestamp(self, now: float | None = None) -> None:
        """Record a new approval-gate timestamp for the sliding rate-limit window."""
        ts = time.monotonic() if now is None else now
        self._approvals_last_minute.append(ts)
        self._prune_rate_window(ts)

    def _prune_rate_window(self, now: float) -> None:
        """Drop timestamps older than ``APPROVAL_RATE_WINDOW_S``."""
        cutoff = now - APPROVAL_RATE_WINDOW_S
        while self._approvals_last_minute and self._approvals_last_minute[0] < cutoff:
            self._approvals_last_minute.popleft()

    @property
    def approvals_in_last_minute(self) -> int:
        """Count of approval-gate writes in the last ``APPROVAL_RATE_WINDOW_S``.

        Prunes the window before returning so callers see the current count.
        """
        self._prune_rate_window(time.monotonic())
        return len(self._approvals_last_minute)

    def queue_denial_injection(
        self, *, request_id: str, reason: str, decided_at: str | None
    ) -> None:
        """Append a denial-injection payload for ``_denial_between_turns_hook``.

        Reason is expected to be pre-sanitized upstream (by ``DenyTaskFn``,
        §12.6). The hook is responsible for XML-escaping at injection time.
        """
        self._denial_injection_queue.append(
            {"request_id": request_id, "reason": reason, "decided_at": decided_at}
        )

    def drain_denial_injections(self) -> list[dict]:
        """Pop and return the queued denial-injection payloads."""
        out = list(self._denial_injection_queue)
        self._denial_injection_queue.clear()
        return out

    def mark_ceiling_shrinking_emitted(self) -> bool:
        """Idempotency latch for ``approval_ceiling_shrinking`` (IMPL-26).

        Returns ``True`` the first time it is called (caller should emit the
        milestone) and ``False`` on every subsequent call.
        """
        if self._emitted_ceiling_shrinking:
            return False
        self._emitted_ceiling_shrinking = True
        return True

    # ---- Probes + low-level evaluation ------------------------------------

    def _probe_cedar(self, policies_text: str, tier_name: str) -> None:
        """Run a synthetic is_authorized call so Cedar rejects bad syntax early."""
        # _probe_cedar is only called from __init__ AFTER the ImportError
        # early-return, so ``_cedarpy`` is guaranteed non-None here.
        if self._cedarpy is None:  # pragma: no cover — invariant guard
            raise RuntimeError("probe called on disabled engine")
        try:
            self._cedarpy.is_authorized(
                {
                    "principal": f'Agent::TaskAgent::"{self._task_type}"',
                    "action": 'Agent::Action::"invoke_tool"',
                    "resource": 'Agent::Tool::"Read"',
                    "context": {"task_type": self._task_type, "repo": self._repo},
                },
                policies_text,
                [
                    {
                        "uid": {"type": "Agent::TaskAgent", "id": self._task_type},
                        "attrs": {},
                        "parents": [],
                    },
                    {"uid": {"type": "Agent::Tool", "id": "Read"}, "attrs": {}, "parents": []},
                ],
            )
        except Exception as exc:
            raise ValueError(
                f"{tier_name}-deny Cedar probe failed: {type(exc).__name__}: {exc}"
            ) from exc

    def _eval_tier(
        self,
        policies_text: str,
        action: str,
        resource_type: str,
        resource_id: str,
        context: dict,
    ) -> tuple[str, list[str]]:
        """Run a single Cedar authorization check against a single tier.

        Returns (decision, matching_policy_ids). ``decision`` is one of
        ``"allow"`` / ``"deny"`` / ``"no_decision"`` (lowercase string).
        ``matching_policy_ids`` is cedarpy's ``diagnostics.reasons`` list
        (internal positional IDs like ``["policy2", "policy3"]``).

        Raises ``RuntimeError`` if cedarpy reports policy-parse errors —
        these are fail-closed hazards (policy text is unusable). The
        outer ``evaluate_tool_use`` catches and maps to Outcome.DENY with
        reason ``"fail-closed: RuntimeError"``.
        """
        request = {
            "principal": f'Agent::TaskAgent::"{self._task_type}"',
            "action": f'Agent::Action::"{action}"',
            "resource": f'{resource_type}::"{resource_id}"',
            "context": context,
        }
        entities = [
            {
                "uid": {"type": "Agent::TaskAgent", "id": self._task_type},
                "attrs": {},
                "parents": [],
            },
            {"uid": {"type": resource_type, "id": resource_id}, "attrs": {}, "parents": []},
        ]
        # _eval_tier is only reached from evaluate_tool_use AFTER the
        # ``_disabled``/``_cedarpy is None`` guard, so the attribute is
        # narrowed to a live module here.
        if self._cedarpy is None:  # pragma: no cover — invariant guard
            raise RuntimeError("eval called on disabled engine")
        result = self._cedarpy.is_authorized(request, policies_text, entities)
        if getattr(result.diagnostics, "errors", []):
            # cedarpy reports parse errors via diagnostics.errors and returns
            # Decision.NoDecision rather than raising — we re-raise so the
            # outer fail-closed handler catches it.
            errors = "; ".join(str(e) for e in result.diagnostics.errors)
            raise RuntimeError(f"Cedar policy parse/eval errors: {errors}")
        decision = result.decision.value.lower()
        if decision not in ("allow", "deny"):
            # NoDecision with no errors → treat as no match at the tier
            # level; caller decides whether that's fail-closed (hard tier)
            # or fall-through (soft).
            return "no_decision", list(result.diagnostics.reasons)
        return decision, list(result.diagnostics.reasons)

    # ---- Three-outcome pipeline -------------------------------------------

    def evaluate_tool_use(self, tool_name: str, tool_input: dict) -> PolicyDecision:
        """Walk the three-outcome pipeline for a single tool call.

        Fail-closed: any cedarpy exception maps to Outcome.DENY with
        reason ``"fail-closed: <ExceptionType>"``.
        """
        start = time.monotonic()

        if self._disabled or self._cedarpy is None:
            return PolicyDecision.deny(
                reason="policy engine unavailable",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        base_context = {"task_type": self._task_type, "repo": self._repo}

        # Compute input_sha separately so a TypeError from json.dumps
        # surfaces with a distinct fail-closed reason instead of being
        # mis-attributed to Cedar evaluation (finding #5 from review).
        try:
            input_sha = _sha256_tool_input(tool_input)
        except (TypeError, ValueError) as exc:
            log(
                "WARN",
                f"tool_input not hashable (fail-closed): {type(exc).__name__}: {exc}",
            )
            return PolicyDecision.deny(
                reason="fail-closed: unhashable_tool_input",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        try:
            # STEP 1 — Hard-deny evaluation (absolute).
            hard_decision = self._eval_for_tool(
                self._hard_policies,
                tool_name,
                tool_input,
                base_context,
                tier_name="hard",
            )
            if hard_decision and hard_decision[0] == "deny":
                rule_ids = _matching_rule_ids(self._hard_rules, hard_decision[1], tier_name="hard")
                reason = (
                    f"Hard-deny: {', '.join(rule_ids)}" if rule_ids else "Hard-deny (unknown rule)"
                )
                return PolicyDecision.deny(
                    reason=reason, duration_ms=(time.monotonic() - start) * 1000
                )

            # STEP 2 — Allowlist fast-path (tool-scope).
            if self._allowlist.matches(tool_name, tool_input):
                return PolicyDecision.allow(
                    reason="Pre-approved by allowlist",
                    duration_ms=(time.monotonic() - start) * 1000,
                )

            # STEP 2.5 — Recent-decision cache.
            cached = self._cache.get(tool_name, input_sha)
            if cached is not None:
                # IMPL-23: attach cache-hit metadata so the hook can emit a
                # `policy_decision` milestone to TaskEventsTable. Keeps the
                # engine pure — policy.py never calls the progress writer.
                return PolicyDecision(
                    outcome=Outcome.DENY,
                    reason=f"Recent {cached.decision} within {int(CACHE_TTL_S)}s: {cached.reason}",
                    duration_ms=(time.monotonic() - start) * 1000,
                    cache_hit_metadata={
                        "tool_name": tool_name,
                        "tool_input_sha256": input_sha,
                        "cached_decision": cached.decision,
                        "cached_reason": cached.reason,
                        "original_decision_ts": cached.original_decision_ts,
                    },
                )

            # STEP 3 — Soft-deny evaluation.
            soft_decision = self._eval_for_tool(
                self._soft_policies,
                tool_name,
                tool_input,
                base_context,
                tier_name="soft",
            )
            if soft_decision and soft_decision[0] == "deny":
                all_matching_ids = _matching_rule_ids(
                    self._soft_rules, soft_decision[1], tier_name="soft"
                )
                # Filter out blueprint-disabled rules (§5.1 `disable:` list).
                # If ALL matches are disabled, the soft-deny hit is neutralized
                # and we fall through to default ALLOW. If some are disabled
                # but others remain, the surviving rules drive REQUIRE_APPROVAL.
                active_ids = [rid for rid in all_matching_ids if rid not in self._disabled_rule_ids]
                if not active_ids:
                    # Every matching rule was disabled by the blueprint.
                    return PolicyDecision.allow(
                        reason="permitted (all matching soft-deny rules disabled by blueprint)",
                        duration_ms=(time.monotonic() - start) * 1000,
                    )
                # Rule-scope allowlist check AFTER the eval: rule_ids are
                # only known once Cedar reports which policies matched.
                if any(rid in self._allowlist.rule_ids for rid in active_ids):
                    return PolicyDecision.allow(
                        reason=f"Allowlist rule: {', '.join(active_ids)}",
                        duration_ms=(time.monotonic() - start) * 1000,
                    )

                # Rule-level recent-deny cache (§12.8 extension).
                # If the user recently denied any of these rule_ids on
                # this tool, fast-deny without a new approval gate.
                # Catches semantic retries the input-hash cache misses
                # (e.g. force-push to a different branch name).
                rule_hit = self._cache.get_rule_decision(tool_name, active_ids)
                if rule_hit is not None:
                    matched_rule_id, cached = rule_hit
                    return PolicyDecision(
                        outcome=Outcome.DENY,
                        reason=(
                            f"Recent {cached.decision} on rule {matched_rule_id!r} "
                            f"within {int(CACHE_TTL_S)}s: {cached.reason}"
                        ),
                        duration_ms=(time.monotonic() - start) * 1000,
                        cache_hit_metadata={
                            "tool_name": tool_name,
                            "tool_input_sha256": input_sha,
                            "matched_rule_id": matched_rule_id,
                            "cached_decision": cached.decision,
                            "cached_reason": cached.reason,
                            "original_decision_ts": cached.original_decision_ts,
                        },
                    )
                # Rebuild the policy-id list for annotation merging, keeping
                # only the policy IDs whose rule_id survived the disable filter.
                active_policy_ids = [
                    pid
                    for pid in soft_decision[1]
                    if _rule_id_for_policy(self._soft_rules, pid) not in self._disabled_rule_ids
                ]
                merged_ids, timeout_s, severity = _merge_annotations(
                    self._soft_rules,
                    active_policy_ids,
                    self._task_default_timeout_s,
                )
                return PolicyDecision.require_approval(
                    reason=f"Soft-deny: {', '.join(merged_ids)}",
                    timeout_s=timeout_s,
                    severity=severity,
                    matching_rule_ids=tuple(merged_ids),
                    duration_ms=(time.monotonic() - start) * 1000,
                )

            # STEP 4 — Default allow.
            return PolicyDecision.allow(
                reason="permitted",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        except Exception as exc:
            log("WARN", f"Cedar evaluation error (fail-closed): {type(exc).__name__}: {exc}")
            return PolicyDecision.deny(
                reason=f"fail-closed: {type(exc).__name__}",
                duration_ms=(time.monotonic() - start) * 1000,
            )

    # ---- Per-action routing ------------------------------------------------

    def _eval_for_tool(
        self,
        policies_text: str,
        tool_name: str,
        tool_input: dict,
        base_context: dict,
        *,
        tier_name: str = "",
    ) -> tuple[str, list[str]] | None:
        """Run the appropriate Cedar eval(s) for a given tool + input.

        Returns the first deny decision + matching policy IDs, or None if
        no eval at this tier matched anything. Mirrors the Phase 1 routing
        so existing tests (invoke_tool sentinel for tool-type, write_file
        for Write/Edit, execute_bash for Bash) keep working.

        ``no_decision`` responses are logged at WARN — Cedar should always
        reach a definite allow/deny given the base_permit catch-all, so
        no_decision means the catch-all is missing or malformed (finding
        #9 from Chunk 2 review). Fall-through to subsequent action evals
        continues either way; the log gives operators signal without
        changing behavior.
        """

        def _run(action: str, resource_type: str, resource_id: str, ctx: dict):
            decision, reasons = self._eval_tier(
                policies_text, action, resource_type, resource_id, ctx
            )
            if decision == "no_decision":
                log(
                    "WARN",
                    f"{tier_name or 'tier'}: Cedar no_decision for "
                    f"action={action!r} tool={tool_name!r} — base_permit "
                    f"catch-all missing or malformed",
                )
            return decision, reasons

        # Check tool-type eval first (invoke_tool on the real tool sentinel).
        invoke_decision, invoke_reasons = _run(
            "invoke_tool", "Agent::Tool", tool_name, base_context
        )
        if invoke_decision == "deny":
            return ("deny", invoke_reasons)

        # Write/Edit: evaluate write_file with file_path in context.
        if tool_name in ("Write", "Edit"):
            file_path = tool_input.get("file_path", "")
            if file_path:
                write_decision, write_reasons = _run(
                    "write_file",
                    "Agent::File",
                    "file",
                    {**base_context, "file_path": file_path},
                )
                if write_decision == "deny":
                    return ("deny", write_reasons)

        # Bash: evaluate execute_bash with command in context.
        if tool_name == "Bash":
            command = tool_input.get("command", "")
            if command:
                bash_decision, bash_reasons = _run(
                    "execute_bash",
                    "Agent::BashCommand",
                    "command",
                    {**base_context, "command": command},
                )
                if bash_decision == "deny":
                    return ("deny", bash_reasons)

        return None


def _matching_rule_ids(
    rules: list[_ParsedRule],
    matching_policy_ids: list[str],
    *,
    tier_name: str = "",
) -> list[str]:
    """Map positional Cedar policy IDs to their @rule_id annotations.

    Logs WARN on any policy ID that doesn't resolve to a parsed rule —
    the condition indicates a state inconsistency (e.g. ``_hard_policies``
    mutated without re-parsing) and was silently ignored in earlier
    revisions (finding #3 from Chunk 2 review).
    """
    by_id = {r.policy_id: r for r in rules}
    resolved: list[str] = []
    for pid in matching_policy_ids:
        if pid not in by_id:
            log(
                "WARN",
                f"{tier_name or 'tier'}: Cedar reported matching policy "
                f"{pid!r} but no parsed rule carries that ID; "
                f"policy/rule lists may be out of sync",
            )
            continue
        resolved.append(by_id[pid].rule_id or pid)
    return resolved


def _rule_id_for_policy(rules: list[_ParsedRule], policy_id: str) -> str | None:
    """Return the @rule_id annotation for a given positional policy ID."""
    for rule in rules:
        if rule.policy_id == policy_id:
            return rule.rule_id
    return None
