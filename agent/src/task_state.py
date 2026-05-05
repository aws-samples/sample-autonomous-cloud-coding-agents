"""Best-effort task state persistence to DynamoDB.

All writes are wrapped in try/except so a DynamoDB outage never breaks the
agent pipeline. When the TASK_TABLE_NAME environment variable is unset, all
operations are no-ops.
"""

import os
import time

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
        print(f"[task_state] write_submitted failed (best-effort): {e}")


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
        print(f"[task_state] write_heartbeat failed (best-effort): {type(e).__name__}: {e}")


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
        print(f"[task_state] write_session_info failed (best-effort): {type(e).__name__}: {e}")


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
            print("[task_state] write_running skipped: status precondition not met")
            return
        print(f"[task_state] write_running failed (best-effort): {type(e).__name__}")


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
            ConditionExpression="#s IN (:running, :hydrating, :finalizing)",
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        from botocore.exceptions import ClientError

        if (
            isinstance(e, ClientError)
            and e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
        ):
            print(
                "[task_state] write_terminal skipped: "
                "status precondition not met (task may have been cancelled)"
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
                print(
                    f"[task_state] trace_s3_uri orphaned by "
                    f"ConditionalCheckFailed: task_id={task_id!r} "
                    f"trace_s3_uri={result['trace_s3_uri']!r}. "
                    f"S3 object exists but TaskRecord will not be "
                    f"updated; presigned-URL endpoint will 404 for "
                    f"this task. Object will be reaped by the 7-day "
                    f"lifecycle.",
                    flush=True,
                )
                healed = write_trace_uri_conditional(task_id, result["trace_s3_uri"])
                if healed:
                    print(
                        f"[task_state] trace_s3_uri self-healed for "
                        f"task_id={task_id!r} after ConditionalCheckFailed "
                        f"(terminal-state race).",
                        flush=True,
                    )
            return
        print(f"[task_state] write_terminal failed (best-effort): {type(e).__name__}")


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
            print(
                f"[task_state] write_trace_uri_conditional skipped for "
                f"task_id={task_id!r}: precondition not met "
                f"(trace_s3_uri already set or status not terminal).",
                flush=True,
            )
            return False
        print(
            f"[task_state] write_trace_uri_conditional failed for "
            f"task_id={task_id!r}: {type(e).__name__}: {e}",
            flush=True,
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
        print(f"[task_state] get_task failed: {type(e).__name__}: {e}")
        raise TaskFetchError(f"{type(e).__name__}: {e}") from e
    return resp.get("Item")
