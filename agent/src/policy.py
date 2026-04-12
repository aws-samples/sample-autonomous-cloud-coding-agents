"""Cedar policy engine for tool-call governance.

Uses cedarpy (in-process Cedar evaluation) to enforce per-task-type
tool restrictions. No network calls, no AWS Verified Permissions.

Custom Cedar policies (via Blueprint ``security.cedarPolicies``) must
use ``context`` conditions in ``when`` clauses — not ``resource ==``
matching — for ``write_file`` and ``execute_bash`` actions.  The engine
passes fixed sentinel resource IDs (``Agent::File::"file"``,
``Agent::BashCommand::"command"``) because Cedar entity UIDs cannot
contain the special characters found in file paths and bash commands.
The actual values are available in ``context.file_path`` and
``context.command`` respectively.  For ``invoke_tool`` actions, the
resource ID is the real tool name (e.g. ``Agent::Tool::"Write"``), so
``resource ==`` matching works normally there.

Example — correct custom policy::

    forbid (principal, action == Agent::Action::"execute_bash", resource)
    when { context.command like "*curl*" };

Example — WILL NOT WORK (resource is always ``"command"``)::

    forbid (principal, action == Agent::Action::"execute_bash",
        resource == Agent::BashCommand::"curl http://evil.com");
"""

import time
from dataclasses import dataclass

from shell import log

# Baseline: allow all. Specific forbid rules override (deny-list approach).
_DEFAULT_POLICIES = """\
// Catch-all permit (deny-list model)
permit (principal, action, resource);

// pr_review: forbid Write and Edit tools
forbid (
    principal == Agent::TaskAgent::"pr_review",
    action == Agent::Action::"invoke_tool",
    resource == Agent::Tool::"Write"
);
forbid (
    principal == Agent::TaskAgent::"pr_review",
    action == Agent::Action::"invoke_tool",
    resource == Agent::Tool::"Edit"
);

// All agents: forbid writes to .git internals
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like ".git/*" };
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*/.git/*" };

// All agents: forbid destructive bash commands
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*rm -rf /*" };
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push --force*" };
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push -f *" };
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push -f" };
"""


@dataclass(frozen=True)
class PolicyDecision:
    """Result of a Cedar policy evaluation."""

    allowed: bool
    reason: str
    duration_ms: float = 0


class PolicyEngine:
    """Evaluate tool-use requests against Cedar policies."""

    def __init__(
        self,
        task_type: str,
        repo: str,
        extra_policies: list[str] | None = None,
    ) -> None:
        self._task_type = task_type
        self._repo = repo
        self._disabled = False

        # Import cedarpy at init time so failures are caught early
        try:
            import cedarpy

            self._cedarpy = cedarpy
        except ImportError:
            log("ERROR", "cedarpy not available — policy engine disabled (fail-closed)")
            self._cedarpy = None
            self._disabled = True
            self._policies = _DEFAULT_POLICIES
            return

        # Validate task_type
        from models import TaskType

        try:
            TaskType(task_type)
        except ValueError:
            log("WARN", f"Unknown task_type '{task_type}' — using default deny-list policies")

        # Build combined policies
        self._policies = _DEFAULT_POLICIES
        if extra_policies:
            combined = _DEFAULT_POLICIES + "\n" + "\n".join(extra_policies)
            # Validate combined policies with a test authorization
            try:
                test_request = {
                    "principal": f'Agent::TaskAgent::"{task_type}"',
                    "action": 'Agent::Action::"invoke_tool"',
                    "resource": 'Agent::Tool::"Read"',
                    "context": {"task_type": task_type, "repo": repo},
                }
                test_entities = [
                    {
                        "uid": {"type": "Agent::TaskAgent", "id": task_type},
                        "attrs": {},
                        "parents": [],
                    },
                    {
                        "uid": {"type": "Agent::Tool", "id": "Read"},
                        "attrs": {},
                        "parents": [],
                    },
                ]
                cedarpy.is_authorized(test_request, combined, test_entities)
                self._policies = combined
            except Exception as e:
                log(
                    "WARN",
                    f"Extra Cedar policies failed validation "
                    f"({type(e).__name__}: {e}) — using defaults only",
                )

    @property
    def task_type(self) -> str:
        return self._task_type

    def _evaluate(
        self,
        action: str,
        resource_type: str,
        resource_id: str,
        context: dict,
    ) -> tuple[bool, str]:
        """Run a single Cedar authorization check.

        Returns (allowed, reason). Fails closed on NoDecision.

        ``resource_id`` must be a simple identifier safe for Cedar entity
        UID parsing (no quotes, newlines, or special chars). Callers that
        evaluate user-supplied values (bash commands, file paths) should
        pass a fixed sentinel and put the real value in ``context`` where
        the policies match against it.
        """
        cedarpy = self._cedarpy
        if cedarpy is None:
            return False, "policy engine unavailable"
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
            {
                "uid": {"type": resource_type, "id": resource_id},
                "attrs": {},
                "parents": [],
            },
        ]
        result = cedarpy.is_authorized(request, self._policies, entities)

        if result.decision == cedarpy.Decision.NoDecision:
            return False, "fail-closed: NoDecision (no valid policies loaded)"

        return result.allowed, ""

    def evaluate_tool_use(self, tool_name: str, tool_input: dict) -> PolicyDecision:
        """Evaluate whether a tool call is permitted.

        Returns PolicyDecision with allowed=True/False and reason.
        Fails closed on errors and NoDecision.
        """
        start = time.monotonic()

        if self._disabled or self._cedarpy is None:
            elapsed = (time.monotonic() - start) * 1000
            return PolicyDecision(
                allowed=False,
                reason="policy engine unavailable",
                duration_ms=elapsed,
            )

        try:
            base_context = {"task_type": self._task_type, "repo": self._repo}

            # Base evaluation: is this tool allowed?
            allowed, deny_reason = self._evaluate(
                "invoke_tool",
                "Agent::Tool",
                tool_name,
                base_context,
            )
            if not allowed:
                elapsed = (time.monotonic() - start) * 1000
                reason = (
                    deny_reason
                    or f"Cedar policy denied {tool_name} for task_type={self._task_type}"
                )
                return PolicyDecision(allowed=False, reason=reason, duration_ms=elapsed)

            # Write/Edit: check file path against write_file policies.
            # Sentinel resource_id avoids Cedar UID parsing issues (see _evaluate docstring).
            if tool_name in ("Write", "Edit"):
                file_path = tool_input.get("file_path", "")
                if file_path:
                    allowed, deny_reason = self._evaluate(
                        "write_file",
                        "Agent::File",
                        "file",
                        {**base_context, "file_path": file_path},
                    )
                    if not allowed:
                        elapsed = (time.monotonic() - start) * 1000
                        reason = deny_reason or f"Cedar policy denied write to {file_path}"
                        return PolicyDecision(allowed=False, reason=reason, duration_ms=elapsed)

            # Bash: check command against execute_bash policies.
            # Sentinel resource_id avoids Cedar UID parsing issues (see _evaluate docstring).
            if tool_name == "Bash":
                command = tool_input.get("command", "")
                if command:
                    allowed, deny_reason = self._evaluate(
                        "execute_bash",
                        "Agent::BashCommand",
                        "command",
                        {**base_context, "command": command},
                    )
                    if not allowed:
                        elapsed = (time.monotonic() - start) * 1000
                        reason = deny_reason or "Cedar policy denied bash command"
                        return PolicyDecision(allowed=False, reason=reason, duration_ms=elapsed)

            elapsed = (time.monotonic() - start) * 1000
            return PolicyDecision(allowed=True, reason="permitted", duration_ms=elapsed)

        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            log("WARN", f"Cedar evaluation error (fail-closed): {type(e).__name__}: {e}")
            return PolicyDecision(
                allowed=False, reason=f"fail-closed: {type(e).__name__}", duration_ms=elapsed
            )
