"""Best-effort task state persistence to DynamoDB.

All writes are wrapped in try/except so a DynamoDB outage never breaks the
agent pipeline. When the TASK_TABLE_NAME environment variable is unset, all
operations are no-ops.
"""

import os
import time
from typing import TypedDict

from shell import log, log_error_cw


class ApprovalRow(TypedDict):
    """Schema for the approval row written by ``transact_write_approval_request``.

    Mirrors the DDB column layout described in design §10.1 and the
    TypeScript ``ApprovalRecord`` discriminated union in
    ``cdk/src/handlers/shared/types.ts``. Used as the typed contract
    between the PreToolUse hook (which builds the row) and the
    transactional writer (which serializes it to DDB attributes).
    Pre-S7 the function accepted a bare ``dict`` so missing or
    misspelled fields would fail at runtime, not at the call site.
    """

    task_id: str
    request_id: str
    tool_name: str
    tool_input_preview: str
    tool_input_sha256: str
    reason: str
    severity: str  # 'low' | 'medium' | 'high' — matches TS Severity literal.
    matching_rule_ids: list[str]
    status: str  # always 'PENDING' on initial write.
    created_at: str
    timeout_s: int
    ttl: int
    user_id: str
    repo: str


_table = None


def _get_table():
    """Lazy-init the DynamoDB Table resource."""
    global _table
    if _table is not None:
        return _table

    table_name = os.environ.get("TASK_TABLE_NAME")
    if not table_name:
        return None

    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region)
    _table = dynamodb.Table(table_name)
    return _table


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _build_logs_url(task_id: str) -> str | None:
    """Build a CloudWatch Logs console URL filtered to this task_id."""
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    log_group = os.environ.get("LOG_GROUP_NAME")
    if not region or not log_group:
        return None
    # CloudWatch console uses $252F for / in the URL hash fragment
    encoded_group = log_group.replace("/", "$252F")
    return (
        f"https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}"
        f"#logsV2:log-groups/log-group/{encoded_group}/log-events"
        f"?filterPattern=%22{task_id}%22"
    )


def write_submitted(
    task_id: str, repo_url: str = "", issue_number: str = "", task_description: str = ""
) -> None:
    """Record a task as SUBMITTED (called from the invoke script or server)."""
    try:
        table = _get_table()
        if table is None:
            return
        item = {
            "task_id": task_id,
            "status": "SUBMITTED",
            "created_at": _now_iso(),
        }
        if repo_url:
            item["repo_url"] = repo_url
        if issue_number:
            item["issue_number"] = issue_number
        if task_description:
            item["task_description"] = task_description
        table.put_item(Item=item)
    except Exception as e:
        log("WARN", f"[task_state] write_submitted failed (best-effort): {e}")


def write_heartbeat(task_id: str) -> None:
    """Update ``agent_heartbeat_at`` while the task is RUNNING (orchestrator crash detection)."""
    try:
        table = _get_table()
        if table is None:
            return
        table.update_item(
            Key={"task_id": task_id},
            UpdateExpression="SET agent_heartbeat_at = :t",
            ConditionExpression="#s = :running",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":t": _now_iso(), ":running": "RUNNING"},
        )
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            return
        log("WARN", f"[task_state] write_heartbeat failed (best-effort): {type(e).__name__}: {e}")


def write_session_info(task_id: str, session_id: str, agent_runtime_arn: str) -> None:
    """Record session_id + agent_runtime_arn on a pre-RUNNING task.

    The orchestrator Lambda writes these fields on the HYDRATING → RUNNING
    transition so ``cancel-task`` can ``StopRuntimeSession`` on the right
    runtime and operators can correlate a stuck task to a specific AgentCore
    session. Currently only the orchestrator calls this; the agent-side
    invocation path inherits the fields from the orchestrator's payload.

    Idempotent + best-effort. Skips silently if the task is already
    past SUBMITTED/HYDRATING (concurrent transition winning is fine).
    """
    if not task_id or (not session_id and not agent_runtime_arn):
        return
    try:
        table = _get_table()
        if table is None:
            return
        set_parts: list[str] = []
        expr_values: dict = {
            ":submitted": "SUBMITTED",
            ":hydrating": "HYDRATING",
        }
        if session_id:
            set_parts.append("session_id = :sid")
            expr_values[":sid"] = session_id
        if agent_runtime_arn:
            set_parts.append("agent_runtime_arn = :arn")
            set_parts.append("compute_type = :ct")
            set_parts.append("compute_metadata = :cm")
            expr_values[":arn"] = agent_runtime_arn
            expr_values[":ct"] = "agentcore"
            expr_values[":cm"] = {"runtimeArn": agent_runtime_arn}
        if not set_parts:
            return
        table.update_item(
            Key={"task_id": task_id},
            UpdateExpression="SET " + ", ".join(set_parts),
            ConditionExpression="#s IN (:submitted, :hydrating)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            # Task already advanced — concurrent legitimate transition wins.
            return
        log(
            "WARN",
            f"[task_state] write_session_info failed (best-effort): {type(e).__name__}: {e}",
        )


def write_running(task_id: str) -> None:
    """Transition a task to RUNNING (called at agent start).

    Updates ``status_created_at`` alongside ``status`` so the
    ``UserStatusIndex`` GSI sort key reflects the current status.  Writers
    that transition the task (``create-task-core``, ``cancel-task``,
    ``reconcile-stranded-tasks``) all rewrite this field; keeping Python
    in sync is required for ``bga list`` to return tasks in the expected
    order.
    """
    try:
        table = _get_table()
        if table is None:
            return
        now = _now_iso()
        expr_names = {"#s": "status"}
        expr_values = {
            ":s": "RUNNING",
            ":t": now,
            ":sca": f"RUNNING#{now}",
            ":submitted": "SUBMITTED",
            ":hydrating": "HYDRATING",
        }
        update_parts = ["#s = :s", "started_at = :t", "status_created_at = :sca"]

        logs_url = _build_logs_url(task_id)
        if logs_url:
            update_parts.append("logs_url = :logs")
            expr_values[":logs"] = logs_url

        table.update_item(
            Key={"task_id": task_id},
            UpdateExpression="SET " + ", ".join(update_parts),
            ConditionExpression="#s IN (:submitted, :hydrating)",
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            log("INFO", "[task_state] write_running skipped: status precondition not met")
            return
        log("WARN", f"[task_state] write_running failed (best-effort): {type(e).__name__}")


def write_terminal(task_id: str, status: str, result: dict | None = None) -> None:
    """Transition a task to a terminal state (COMPLETED or FAILED).

    Updates ``status_created_at`` alongside ``status`` — see
    :func:`write_running` for why.
    """
    try:
        table = _get_table()
        if table is None:
            return
        now = _now_iso()
        expr_names = {"#s": "status"}
        expr_values = {
            ":s": status,
            ":t": now,
            ":sca": f"{status}#{now}",
            ":running": "RUNNING",
            ":hydrating": "HYDRATING",
            ":finalizing": "FINALIZING",
            # AWAITING_APPROVAL is included so a container shutdown
            # mid-gate can still record the terminal transition. Without
            # it, a crash while the user is deciding leaves the task
            # stuck until the stranded-task reconciler catches it (~2h).
            # Cedar HITL state machine (design §9): RUNNING ↔
            # AWAITING_APPROVAL, both can transition straight to a
            # terminal state.
            ":awaiting_approval": "AWAITING_APPROVAL",
        }
        update_parts = ["#s = :s", "completed_at = :t", "status_created_at = :sca"]

        if result:
            if result.get("pr_url"):
                update_parts.append("pr_url = :pr")
                expr_values[":pr"] = result["pr_url"]
            if result.get("error"):
                update_parts.append("error_message = :err")
                expr_values[":err"] = str(result["error"])[:1000]
            if result.get("cost_usd") is not None:
                update_parts.append("cost_usd = :cost")
                expr_values[":cost"] = str(result["cost_usd"])
            if result.get("duration_s") is not None:
                update_parts.append("duration_s = :dur")
                expr_values[":dur"] = str(result["duration_s"])
            if result.get("turns") is not None:
                update_parts.append("turns = :turns")
                expr_values[":turns"] = str(result["turns"])
            # Rev-5 DATA-1: dual counters so operators can distinguish
            # SDK-attempted vs pipeline-completed turn counts.
            if result.get("turns_attempted") is not None:
                update_parts.append("turns_attempted = :ta")
                expr_values[":ta"] = str(result["turns_attempted"])
            if result.get("turns_completed") is not None:
                update_parts.append("turns_completed = :tc")
                expr_values[":tc"] = str(result["turns_completed"])
            if result.get("prompt_version"):
                update_parts.append("prompt_version = :pv")
                expr_values[":pv"] = result["prompt_version"]
            if result.get("memory_written") is not None:
                update_parts.append("memory_written = :mw")
                expr_values[":mw"] = result["memory_written"]
            # --trace artifact URI (design §10.1). Written atomically
            # with the terminal-status transition so a consumer that
            # reads TaskRecord.trace_s3_uri immediately after
            # status becomes terminal sees a consistent view.
            if result.get("trace_s3_uri"):
                update_parts.append("trace_s3_uri = :ts3")
                expr_values[":ts3"] = result["trace_s3_uri"]

        table.update_item(
            Key={"task_id": task_id},
            UpdateExpression="SET " + ", ".join(update_parts),
            ConditionExpression="#s IN (:running, :hydrating, :finalizing, :awaiting_approval)",
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            log(
                "INFO",
                "[task_state] write_terminal skipped: "
                "status precondition not met (task may have been cancelled)",
            )
            # K2 final review SIG-1: ConditionalCheckFailed on the
            # happy path after a successful S3 trace upload orphans
            # the S3 object — the URI never lands on the TaskRecord,
            # so ``get-trace-url`` will 404 ``TRACE_NOT_AVAILABLE``
            # indefinitely. Without this dedicated log the orphan
            # is invisible; the generic skip message above doesn't
            # distinguish benign-racing-cancel from
            # silently-lost-trace-URI.
            #
            # L4 self-heal: attempt a second conditional UpdateItem
            # scoped to ``attribute_not_exists(trace_s3_uri)`` AND a
            # terminal status. If the task genuinely raced into a
            # terminal state (cancel / reconciler), this puts the URI
            # back on the record and the orphan log below documents
            # the original race for operators.
            if result and result.get("trace_s3_uri"):
                # ERROR severity: a real orphan is operator-actionable.
                # Routed via log_error_cw so it shows up in the
                # APPLICATION_LOGS group that TaskDashboard reads.
                log_error_cw(
                    f"[task_state] trace_s3_uri orphaned by "
                    f"ConditionalCheckFailed: task_id={task_id!r} "
                    f"trace_s3_uri={result['trace_s3_uri']!r}. "
                    f"S3 object exists but TaskRecord will not be "
                    f"updated; presigned-URL endpoint will 404 for "
                    f"this task. Object will be reaped by the 7-day "
                    f"lifecycle.",
                    task_id=task_id,
                )
                healed = write_trace_uri_conditional(task_id, result["trace_s3_uri"])
                if healed:
                    log(
                        "INFO",
                        f"[task_state] trace_s3_uri self-healed for "
                        f"task_id={task_id!r} after ConditionalCheckFailed "
                        f"(terminal-state race).",
                    )
            return
        log("WARN", f"[task_state] write_terminal failed (best-effort): {type(e).__name__}")


def write_trace_uri_conditional(task_id: str, uri: str) -> bool:
    """Persist ``trace_s3_uri`` on an already-terminal record.

    Used as a self-heal after ``write_terminal`` loses a race with
    cancel / reconciler. Only writes when:
      1. The status is terminal (CANCELLED / COMPLETED / FAILED / TIMED_OUT).
      2. ``trace_s3_uri`` is not already set (avoid clobbering).

    Returns True on successful write, False on any conditional-check
    failure or other fail-open path. Never raises.
    """
    if not task_id or not uri:
        return False
    try:
        table = _get_table()
        if table is None:
            return False
        table.update_item(
            Key={"task_id": task_id},
            UpdateExpression="SET trace_s3_uri = :ts3",
            ConditionExpression=(
                "attribute_not_exists(trace_s3_uri) AND "
                "#s IN (:cancelled, :completed, :failed, :timed_out)"
            ),
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":ts3": uri,
                ":cancelled": "CANCELLED",
                ":completed": "COMPLETED",
                ":failed": "FAILED",
                ":timed_out": "TIMED_OUT",
            },
        )
        return True
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            # Benign: URI was already persisted, or status isn't terminal yet.
            log(
                "INFO",
                f"[task_state] write_trace_uri_conditional skipped for "
                f"task_id={task_id!r}: precondition not met "
                f"(trace_s3_uri already set or status not terminal).",
            )
            return False
        log(
            "WARN",
            f"[task_state] write_trace_uri_conditional failed for "
            f"task_id={task_id!r}: {type(e).__name__}: {e}",
        )
        return False


class TaskFetchError(Exception):
    """DDB/boto failure while fetching a task record.

    Distinguished from ``None`` (== "record not found") so callers can
    decide whether to fail open (no record) or fail closed (couldn't tell).
    """


def get_task(task_id: str) -> dict | None:
    """Fetch a task record by ID.

    Returns:
        The item dict if present, ``None`` if the task_id is not in the
        table, or if the table resource is unavailable (local dev /
        ``TASK_TABLE_NAME`` unset).

    Raises:
        TaskFetchError: DDB/boto/network failure, distinguished from
            ``None`` (== "record not found") so callers can choose their
            failure posture. Current callers
            (``hooks._cancel_between_turns_hook``, ``pipeline.run_task``'s
            cancel short-circuit) all fail open on this — they prefer to
            keep a running task alive through a transient DDB blip rather
            than stranding it. New callers should make the choice
            explicitly; silently collapsing the two cases to ``None``
            erases the signal.
    """
    table = _get_table()
    if table is None:
        return None
    try:
        resp = table.get_item(Key={"task_id": task_id})
    except Exception as e:
        log("WARN", f"[task_state] get_task failed: {type(e).__name__}: {e}")
        raise TaskFetchError(f"{type(e).__name__}: {e}") from e
    return resp.get("Item")


# ---------------------------------------------------------------------------
# Cedar HITL approval primitives (§6.5, §9.1, IMPL-24)
# ---------------------------------------------------------------------------
#
# ``TaskApprovalsTable`` and the AWAITING_APPROVAL status transitions land
# physically in Chunk 4 (CDK). The agent-side helpers below are written to
# that contract and exposed so Chunk 3's ``pre_tool_use_hook`` can be
# implemented + unit-tested now (via mocked boto3 clients); Chunk 4 sets
# ``TASK_APPROVALS_TABLE_NAME`` + grants IAM and the same helpers start
# making real DDB calls with no further code change on the agent side.
#
# Primitives exposed:
#   - ``transact_write_approval_request`` — atomic Put(TaskApprovals) +
#     Update(TaskTable: RUNNING → AWAITING_APPROVAL). Raises
#     ``ApprovalWriteError`` on ``TransactionCanceledException`` so the
#     hook can return DENY + ``approval_write_failed`` (§13.1).
#   - ``transact_resume_from_approval`` — atomic Update(TaskTable:
#     AWAITING_APPROVAL → RUNNING) gated on
#     ``awaiting_approval_request_id = request_id``. Raises
#     ``ApprovalResumeError`` on cancellation (§13.9).
#   - ``best_effort_update_approval_status`` — conditional Update on the
#     approval row (``status = :pending`` guard). Returns ``False`` on
#     ``ConditionCheckFailed`` so IMPL-24's re-read re-read path fires.
#   - ``get_approval_row`` — strongly-consistent GetItem; default
#     ``consistent_read=True`` because IMPL-24's race fix relies on it.
#
# Errors beyond the structural conditions (unreachable DDB, IAM drift,
# missing env var) raise ``ApprovalTablesUnavailable`` so the hook can
# fail CLOSED without guessing. The hook maps that to DENY so a
# pre-Chunk-4 deploy cannot silently bypass gates.

TASK_APPROVALS_TABLE_ENV = "TASK_APPROVALS_TABLE_NAME"
TASK_TABLE_ENV = "TASK_TABLE_NAME"

# TaskTable status values referenced by the approval primitives. Kept as
# constants so a rename in CDK cannot silently diverge the Python path.
_STATUS_RUNNING = "RUNNING"
_STATUS_AWAITING_APPROVAL = "AWAITING_APPROVAL"


class ApprovalTablesUnavailable(RuntimeError):
    """Either ``TASK_APPROVALS_TABLE_NAME`` or ``TASK_TABLE_NAME`` is unset.

    Hook maps to DENY (fail-closed); see §13.15. Distinct from
    ``TaskFetchError`` so callers do not collapse a config problem with a
    transient read failure.
    """


class ApprovalWriteError(RuntimeError):
    """``transact_write_approval_request`` TransactionCanceledException.

    Fired when the cross-table atomic write is cancelled — either the
    TaskTable precondition fails (task already cancelled / advanced past
    RUNNING) or the approval row already exists. Hook maps to DENY +
    ``approval_write_failed`` (§13.1). The underlying cancellation reasons
    are stashed on ``.cancellation_reasons`` for triage.
    """

    def __init__(self, message: str, cancellation_reasons: list | None = None) -> None:
        super().__init__(message)
        self.cancellation_reasons = cancellation_reasons or []


class ApprovalResumeError(RuntimeError):
    """``transact_resume_from_approval`` TransactionCanceledException.

    Fired when the resume transition fails — typically because the user
    cancelled the task mid-approval (§13.9). Hook maps to DENY +
    ``approval_resume_failed``.
    """

    def __init__(self, message: str, cancellation_reasons: list | None = None) -> None:
        super().__init__(message)
        self.cancellation_reasons = cancellation_reasons or []


def _get_ddb_client(*, client=None):
    """Return a boto3 DDB low-level client, or the injected ``client`` for tests.

    Tests inject a mock client rather than relying on moto because the
    primitives here touch ``transact_write_items`` with cross-table
    conditions, which moto's older versions do not fully emulate.
    """
    if client is not None:
        return client
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    return boto3.client("dynamodb", region_name=region)


def _require_tables() -> tuple[str, str]:
    """Return ``(task_table, approvals_table)`` or raise.

    Kept as a single guard so every caller surfaces the same error class.
    """
    task_table = os.environ.get(TASK_TABLE_ENV)
    approvals_table = os.environ.get(TASK_APPROVALS_TABLE_ENV)
    if not task_table or not approvals_table:
        raise ApprovalTablesUnavailable(
            f"{TASK_TABLE_ENV}/{TASK_APPROVALS_TABLE_ENV} unset; approval gates cannot be recorded"
        )
    return task_table, approvals_table


def _py_to_ddb_attr(value):
    """Translate a Python value into the DDB low-level attribute shape.

    Handles the subset we actually write: ``str``, ``int``, ``bool``,
    ``None``, lists-of-str. More exotic types would need marshalling
    support; ``approval_row`` values are constrained to the §10.1 schema
    which falls entirely inside this subset.
    """
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        # Lists of strings (matching_rule_ids); other shapes are rejected
        # loudly so a future schema drift surfaces in tests rather than
        # silently writing an empty list.
        if all(isinstance(v, str) for v in value):
            return {"L": [{"S": v} for v in value]}
        raise TypeError(f"unsupported list element types in approval row: {value!r}")
    raise TypeError(f"unsupported approval-row attribute type: {type(value).__name__}")


def _ddb_attr_to_py(attr):
    """Inverse of ``_py_to_ddb_attr`` — enough to rehydrate an approval row."""
    if attr is None:
        return None
    if "NULL" in attr:
        return None
    if "BOOL" in attr:
        return attr["BOOL"]
    if "N" in attr:
        raw = attr["N"]
        # Keep integers integer-shaped for downstream arithmetic (ttl,
        # timeout_s). ``decided_at`` is a string so no floats to worry
        # about.
        try:
            return int(raw)
        except ValueError:
            return raw
    if "S" in attr:
        return attr["S"]
    if "L" in attr:
        return [_ddb_attr_to_py(item) for item in attr["L"]]
    # Unsupported shape; return raw to aid debugging rather than losing data.
    return attr


def transact_write_approval_request(
    task_id: str,
    request_id: str,
    approval_row: ApprovalRow,
    *,
    client=None,
) -> None:
    """Atomically record a pending approval + transition the task to AWAITING_APPROVAL.

    Two items:
      1. Put on ``TaskApprovalsTable`` with ``ConditionExpression:
         attribute_not_exists(request_id)`` — guards against ULID collisions
         and duplicate writes on retry.
      2. Update on ``TaskTable`` with ``ConditionExpression: status =
         :running`` — fails if the task has already been cancelled, failed,
         or is still pre-RUNNING. On success sets
         ``status = AWAITING_APPROVAL`` and
         ``awaiting_approval_request_id = <request_id>`` so the resume
         transition can verify it's resuming the right approval.

    Raises ``ApprovalTablesUnavailable`` if either env var is unset;
    ``ApprovalWriteError`` on ``TransactionCanceledException``; other
    DDB-layer exceptions propagate so the hook's outer try/except can
    fail-closed with a specific reason.
    """
    task_table, approvals_table = _require_tables()
    ddb = _get_ddb_client(client=client)

    approval_item = {k: _py_to_ddb_attr(v) for k, v in approval_row.items()}
    # Belt-and-braces: ensure the keys we rely on downstream are present.
    approval_item.setdefault("task_id", {"S": task_id})
    approval_item.setdefault("request_id", {"S": request_id})
    approval_item.setdefault("status", {"S": "PENDING"})

    try:
        ddb.transact_write_items(
            TransactItems=[
                {
                    "Put": {
                        "TableName": approvals_table,
                        "Item": approval_item,
                        "ConditionExpression": "attribute_not_exists(request_id)",
                    }
                },
                {
                    "Update": {
                        "TableName": task_table,
                        "Key": {"task_id": {"S": task_id}},
                        "UpdateExpression": (
                            "SET #s = :awaiting, awaiting_approval_request_id = :rid"
                        ),
                        "ConditionExpression": "#s = :running",
                        "ExpressionAttributeNames": {"#s": "status"},
                        "ExpressionAttributeValues": {
                            ":awaiting": {"S": _STATUS_AWAITING_APPROVAL},
                            ":running": {"S": _STATUS_RUNNING},
                            ":rid": {"S": request_id},
                        },
                    }
                },
            ]
        )
    except Exception as exc:
        # TransactionCanceledException carries per-item reasons. Keep the
        # detection structural (duck-typed on ``response``) so we do not
        # need botocore at import time.
        reasons = _extract_cancellation_reasons(exc)
        code = _extract_error_code(exc)
        if code == "TransactionCanceledException":
            raise ApprovalWriteError(
                f"approval write cancelled: reasons={reasons}",
                cancellation_reasons=reasons,
            ) from exc
        # Otherwise propagate so outer handler classifies it fail-closed.
        raise


def transact_resume_from_approval(
    task_id: str,
    request_id: str,
    *,
    client=None,
) -> None:
    """Atomically resume RUNNING from AWAITING_APPROVAL for ``request_id``.

    The condition ``status = AWAITING_APPROVAL AND
    awaiting_approval_request_id = :rid`` prevents:
      - resuming a task that's been cancelled mid-approval (§13.9);
      - resuming with a stale request_id after a race with the
        reconciler / a concurrent approval.

    Raises ``ApprovalResumeError`` on ``TransactionCanceledException`` so
    the hook can emit ``approval_resume_failed`` + DENY.
    """
    task_table, _ = _require_tables()
    ddb = _get_ddb_client(client=client)

    try:
        ddb.transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": task_table,
                        "Key": {"task_id": {"S": task_id}},
                        "UpdateExpression": (
                            "SET #s = :running REMOVE awaiting_approval_request_id"
                        ),
                        "ConditionExpression": (
                            "#s = :awaiting AND awaiting_approval_request_id = :rid"
                        ),
                        "ExpressionAttributeNames": {"#s": "status"},
                        "ExpressionAttributeValues": {
                            ":running": {"S": _STATUS_RUNNING},
                            ":awaiting": {"S": _STATUS_AWAITING_APPROVAL},
                            ":rid": {"S": request_id},
                        },
                    }
                }
            ]
        )
    except Exception as exc:
        reasons = _extract_cancellation_reasons(exc)
        code = _extract_error_code(exc)
        if code == "TransactionCanceledException":
            raise ApprovalResumeError(
                f"approval resume cancelled: reasons={reasons}",
                cancellation_reasons=reasons,
            ) from exc
        raise


def best_effort_update_approval_status(
    task_id: str,
    request_id: str,
    new_status: str,
    *,
    reason: str | None = None,
    client=None,
) -> bool:
    """Conditionally flip ``status`` on an approval row.

    The condition ``status = :pending`` is the design-doc guard from §6.5.
    Used on the TIMED_OUT write path: if the row has already transitioned
    to APPROVED or DENIED, the update fails and the caller (the hook) must
    re-read the row with ConsistentRead (IMPL-24).

    Returns ``True`` on successful write, ``False`` on
    ``ConditionalCheckFailedException``. All other errors propagate.
    """
    _, approvals_table = _require_tables()
    ddb = _get_ddb_client(client=client)

    update_expr_parts = ["#s = :new"]
    expr_values = {
        ":new": {"S": new_status},
        ":pending": {"S": "PENDING"},
    }
    if reason is not None:
        update_expr_parts.append("deny_reason = :reason")
        expr_values[":reason"] = {"S": reason}

    try:
        ddb.update_item(
            TableName=approvals_table,
            Key={"task_id": {"S": task_id}, "request_id": {"S": request_id}},
            UpdateExpression="SET " + ", ".join(update_expr_parts),
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues=expr_values,
        )
        return True
    except Exception as exc:
        code = _extract_error_code(exc)
        if code == "ConditionalCheckFailedException":
            return False
        raise


def get_approval_row(
    task_id: str,
    request_id: str,
    *,
    consistent_read: bool = True,
    client=None,
) -> dict | None:
    """Fetch an approval row. Defaults to strongly-consistent read (IMPL-24).

    Returns a Python dict with unmarshalled attribute values, or ``None`` if
    the row does not exist (TTL reaped, wrong IDs, etc.). Callers use the
    ``None`` return to detect the row-gone branch in §13.12.
    """
    _, approvals_table = _require_tables()
    ddb = _get_ddb_client(client=client)
    resp = ddb.get_item(
        TableName=approvals_table,
        Key={"task_id": {"S": task_id}, "request_id": {"S": request_id}},
        ConsistentRead=consistent_read,
    )
    item = resp.get("Item")
    if item is None:
        return None
    return {k: _ddb_attr_to_py(v) for k, v in item.items()}


def increment_approval_gate_count_in_ddb(
    task_id: str,
    *,
    client=None,
) -> bool:
    """Best-effort atomic increment of ``approval_gate_count`` on TaskTable.

    Chunk 7 persistence layer for decision #13's per-task gate counter. The
    session counter (``PolicyEngine._approval_gate_count``) stays
    authoritative WITHIN a container — this write exists so that a container
    restart (§13.6) can seed the new container's counter from the persisted
    value instead of resetting to 0 and re-exposing the user to another
    ``approval_gate_cap`` worth of gates.

    **Best-effort semantics (§13.6):** the counter is a safety bound, not a
    correctness bound. A DDB write failure here MUST NOT block the gate —
    the session counter still enforces the cap within this container, and
    the §13.6 analysis accepts at most one lost increment per restart as
    acceptable damage. Returns ``True`` on success, ``False`` on any
    failure (config missing, IAM drift, throttling). Never raises.

    Uses a pure ADD UpdateExpression without a ConditionExpression — the
    counter is monotonic and concurrent writes from different hooks on the
    same task are not expected (gates are serialized by the PreToolUse
    lifecycle). If the attribute is missing, DDB initializes it to 0 before
    applying the ADD, matching the CreateTaskFn seed of
    ``approval_gate_count: 0`` (see cdk/src/handlers/shared/create-task-core.ts).

    Deliberately kept separate from the resume TransactWriteItems (§6.5): the
    joint-update invariant on ``status`` + ``awaiting_approval_request_id``
    (§10.2) must not be burdened with a non-safety-critical counter bump.
    """
    try:
        task_table, _ = _require_tables()
    except ApprovalTablesUnavailable as exc:
        log(
            "WARN",
            f"[task_state] increment_approval_gate_count_in_ddb: tables unavailable, "
            f"skipping counter persistence: {exc}",
        )
        return False

    try:
        ddb = _get_ddb_client(client=client)
        ddb.update_item(
            TableName=task_table,
            Key={"task_id": {"S": task_id}},
            UpdateExpression="ADD approval_gate_count :one",
            ExpressionAttributeValues={":one": {"N": "1"}},
        )
    except Exception as exc:
        # Best-effort: do not raise. Log at WARN with the error code so
        # operators can spot IAM drift / throttle / misconfigured tables.
        code = _extract_error_code(exc) or type(exc).__name__
        log(
            "WARN",
            f"[task_state] increment_approval_gate_count_in_ddb failed for task_id={task_id}: "
            f"{code}: {exc}",
        )
        return False
    return True


# ---- Exception-introspection helpers ------------------------------------


def _extract_error_code(exc: BaseException) -> str | None:
    """Pull the AWS error code off a ``ClientError``-shaped exception.

    Duck-typed so tests (and environments without botocore at import time)
    stay decoupled from the concrete exception type.
    """
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return None
    error_block = response.get("Error") or {}
    if not isinstance(error_block, dict):
        return None
    code = error_block.get("Code")
    return code if isinstance(code, str) else None


def _extract_cancellation_reasons(exc: BaseException) -> list:
    """Pull CancellationReasons (best-effort) off a TransactionCanceledException."""
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return []
    reasons = response.get("CancellationReasons")
    if isinstance(reasons, list):
        return reasons
    return []
