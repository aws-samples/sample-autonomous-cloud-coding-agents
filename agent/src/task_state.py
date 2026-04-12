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


def write_running(task_id: str) -> None:
    """Transition a task to RUNNING (called at agent start)."""
    try:
        table = _get_table()
        if table is None:
            return
        expr_names = {"#s": "status"}
        expr_values = {
            ":s": "RUNNING",
            ":t": _now_iso(),
            ":submitted": "SUBMITTED",
            ":hydrating": "HYDRATING",
        }
        update_parts = ["#s = :s", "started_at = :t"]

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
    """Transition a task to a terminal state (COMPLETED or FAILED)."""
    try:
        table = _get_table()
        if table is None:
            return
        expr_names = {"#s": "status"}
        expr_values = {
            ":s": status,
            ":t": _now_iso(),
            ":running": "RUNNING",
            ":hydrating": "HYDRATING",
            ":finalizing": "FINALIZING",
        }
        update_parts = ["#s = :s", "completed_at = :t"]

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
            if result.get("prompt_version"):
                update_parts.append("prompt_version = :pv")
                expr_values[":pv"] = result["prompt_version"]
            if result.get("memory_written") is not None:
                update_parts.append("memory_written = :mw")
                expr_values[":mw"] = result["memory_written"]

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
            return
        print(f"[task_state] write_terminal failed (best-effort): {type(e).__name__}")


def get_task(task_id: str) -> dict | None:
    """Fetch a task record by ID. Returns None if not found or on error."""
    try:
        table = _get_table()
        if table is None:
            return None
        resp = table.get_item(Key={"task_id": task_id})
        return resp.get("Item")
    except Exception as e:
        print(f"[task_state] get_task failed: {e}")
        return None
