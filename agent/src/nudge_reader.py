# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Read pending user "nudges" from the TaskNudgesTable between agent turns.

Phase 2 Nudge — short authoritative steering messages written by the REST API
and injected as XML-tagged user messages into the agent's next turn.

Design contract
---------------
Table shape (owned by the REST API, not this module):
  - PK ``task_id`` (STRING)
  - SK ``nudge_id`` (STRING, ULID — lexicographic == chronological)
  - ``message`` (STRING)
  - ``created_at`` (STRING, ISO-8601)
  - ``consumed`` (BOOL)
  - ``consumed_at`` (STRING, optional, set when consumed)
  - ``user_id`` (STRING)
  - ``ttl`` (NUMBER, optional)

Table name read from env var ``NUDGES_TABLE_NAME``.  If unset the reader
silently returns ``[]`` and logs a single WARN (fail-open).

Resilience
----------
All DDB exceptions (network, throttling, validation) are caught and logged at
WARN.  Callers receive ``[]`` or ``False`` — a nudge-table outage MUST NOT
break the agent turn loop.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any, TypedDict

from shell import log


class PendingNudge(TypedDict):
    """Shape of a single pending nudge returned by ``read_pending``."""

    nudge_id: str
    message: str
    created_at: str


# Max items returned from a paginated ``read_pending`` scan.  The table's PK
# is per-task, rate-limited to 10/min and TTL-retained for 30 days, so a
# healthy task should not exceed this.  Truncating is preferable to
# unbounded memory growth; a WARN log surfaces the condition.
_MAX_PENDING_ITEMS = 100

# Module-level cache for the boto3 Table resource — initialised lazily on
# first read, reused across calls for the lifetime of the process.
_TABLE_CACHE: Any = None
_TABLE_NAME_WARNED = False


def _get_table() -> Any | None:
    """Return a cached boto3 DynamoDB Table resource, or None if unavailable.

    Reads ``NUDGES_TABLE_NAME`` from the environment.  When unset, logs a
    single WARN and returns None on every subsequent call.
    """
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
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        dynamodb = boto3.resource("dynamodb", region_name=region)
        _TABLE_CACHE = dynamodb.Table(table_name)
        return _TABLE_CACHE
    except Exception as exc:
        log("WARN", f"Failed to init nudge DDB table: {type(exc).__name__}: {exc}")
        return None


def _reset_cache_for_tests() -> None:
    """Test-only helper to clear module-level caches between test cases."""
    global _TABLE_CACHE, _TABLE_NAME_WARNED
    _TABLE_CACHE = None
    _TABLE_NAME_WARNED = False


def read_pending(task_id: str, table: Any | None = None) -> list[PendingNudge]:
    """Return unconsumed nudges for *task_id*, sorted by ``nudge_id`` ASC.

    ULIDs sort chronologically, so ASC ordering == oldest-first.  Returns
    ``[]`` on any error or if the nudges table is not configured.

    Paginates on ``LastEvaluatedKey`` — DDB Query returns at most 1 MB per
    page, and ``FilterExpression`` is applied post-page, so a task with
    many consumed rows could hide pending nudges behind the first page.
    Caps total items at ``_MAX_PENDING_ITEMS`` and logs a WARN if hit.

    Each returned dict contains ``nudge_id``, ``message``, ``created_at``.
    """
    tbl = table if table is not None else _get_table()
    if tbl is None:
        return []

    try:
        from boto3.dynamodb.conditions import Attr, Key

        items: list[dict[str, Any]] = []
        last_key: dict[str, Any] | None = None
        truncated = False
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
        return []

    if truncated:
        log(
            "WARN",
            f"Nudge read_pending truncated at {_MAX_PENDING_ITEMS} items for "
            f"task {task_id}; older pending nudges were dropped",
        )

    # Query with HASH key already returns items sorted by SK ASC, but filter
    # expression is applied post-sort; be explicit so callers can rely on
    # ordering regardless of how the table is queried.
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

    # Lazy import so tests without boto3 installed still load the module.
    ClientError: type[Exception] | None
    try:
        from botocore.exceptions import ClientError as _CE

        ClientError = _CE
    except Exception:  # pragma: no cover — boto3/botocore always present at runtime
        ClientError = None

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
        # Structured ClientError path: boto3 wraps the DDB error code in
        # ``exc.response["Error"]["Code"]``.
        if ClientError is not None and isinstance(exc, ClientError):
            code = exc.response.get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                log("DEBUG", f"Nudge {nudge_id} already consumed (conditional check)")
                return False
            log(
                "WARN",
                f"Nudge mark_consumed ClientError for {nudge_id}: {code}: {exc}",
            )
            return False
        # Fallback: some tests/mocks raise a bare exception subclass named
        # ``ConditionalCheckFailedException`` rather than a real ClientError.
        exc_name = type(exc).__name__
        if exc_name == "ConditionalCheckFailedException":
            log("DEBUG", f"Nudge {nudge_id} already consumed (conditional check)")
            return False
        # Also handle fake ClientError duck-types carrying response["Error"]["Code"].
        response = getattr(exc, "response", None)
        if isinstance(response, dict):
            code = (
                response.get("Error", {}).get("Code")
                if isinstance(response.get("Error"), dict)
                else None
            )
            if code == "ConditionalCheckFailedException":
                log("DEBUG", f"Nudge {nudge_id} already consumed (conditional check)")
                return False
        log("WARN", f"Nudge mark_consumed failed for {nudge_id}: {exc_name}: {exc}")
        return False


def _xml_escape(text: str) -> str:
    """Escape XML predefined entities for safe inclusion in text/attributes.

    Prevents a user nudge from forging a closing ``</user_nudge>`` tag and
    smuggling content out of the authoritative block.

    We escape ``& < > "`` — all five XML entities minus ``'``.  Apostrophe
    escaping (``&apos;``) is only needed inside single-quoted attribute
    values, and we always emit double-quoted attributes; pasted user text
    containing ``don't`` etc. stays readable in logs.
    """
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def format_as_user_message(nudges: list[PendingNudge]) -> str:
    """Render a list of nudge dicts as authoritative ``<user_nudge>`` XML blocks.

    Each block is on its own line; multiple blocks are joined with a single
    newline separator.  Attribute values and message body are XML-escaped so
    a malicious nudge cannot escape the envelope.
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
