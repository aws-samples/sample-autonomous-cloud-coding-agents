"""Cedar policy engine — three-outcome (allow / deny / require-approval).

Uses cedarpy (in-process Cedar evaluation) to enforce per-task-type tool
restrictions. See ``docs/design/CEDAR_HITL_GATES.md`` for the full design.

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

**Cedar-entity conventions**: user-supplied values (bash commands, file
paths) use sentinel resource IDs (``Agent::File::file``,
``Agent::BashCommand::command``) with the real value in ``context.command`` /
``context.file_path``.

**Annotations** expected on every rule in hard_deny/soft_deny files
(§5.2): ``@rule_id`` (globally unique, kebab/snake_case), ``@tier``
("hard"|"soft"), ``@approval_timeout_s`` (int seconds ≥ 30; soft-deny
only), ``@severity`` ("low"|"medium"|"high"; soft-deny only), ``@category``
(free-form; UX grouping).

**Fail-closed posture** (§13): any cedarpy exception during evaluation
returns ``Outcome.DENY`` with reason ``"fail-closed: <ExceptionType>"``.
Invalid blueprint policies raise at ``PolicyEngine.__init__``.

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
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from fnmatch import fnmatch
from pathlib import Path
from typing import TYPE_CHECKING

from shared_constants import SHARED_CONSTANTS
from shell import log

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

WARN_TIMEOUT_S: int = 120


_SHARED_CONSTANTS = SHARED_CONSTANTS
_AGC = _SHARED_CONSTANTS["approval_gate_cap"]
DEFAULT_APPROVAL_GATE_CAP: int = int(_AGC["default"])
APPROVAL_GATE_CAP_MIN: int = int(_AGC["min"])
APPROVAL_GATE_CAP_MAX: int = int(_AGC["max"])
_ATS = _SHARED_CONSTANTS["approval_timeout_s"]
FLOOR_TIMEOUT_S: int = int(_ATS["min"])
DEFAULT_TASK_TIMEOUT_S: int = int(_ATS["default"])
APPROVAL_TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def approval_deadline_epoch(created_at: str, timeout_s: int) -> int:
    """Wall-clock expiry (epoch seconds) of an approval row: ``created_at + timeout_s``.

    Raises ValueError for a non-canonical timestamp.
    """
    created = datetime.strptime(created_at, APPROVAL_TIMESTAMP_FORMAT).replace(tzinfo=UTC)
    if created.strftime(APPROVAL_TIMESTAMP_FORMAT) != created_at:
        raise ValueError("Approval timestamp is not canonical")
    return int(created.timestamp()) + timeout_s


def _validate_constants() -> None:
    if FLOOR_TIMEOUT_S <= 0:
        raise ValueError(
            f"contracts/constants.json: approval_timeout_s.min must be > 0, got {FLOOR_TIMEOUT_S}"
        )
    if DEFAULT_TASK_TIMEOUT_S < FLOOR_TIMEOUT_S:
        raise ValueError(
            f"contracts/constants.json: approval_timeout_s.default ({DEFAULT_TASK_TIMEOUT_S}) "
            f"must be >= min ({FLOOR_TIMEOUT_S})"
        )
    ats_max = int(_ATS["max"])
    if ats_max < DEFAULT_TASK_TIMEOUT_S:
        raise ValueError(
            f"contracts/constants.json: approval_timeout_s.max ({ats_max}) "
            f"must be >= default ({DEFAULT_TASK_TIMEOUT_S})"
        )
    if APPROVAL_GATE_CAP_MIN <= 0:
        raise ValueError(
            f"contracts/constants.json: approval_gate_cap.min must be > 0, "
            f"got {APPROVAL_GATE_CAP_MIN}"
        )
    if DEFAULT_APPROVAL_GATE_CAP < APPROVAL_GATE_CAP_MIN:
        raise ValueError(
            f"contracts/constants.json: approval_gate_cap.default ({DEFAULT_APPROVAL_GATE_CAP}) "
            f"must be >= min ({APPROVAL_GATE_CAP_MIN})"
        )
    if APPROVAL_GATE_CAP_MAX < DEFAULT_APPROVAL_GATE_CAP:
        raise ValueError(
            f"contracts/constants.json: approval_gate_cap.max ({APPROVAL_GATE_CAP_MAX}) "
            f"must be >= default ({DEFAULT_APPROVAL_GATE_CAP})"
        )


_validate_constants()
CACHE_MAX_ENTRIES: int = 50
CACHE_TTL_S: float = 60.0
POLICIES_MAX_BYTES: int = 64 * 1024
APPROVAL_RATE_LIMIT: int = 20
APPROVAL_RATE_WINDOW_S: float = 60.0

_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2}
_DEFAULT_SEVERITY = "medium"
_VALID_SEVERITIES = frozenset(_SEVERITY_ORDER)

TOOL_GROUPS: dict[str, frozenset[str]] = {
    "file_write": frozenset({"Write", "Edit"}),
}

_POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"


class Outcome(StrEnum):
    """Three-outcome model returned by ``evaluate_tool_use``.

    REQUIRE_APPROVAL is the soft-deny surface: the hook pauses the tool call
    and awaits a human decision. ALLOW / DENY are absolute from the engine's
    perspective — the hook maps them to the SDK's binary permit/forbid API.
    """

    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


@dataclass(frozen=True, kw_only=True)
class PolicyDecision:
    """Result of a Cedar policy evaluation.

    ``timeout_s``, ``severity`` and ``matching_rule_ids`` are populated only
    on ``REQUIRE_APPROVAL``.
    """

    outcome: Outcome
    reason: str = ""
    timeout_s: int | None = None
    severity: str | None = None
    matching_rule_ids: tuple[str, ...] = ()
    duration_ms: float = 0.0
    cache_hit_metadata: dict | None = field(default=None, compare=False)
    fail_closed: bool = field(default=False, compare=False)

    @property
    def allowed(self) -> bool:
        return self.outcome == Outcome.ALLOW

    @classmethod
    def allow(cls, reason: str = "permitted", duration_ms: float = 0.0) -> PolicyDecision:
        return cls(outcome=Outcome.ALLOW, reason=reason, duration_ms=duration_ms)

    @classmethod
    def deny(
        cls, reason: str, duration_ms: float = 0.0, fail_closed: bool = False
    ) -> PolicyDecision:
        return cls(
            outcome=Outcome.DENY,
            reason=reason,
            duration_ms=duration_ms,
            fail_closed=fail_closed,
        )

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


@dataclass
class _CachedDecision:
    decision: str
    reason: str
    inserted_at: float
    original_decision_ts: str


class ApprovalAllowlist:
    """Runtime scope allowlist, seeded from ``initial_approvals`` at task start.

    ``matches`` checks tool-scope fast paths (all_session, tool_type,
    tool_group, bash_pattern, write_path); rule-scope matches are checked
    after the soft-deny eval in ``evaluate_tool_use``.
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
        same internal state; empty-after-strip values are rejected.
        Case is preserved verbatim — ``"tool_type:read"`` will not match
        the ``"Read"`` tool name at runtime.
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
            if any(fnmatch(cmd, pat) for pat in self._bash_patterns):
                return True
        if tool_name in ("Write", "Edit"):
            fp = tool_input.get("file_path", "")
            if any(fnmatch(fp, pat) for pat in self._write_path_patterns):
                return True
        return False


class RecentDecisionCache:
    """In-process LRU cache of recent DENIED/TIMED_OUT outcomes.

    Bounded at ``CACHE_MAX_ENTRIES`` entries, independent of the per-task
    ``approvalGateCap``. TTL is ``CACHE_TTL_S`` on each entry. Populated only
    on DENIED/TIMED_OUT, never on APPROVED.

    Session-scoped: cleared on container restart.
    """

    def __init__(
        self,
        *,
        max_entries: int = CACHE_MAX_ENTRIES,
        ttl_s: float = CACHE_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._entries: OrderedDict[tuple[str, str], _CachedDecision] = OrderedDict()
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
        original approval decision that seeded this cache entry. Falsy values
        (``None`` or empty string) fall back to "now" at record time.
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
        """Insert a rule-level entry. Evicts LRU on overflow.

        Only ``DENIED`` is recorded here; any other ``decision`` raises
        ValueError.
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
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return entry

    def get_rule_decision(
        self, tool_name: str, rule_ids: Iterable[str]
    ) -> tuple[str, _CachedDecision] | None:
        """Return ``(rule_id, entry)`` for the first non-expired rule hit, or None."""
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


@dataclass
class _ParsedRule:
    policy_id: str  # Internal cedarpy ID (e.g. "policy0")
    rule_id: str | None
    tier: str | None
    effect: str | None
    approval_timeout_s: int | None
    severity: str | None


def _parse_policy_set(cedarpy_module, policies_text: str) -> dict:
    try:
        return json.loads(cedarpy_module.policies_to_json_str(policies_text))
    except Exception as exc:
        raise ValueError(f"Cedar policy parse failed: {type(exc).__name__}: {exc}") from exc


def _parse_policy_annotations(cedarpy_module, policies_text: str) -> list[_ParsedRule]:
    parsed = _parse_policy_set(cedarpy_module, policies_text)
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
            )
        )
    return rules


def _route_operator_policies(
    cedarpy_module, extra_policies: list[str], blueprint_policies: list[str]
) -> tuple[list[str], list[str]]:
    hard: list[str] = []
    soft: list[str] = []
    legacy_count = 0
    for field_name, entries in (
        ("extra_policies", extra_policies),
        ("cedar_policies", blueprint_policies),
    ):
        for idx, text in enumerate(entries):
            source = f"{field_name}[{idx}]"
            try:
                parsed = _parse_policy_set(cedarpy_module, text)
            except ValueError as exc:
                raise ValueError(f"{source}: {exc}") from exc
            templates = parsed.get("templates", {}).values()
            if templates and field_name == "cedar_policies":
                raise ValueError(
                    f"{source} contains an unbound Cedar template; use a static policy"
                )
            bodies = (*parsed.get("staticPolicies", {}).values(), *templates)
            if not bodies:
                raise ValueError(f"{source} must contain a Cedar policy")
            annotations = [body.get("annotations", {}) for body in bodies]
            tiers = {ann.get("tier") for ann in annotations}
            if tiers == {None} and all("rule_id" not in ann for ann in annotations):
                soft.append(f'@tier("soft")\n@rule_id("legacy_extra_{legacy_count}")\n{text}')
                legacy_count += 1
            elif field_name == "extra_policies":
                raise ValueError(
                    f"{source} already declares @tier or @rule_id; use blueprint_policies"
                )
            elif tiers == {"hard"}:
                hard.append(text)
            elif tiers == {"soft"}:
                soft.append(text)
            elif {"hard", "soft"} <= tiers:
                raise ValueError(
                    f"{source} declares both hard and soft tiers; use separate entries"
                )
            else:
                raise ValueError(f'{source}: declare the tier ("hard" or "soft") on each rule')
    return hard, soft


def _validate_tier(rules: list[_ParsedRule], expected_tier: str, source: str) -> None:
    seen_rule_ids: set[str] = set()
    for rule in rules:
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
    effective_timeout = max(FLOOR_TIMEOUT_S, min(timeouts))

    if severities:
        effective_severity = max(severities, key=lambda s: _SEVERITY_ORDER.get(s, 0))
    else:
        effective_severity = _DEFAULT_SEVERITY

    return rule_ids, effective_timeout, effective_severity


def _load_builtin_policies() -> tuple[str, str]:
    hard_path = _POLICIES_DIR / "hard_deny.cedar"
    soft_path = _POLICIES_DIR / "soft_deny.cedar"
    if not hard_path.is_file():
        raise FileNotFoundError(f"missing built-in hard-deny policies: {hard_path}")
    if not soft_path.is_file():
        raise FileNotFoundError(f"missing built-in soft-deny policies: {soft_path}")
    return hard_path.read_text(), soft_path.read_text()


def _sha256_tool_input(tool_input: dict) -> str:
    return hashlib.sha256(json.dumps(tool_input, sort_keys=True).encode("utf-8")).hexdigest()


def _recent_reason(prefix: str, reason: str | None) -> str:
    return f"{prefix}: {reason}" if reason else prefix


class PolicyEngine:
    """Evaluate tool-use requests against Cedar policies with three outcomes.

    Construction loads the built-in hard_deny + soft_deny policy files,
    concatenates any blueprint-provided rules (subject to 64 KB cap and
    disable-list validation), probes a test authorization to catch syntax
    errors early, and seeds the approval allowlist from ``initial_approvals``.

    Each ``blueprint_policies`` entry declares its tier in Cedar. Unannotated
    entries and legacy ``extra_policies`` get generated soft rule IDs.
    """

    def __init__(
        self,
        task_type: str,
        repo: str,
        *,
        read_only: bool = False,
        extra_policies: list[str] | None = None,
        blueprint_policies: list[str] | None = None,
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
        self._read_only = read_only
        self._disabled = False
        self._task_default_timeout_s = task_default_timeout_s

        if not APPROVAL_GATE_CAP_MIN <= approval_gate_cap <= APPROVAL_GATE_CAP_MAX:
            raise ValueError(
                f"approval_gate_cap must be in "
                f"[{APPROVAL_GATE_CAP_MIN}, {APPROVAL_GATE_CAP_MAX}], "
                f"got {approval_gate_cap}"
            )
        self._approval_gate_cap = approval_gate_cap

        if initial_approval_gate_count < 0:
            raise ValueError(
                f"initial_approval_gate_count must be >= 0, got {initial_approval_gate_count}"
            )

        self._approval_gate_count: int = initial_approval_gate_count
        self._approvals_last_minute: deque[float] = deque()
        self._denial_injection_queue: list[dict] = []
        self._emitted_ceiling_shrinking: bool = False

        try:
            import cedarpy

            self._cedarpy = cedarpy
        except ImportError:
            log("ERROR", "cedarpy not available — policy engine disabled (fail-closed)")
            self._cedarpy = None
            self._disabled = True
            self._hard_policies = ""
            self._soft_policies = ""
            self._hard_rules: list[_ParsedRule] = []
            self._soft_rules: list[_ParsedRule] = []
            self._allowlist = ApprovalAllowlist()
            self._cache = RecentDecisionCache()
            return

        try:
            builtin_hard, builtin_soft = _load_builtin_policies()
        except FileNotFoundError as exc:
            raise RuntimeError(str(exc)) from exc

        operator_bytes = sum(
            len(text.encode("utf-8"))
            for text in (
                blueprint_hard_policies or "",
                blueprint_soft_policies or "",
                *(extra_policies or []),
                *(blueprint_policies or []),
            )
        )
        if operator_bytes > POLICIES_MAX_BYTES:
            raise ValueError(
                f"cedar_policies exceeds {POLICIES_MAX_BYTES // 1024} KB cap "
                f"({operator_bytes} bytes)"
            )

        hard, soft = _route_operator_policies(
            self._cedarpy, extra_policies or [], blueprint_policies or []
        )
        hard_text = "\n".join(filter(None, [builtin_hard, blueprint_hard_policies, *hard]))
        soft_text = "\n".join(filter(None, [builtin_soft, blueprint_soft_policies, *soft]))

        try:
            self._hard_rules = _parse_policy_annotations(self._cedarpy, hard_text)
            _validate_tier(self._hard_rules, "hard", "hard_deny")
        except ValueError as exc:
            raise ValueError(f"hard-deny policy validation failed: {exc}") from exc

        try:
            self._soft_rules = _parse_policy_annotations(self._cedarpy, soft_text)
            _validate_tier(self._soft_rules, "soft", "soft_deny")
        except ValueError as exc:
            raise ValueError(f"soft-deny policy validation failed: {exc}") from exc

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
        self._disabled_rule_ids: set[str] = set(blueprint_disable or [])

        # Cedar denies by default, so each tier carries its own ``base_permit``
        # catch-all.
        hard_ids = {r.rule_id for r in self._hard_rules if r.rule_id}
        soft_ids = {r.rule_id for r in self._soft_rules if r.rule_id}
        cross = (hard_ids & soft_ids) - {"base_permit"}
        if cross:
            raise ValueError(f"duplicate @rule_id across tiers: {sorted(cross)}")

        self._probe_cedar(hard_text, "hard")
        self._probe_cedar(soft_text, "soft")

        self._hard_policies = hard_text
        self._soft_policies = soft_text

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

    @property
    def approval_gate_count(self) -> int:
        return self._approval_gate_count

    def increment_approval_gate_count(self) -> None:
        self._approval_gate_count += 1

    def record_approval_gate_timestamp(self, now: float | None = None) -> None:
        ts = time.monotonic() if now is None else now
        self._approvals_last_minute.append(ts)
        self._prune_rate_window(ts)

    def _prune_rate_window(self, now: float) -> None:
        cutoff = now - APPROVAL_RATE_WINDOW_S
        while self._approvals_last_minute and self._approvals_last_minute[0] < cutoff:
            self._approvals_last_minute.popleft()

    @property
    def approvals_in_last_minute(self) -> int:
        """Count of approval-gate writes in the last ``APPROVAL_RATE_WINDOW_S``."""
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
        out = list(self._denial_injection_queue)
        self._denial_injection_queue.clear()
        return out

    def mark_ceiling_shrinking_emitted(self) -> bool:
        """Idempotency latch for ``approval_ceiling_shrinking``.

        Returns ``True`` the first time it is called (caller should emit the
        milestone) and ``False`` on every subsequent call.
        """
        if self._emitted_ceiling_shrinking:
            return False
        self._emitted_ceiling_shrinking = True
        return True

    def _probe_cedar(self, policies_text: str, tier_name: str) -> None:
        base_context = {
            "task_type": self._task_type,
            "repo": self._repo,
            "read_only": self._read_only,
        }
        # Cedar cannot evaluate a ``when`` clause that reads a context attribute
        # the request does not carry, so each kind of request is probed.
        try:
            for tool_name, tool_input in (
                ("Read", {}),
                ("Write", {"file_path": "probe"}),
                ("Edit", {"file_path": "probe"}),
                ("Bash", {"command": "probe"}),
            ):
                self._eval_for_tool(
                    policies_text, tool_name, tool_input, base_context, tier_name=tier_name
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
        if self._cedarpy is None:
            raise RuntimeError("eval called on disabled engine")
        result = self._cedarpy.is_authorized(request, policies_text, entities)
        if getattr(result.diagnostics, "errors", []):
            # cedarpy reports parse errors via diagnostics.errors and returns
            # Decision.NoDecision rather than raising.
            errors = "; ".join(str(e) for e in result.diagnostics.errors)
            raise RuntimeError(f"Cedar policy parse/eval errors: {errors}")
        decision = result.decision.value.lower()
        if decision not in ("allow", "deny"):
            return "no_decision", list(result.diagnostics.reasons)
        return decision, list(result.diagnostics.reasons)

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
                fail_closed=True,
            )

        base_context = {
            "task_type": self._task_type,
            "repo": self._repo,
            "read_only": self._read_only,
        }

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
                fail_closed=True,
            )

        try:
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

            if self._allowlist.matches(tool_name, tool_input):
                return PolicyDecision.allow(
                    reason="Pre-approved by allowlist",
                    duration_ms=(time.monotonic() - start) * 1000,
                )

            cached = self._cache.get(tool_name, input_sha)
            if cached is not None:
                return PolicyDecision(
                    outcome=Outcome.DENY,
                    reason=_recent_reason(
                        f"Recent {cached.decision} within {int(CACHE_TTL_S)}s", cached.reason
                    ),
                    duration_ms=(time.monotonic() - start) * 1000,
                    cache_hit_metadata={
                        "tool_name": tool_name,
                        "tool_input_sha256": input_sha,
                        "cached_decision": cached.decision,
                        "cached_reason": cached.reason,
                        "original_decision_ts": cached.original_decision_ts,
                    },
                )

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
                active_ids = [rid for rid in all_matching_ids if rid not in self._disabled_rule_ids]
                if not active_ids:
                    return PolicyDecision.allow(
                        reason="permitted (all matching soft-deny rules disabled by blueprint)",
                        duration_ms=(time.monotonic() - start) * 1000,
                    )
                if any(rid in self._allowlist.rule_ids for rid in active_ids):
                    return PolicyDecision.allow(
                        reason=f"Allowlist rule: {', '.join(active_ids)}",
                        duration_ms=(time.monotonic() - start) * 1000,
                    )

                rule_hit = self._cache.get_rule_decision(tool_name, active_ids)
                if rule_hit is not None:
                    matched_rule_id, cached = rule_hit
                    return PolicyDecision(
                        outcome=Outcome.DENY,
                        reason=_recent_reason(
                            f"Recent {cached.decision} on rule {matched_rule_id!r} "
                            f"within {int(CACHE_TTL_S)}s",
                            cached.reason,
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

            return PolicyDecision.allow(
                reason="permitted",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        except Exception as exc:
            log("WARN", f"Cedar evaluation error (fail-closed): {type(exc).__name__}: {exc}")
            return PolicyDecision.deny(
                reason=f"fail-closed: {type(exc).__name__}",
                duration_ms=(time.monotonic() - start) * 1000,
                fail_closed=True,
            )

    def _eval_for_tool(
        self,
        policies_text: str,
        tool_name: str,
        tool_input: dict,
        base_context: dict,
        *,
        tier_name: str,
    ) -> tuple[str, list[str]] | None:
        def _run(action: str, resource_type: str, resource_id: str, ctx: dict):
            decision, reasons = self._eval_tier(
                policies_text, action, resource_type, resource_id, ctx
            )
            if decision == "no_decision":
                log(
                    "WARN",
                    f"{tier_name}: Cedar no_decision for "
                    f"action={action!r} tool={tool_name!r} — base_permit "
                    f"catch-all missing or malformed",
                )
            return decision, reasons

        invoke_decision, invoke_reasons = _run(
            "invoke_tool", "Agent::Tool", tool_name, base_context
        )
        if invoke_decision == "deny":
            return ("deny", invoke_reasons)

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
    tier_name: str,
) -> list[str]:
    by_id = {r.policy_id: r for r in rules}
    resolved: list[str] = []
    for pid in matching_policy_ids:
        if pid not in by_id:
            log(
                "WARN",
                f"{tier_name}: Cedar reported matching policy "
                f"{pid!r} but no parsed rule carries that ID; "
                f"policy/rule lists may be out of sync",
            )
            continue
        resolved.append(by_id[pid].rule_id or pid)
    return resolved


def _rule_id_for_policy(rules: list[_ParsedRule], policy_id: str) -> str | None:
    for rule in rules:
        if rule.policy_id == policy_id:
            return rule.rule_id
    return None
