# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Read pending user "nudges" from the TaskNudgesTable between agent turns.

Nudges are short steering messages written by the REST API and injected as
XML-tagged user messages into the agent's next turn.

Table name read from env var ``NUDGES_TABLE_NAME``.  If unset the reader
returns ``[]`` and logs a single WARN.

All DDB exceptions are caught and logged at WARN.  Callers receive ``[]`` or
``False``.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any, TypedDict

from shell import log
from task_state import _extract_error_code


class PendingNudge(TypedDict):
    nudge_id: str
    message: str
    created_at: str


_MAX_PENDING_ITEMS = 100

_TABLE_CACHE: Any = None
_TABLE_NAME_WARNED = False


def _get_table() -> Any | None:
    global _TABLE_CACHE, _TABLE_NAME_WARNED

    if _TABLE_CACHE is not None:
        return _TABLE_CACHE

    table_name = os.environ.get("NUDGES_TABLE_NAME")
    if not table_name:
        if not _TABLE_NAME_WARNED:
            log("WARN", "NUDGES_TABLE_NAME unset — nudge reader disabled")
            _TABLE_NAME_WARNED = True
        return None

    try:
        from aws_session import tenant_resource

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        dynamodb = tenant_resource("dynamodb", region_name=region)
        _TABLE_CACHE = dynamodb.Table(table_name)
        return _TABLE_CACHE
    except Exception as exc:
        log("WARN", f"Failed to init nudge DDB table: {type(exc).__name__}: {exc}")
        # nosemgrep: py-silent-success-masking -- nudge table init failure; read_pending returns []
        return None


def _reset_cache_for_tests() -> None:
    global _TABLE_CACHE, _TABLE_NAME_WARNED
    _TABLE_CACHE = None
    _TABLE_NAME_WARNED = False


def read_pending(task_id: str, table: Any | None = None) -> list[PendingNudge]:
    """Return unconsumed nudges for *task_id*, sorted by ``nudge_id`` ASC.

    ULIDs sort chronologically, so ASC ordering == oldest-first.  Returns
    ``[]`` on any error or if the nudges table is not configured.

    Caps total items at ``_MAX_PENDING_ITEMS`` and logs a WARN if hit.
    """
    tbl = table if table is not None else _get_table()
    if tbl is None:
        return []

    try:
        from boto3.dynamodb.conditions import Attr, Key

        items: list[dict[str, Any]] = []
        last_key: dict[str, Any] | None = None
        truncated = False
        # DynamoDB applies ``FilterExpression`` after it reads a page (at most
        # 1 MB), so pending nudges can sit behind a page of consumed rows.
        while True:
            kwargs: dict[str, Any] = {
                "KeyConditionExpression": Key("task_id").eq(task_id),
                "FilterExpression": Attr("consumed").eq(False),
            }
            if last_key is not None:
                kwargs["ExclusiveStartKey"] = last_key
            response = tbl.query(**kwargs)
            page_items = response.get("Items", []) or []
            items.extend(page_items)
            if len(items) >= _MAX_PENDING_ITEMS:
                truncated = True
                items = items[:_MAX_PENDING_ITEMS]
                break
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
    except Exception as exc:
        log("WARN", f"Nudge DDB query failed: {type(exc).__name__}: {exc}")
        # nosemgrep: py-silent-success-masking -- DDB query failure yields no pending nudges
        return []

    if truncated:
        log(
            "WARN",
            f"Nudge read_pending truncated at {_MAX_PENDING_ITEMS} items for "
            f"task {task_id}; older pending nudges were dropped",
        )

    items.sort(key=lambda it: it.get("nudge_id", ""))

    return [
        PendingNudge(
            nudge_id=str(it.get("nudge_id", "")),
            message=str(it.get("message", "")),
            created_at=str(it.get("created_at", "")),
        )
        for it in items
        if it.get("nudge_id")
    ]


def mark_consumed(task_id: str, nudge_id: str, table: Any | None = None) -> bool:
    """Atomically mark a nudge as consumed.

    Uses a conditional update (``consumed = false``) for idempotency — if two
    workers race, only one will succeed.  Returns True on success, False if
    already consumed or on any error.
    """
    tbl = table if table is not None else _get_table()
    if tbl is None:
        return False

    now_iso = datetime.now(UTC).isoformat()

    try:
        tbl.update_item(
            Key={"task_id": task_id, "nudge_id": nudge_id},
            # ``consumed`` is a DDB reserved keyword — alias via #c.
            UpdateExpression="SET #c = :true, consumed_at = :now",
            ConditionExpression="#c = :false",
            ExpressionAttributeNames={"#c": "consumed"},
            ExpressionAttributeValues={
                ":true": True,
                ":false": False,
                ":now": now_iso,
            },
        )
        return True
    except Exception as exc:
        if _extract_error_code(exc) == "ConditionalCheckFailedException":
            log("DEBUG", f"Nudge {nudge_id} already consumed (conditional check)")
        else:
            log("WARN", f"Nudge mark_consumed failed for {nudge_id}: {type(exc).__name__}: {exc}")
        return False


def _xml_escape(text: str) -> str:
    # XML needs ``&apos;`` only inside a single-quoted attribute value.
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def format_as_user_message(nudges: list[PendingNudge]) -> str:
    """Render a list of nudge dicts as ``<user_nudge>`` XML blocks.

    Multiple blocks are joined with a single newline separator.  Attribute
    values and message body are XML-escaped.
    """
    if not nudges:
        return ""

    blocks = []
    for n in nudges:
        ts = _xml_escape(str(n.get("created_at", "")))
        nid = _xml_escape(str(n.get("nudge_id", "")))
        body = _xml_escape(str(n.get("message", "")))
        blocks.append(f'<user_nudge timestamp="{ts}" nudge_id="{nid}">\n{body}\n</user_nudge>')
    return "\n".join(blocks)
