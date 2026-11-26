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

    Mirrors the column layout of ``TaskApprovalsTable``.
    """

    task_id: str
    request_id: str
    tool_name: str
    tool_input_preview: str
    tool_input_sha256: str
    reason: str
    severity: str
    matching_rule_ids: list[str]
    status: str
    created_at: str
    timeout_s: int
    ttl: int
    user_id: str
    repo: str


_table = None


def _get_table():
    global _table
    if _table is not None:
        return _table

    table_name = os.environ.get("TASK_TABLE_NAME")
    if not table_name:
        return None

    from aws_session import tenant_resource

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    dynamodb = tenant_resource("dynamodb", region_name=region)
    _table = dynamodb.Table(table_name)
    return _table


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_submitted(
    task_id: str, repo_url: str = "", issue_number: str = "", task_description: str = ""
) -> None:
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
    """Update ``agent_heartbeat_at`` while the task is RUNNING."""
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

    Idempotent + best-effort. Skips silently if the task is already
    past SUBMITTED/HYDRATING.
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
            return
        log(
            "WARN",
            f"[task_state] write_session_info failed (best-effort): {type(e).__name__}: {e}",
        )


def write_running(task_id: str) -> None:
    """Transition a task to RUNNING.

    Updates ``status_created_at`` alongside ``status`` so the
    ``UserStatusIndex`` GSI sort key reflects the current status.
    ``updated_at`` moves with the status too.
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
        update_parts = ["#s = :s", "started_at = :t", "status_created_at = :sca", "updated_at = :t"]

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
        log("WARN", f"[task_state] write_running failed (best-effort): {type(e).__name__}: {e}")


def write_terminal(task_id: str, status: str, result: dict | None = None) -> None:  # noqa: C901 -- 24 when the ceiling of 15 was set; must not grow
    """Transition a task to a terminal state (COMPLETED or FAILED).

    Updates ``status_created_at`` and ``updated_at`` alongside ``status`` — see
    :func:`write_running` for why.
    """
    try:
        table = _get_table()
        if table is None:
            return
        now = _now_iso()
        expr_names = {"#s": "status"}
        expr_values: dict[str, object] = {
            ":s": status,
            ":t": now,
            ":sca": f"{status}#{now}",
            ":running": "RUNNING",
            ":hydrating": "HYDRATING",
            ":finalizing": "FINALIZING",
            ":awaiting_approval": "AWAITING_APPROVAL",
        }
        update_parts = [
            "#s = :s",
            "completed_at = :t",
            "status_created_at = :sca",
            "updated_at = :t",
        ]

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
            if result.get("build_passed") is not None:
                update_parts.append("build_passed = :bp")
                expr_values[":bp"] = bool(result["build_passed"])
            if result.get("lint_passed") is not None:
                update_parts.append("lint_passed = :lp")
                expr_values[":lp"] = bool(result["lint_passed"])
            if result.get("code_changed") is not None:
                update_parts.append("code_changed = :cc")
                expr_values[":cc"] = bool(result["code_changed"])
            if result.get("head_sha"):
                update_parts.append("head_sha = :hsha")
                expr_values[":hsha"] = str(result["head_sha"])
            if result.get("answer_text"):
                update_parts.append("answer_text = :ans")
                expr_values[":ans"] = str(result["answer_text"])[:2000]
            if result.get("otel_trace_id"):
                update_parts.append("otel_trace_id = :otid")
                expr_values[":otid"] = result["otel_trace_id"]
            if result.get("trace_s3_uri"):
                update_parts.append("trace_s3_uri = :ts3")
                expr_values[":ts3"] = result["trace_s3_uri"]
            if result.get("artifact_uri"):
                update_parts.append("artifact_uri = :au")
                expr_values[":au"] = result["artifact_uri"]

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
            if result and result.get("trace_s3_uri"):
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
        log("WARN", f"[task_state] write_terminal failed (best-effort): {type(e).__name__}: {e}")


def write_trace_uri_conditional(task_id: str, uri: str) -> bool:
    """Persist ``trace_s3_uri`` on an already-terminal record.

    Only writes when:
      1. The status is terminal (CANCELLED / COMPLETED / FAILED / TIMED_OUT).
      2. ``trace_s3_uri`` is not already set.

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
            ``None`` (== "record not found").
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


TASK_APPROVALS_TABLE_ENV = "TASK_APPROVALS_TABLE_NAME"
TASK_TABLE_ENV = "TASK_TABLE_NAME"

_STATUS_RUNNING = "RUNNING"
_STATUS_AWAITING_APPROVAL = "AWAITING_APPROVAL"


class ApprovalTablesUnavailable(RuntimeError):
    """Either ``TASK_APPROVALS_TABLE_NAME`` or ``TASK_TABLE_NAME`` is unset.

    Hook maps to DENY (fail-closed). Distinct from ``TaskFetchError`` so
    callers do not collapse a config problem with a transient read failure.
    """


class ApprovalWriteError(RuntimeError):
    """``transact_write_approval_request`` TransactionCanceledException.

    Fired when the cross-table atomic write is cancelled — either the
    TaskTable precondition fails (task already cancelled / advanced past
    RUNNING) or the approval row already exists. Hook maps to DENY +
    ``approval_write_failed``. The underlying cancellation reasons
    are stashed on ``.cancellation_reasons`` for triage.
    """

    def __init__(self, message: str, cancellation_reasons: list | None = None) -> None:
        super().__init__(message)
        self.cancellation_reasons = cancellation_reasons or []


class ApprovalResumeError(RuntimeError):
    """``transact_resume_from_approval`` TransactionCanceledException.

    Fired when the resume transition fails — typically because the user
    cancelled the task mid-approval. Hook maps to DENY +
    ``approval_resume_failed``.
    """

    def __init__(self, message: str, cancellation_reasons: list | None = None) -> None:
        super().__init__(message)
        self.cancellation_reasons = cancellation_reasons or []


def _get_ddb_client(*, client=None):
    if client is not None:
        return client
    from aws_session import tenant_client

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    return tenant_client("dynamodb", region_name=region)


def _require_tables() -> tuple[str, str]:
    task_table = os.environ.get(TASK_TABLE_ENV)
    approvals_table = os.environ.get(TASK_APPROVALS_TABLE_ENV)
    if not task_table or not approvals_table:
        raise ApprovalTablesUnavailable(
            f"{TASK_TABLE_ENV}/{TASK_APPROVALS_TABLE_ENV} unset; approval gates cannot be recorded"
        )
    return task_table, approvals_table


def _py_to_ddb_attr(value):
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        if all(isinstance(v, str) for v in value):
            return {"L": [{"S": v} for v in value]}
        raise TypeError(f"unsupported list element types in approval row: {value!r}")
    raise TypeError(f"unsupported approval-row attribute type: {type(value).__name__}")


def _ddb_attr_to_py(attr):
    if attr is None:
        return None
    if "NULL" in attr:
        return None
    if "BOOL" in attr:
        return attr["BOOL"]
    if "N" in attr:
        raw = attr["N"]
        try:
            return int(raw)
        except ValueError:
            return raw
    if "S" in attr:
        return attr["S"]
    if "L" in attr:
        return [_ddb_attr_to_py(item) for item in attr["L"]]
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
    approval_item.setdefault("task_id", {"S": task_id})
    approval_item.setdefault("request_id", {"S": request_id})
    approval_item.setdefault("status", {"S": "PENDING"})
    now = _now_iso()

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
                            "SET #s = :awaiting, awaiting_approval_request_id = :rid, "
                            "status_created_at = :sca, updated_at = :now"
                        ),
                        "ConditionExpression": "#s = :running",
                        "ExpressionAttributeNames": {"#s": "status"},
                        "ExpressionAttributeValues": {
                            ":awaiting": {"S": _STATUS_AWAITING_APPROVAL},
                            ":running": {"S": _STATUS_RUNNING},
                            ":rid": {"S": request_id},
                            ":sca": {"S": f"{_STATUS_AWAITING_APPROVAL}#{now}"},
                            ":now": {"S": now},
                        },
                    }
                },
            ]
        )
    except Exception as exc:
        reasons = _extract_cancellation_reasons(exc)
        code = _extract_error_code(exc)
        if code == "TransactionCanceledException":
            raise ApprovalWriteError(
                f"approval write cancelled: reasons={reasons}",
                cancellation_reasons=reasons,
            ) from exc
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
      - resuming a task that's been cancelled mid-approval;
      - resuming with a stale request_id after a race with the
        reconciler / a concurrent approval.

    Refreshes ``agent_heartbeat_at`` in the same update.

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
                            "SET #s = :running, agent_heartbeat_at = :heartbeat, "
                            "updated_at = :heartbeat, "
                            "status_created_at = :sca REMOVE awaiting_approval_request_id"
                        ),
                        "ConditionExpression": (
                            "#s = :awaiting AND awaiting_approval_request_id = :rid"
                        ),
                        "ExpressionAttributeNames": {"#s": "status"},
                        "ExpressionAttributeValues": {
                            ":sca": {"S": f"{_STATUS_RUNNING}#{_now_iso()}"},
                            ":running": {"S": _STATUS_RUNNING},
                            ":awaiting": {"S": _STATUS_AWAITING_APPROVAL},
                            ":rid": {"S": request_id},
                            ":heartbeat": {"S": _now_iso()},
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

    The condition ``status = :pending`` guards the write. Used on the
    TIMED_OUT write path: if the row has already transitioned to APPROVED
    or DENIED, the update fails and the caller (the hook) must re-read the
    row with ConsistentRead.

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
    """Fetch an approval row. Defaults to a strongly-consistent read.

    Returns a Python dict with unmarshalled attribute values, or ``None`` if
    the row does not exist (TTL reaped, wrong IDs, etc.).
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

    Returns ``True`` on success, ``False`` on any failure (config missing, IAM
    drift, throttling). Never raises.

    Uses a pure ADD UpdateExpression without a ConditionExpression. If the
    attribute is missing, DDB initializes it to 0 before applying the ADD.
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
        code = _extract_error_code(exc) or type(exc).__name__
        log(
            "WARN",
            f"[task_state] increment_approval_gate_count_in_ddb failed for task_id={task_id}: "
            f"{code}: {exc}",
        )
        return False
    return True


def _extract_error_code(exc: BaseException) -> str | None:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return None
    error_block = response.get("Error") or {}
    if not isinstance(error_block, dict):
        return None
    code = error_block.get("Code")
    return code if isinstance(code, str) else None


def _extract_cancellation_reasons(exc: BaseException) -> list:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return []
    reasons = response.get("CancellationReasons")
    if isinstance(reasons, list):
        return reasons
    return []
