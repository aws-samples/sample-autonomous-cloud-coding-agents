from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from http import HTTPStatus
from typing import Any
from urllib.parse import quote, urlparse

import requests

from shared_constants import SHARED_CONSTANTS
from shell import log

JIRA_API_BASE = "https://api.atlassian.com/ex/jira"
_JIRA_APP_ACTOR_CONSTANTS = SHARED_CONSTANTS["jira_app_actor"]
FORGE_WEBTRIGGER_SUFFIX = str(_JIRA_APP_ACTOR_CONSTANTS["forge_webtrigger_suffix"])
APP_ACTOR_MIN_SECRET_LENGTH = int(_JIRA_APP_ACTOR_CONSTANTS["min_secret_length"])

REQUEST_TIMEOUT_SECONDS = 5.0

_AUTH_FAILURE_THRESHOLD = 3
_consecutive_auth_failures: int = 0
_auth_circuit_open: bool = False
_auth_state_lock = threading.Lock()
_PROXY_ERROR_CODES = frozenset(
    {
        "cloud_id_required",
        "invalid_comment_request",
        "invalid_issue_key",
        "invalid_json",
        "invalid_payload",
        "invalid_signature",
        "invalid_transition_request",
        "jira_request_failed",
        "method_not_allowed",
        "payload_too_large",
        "proxy_not_configured",
        "unsupported_operation",
    }
)


def _circuit_open() -> bool:
    with _auth_state_lock:
        return _auth_circuit_open


def _note_auth_status(status_code: int) -> None:
    global _consecutive_auth_failures, _auth_circuit_open

    if status_code in (401, 403):
        with _auth_state_lock:
            _consecutive_auth_failures += 1
            opened = (
                _consecutive_auth_failures >= _AUTH_FAILURE_THRESHOLD and not _auth_circuit_open
            )
            if opened:
                _auth_circuit_open = True
                failures = _consecutive_auth_failures
        if opened:
            log(
                "ERROR",
                "jira_reactions: auth circuit OPEN after "
                f"{failures} consecutive {status_code}s — Jira outbound credential "
                "or app permission is invalid. For Forge app writes, verify "
                "BGAGENT_PROXY_SECRET matches JIRA_APP_ACTOR_SHARED_SECRET. Suppressing further "
                "Jira calls for this container.",
            )
        else:
            log("WARN", f"jira_reactions: HTTP {status_code} from Jira (auth)")
        return

    with _auth_state_lock:
        _consecutive_auth_failures = 0


def _enabled(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> tuple[str, str] | None:
    if channel_source != "jira":
        return None
    if not channel_metadata:
        return None
    cloud_id = channel_metadata.get("jira_cloud_id")
    issue_key = channel_metadata.get("jira_issue_key")
    if not cloud_id or not issue_key:
        return None
    return cloud_id, issue_key


def _adf(text: str) -> dict[str, Any]:
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]},
        ],
    }


def _app_actor_intended() -> bool:
    return os.environ.get("JIRA_APP_ACTOR_CONFIGURED") == "1" or bool(
        os.environ.get("JIRA_APP_ACTOR_PROXY_URL") or os.environ.get("JIRA_APP_ACTOR_SHARED_SECRET")
    )


def _app_actor_credentials() -> tuple[str, str] | None:
    proxy_url = os.environ.get("JIRA_APP_ACTOR_PROXY_URL", "")
    shared_secret = os.environ.get("JIRA_APP_ACTOR_SHARED_SECRET", "")
    try:
        parsed = urlparse(proxy_url)
        valid_url = (
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and parsed.hostname.endswith(FORGE_WEBTRIGGER_SUFFIX)
            and parsed.path.startswith("/public/")
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
        )
    except ValueError:
        valid_url = False
    if not valid_url or len(shared_secret) < APP_ACTOR_MIN_SECRET_LENGTH:
        log(
            "ERROR",
            "jira_reactions: configured Forge app actor is incomplete or invalid; "
            "refusing OAuth fallback",
        )
        return None
    return proxy_url, shared_secret


def _app_actor_request(
    cloud_id: str,
    operation: str,
    *,
    issue_key: str | None = None,
    body: dict[str, Any] | None = None,
    transition_id: str | None = None,
) -> requests.Response | None:
    credentials = _app_actor_credentials()
    if not credentials:
        return None
    proxy_url, shared_secret = credentials
    payload: dict[str, Any] = {
        "version": 1,
        "operation": operation,
        "cloud_id": cloud_id,
    }
    if issue_key is not None:
        payload["issue_key"] = issue_key
    if body is not None:
        payload["body"] = body
    if transition_id is not None:
        payload["transition_id"] = transition_id

    raw_body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    timestamp = str(int(time.time()))
    signature = hmac.new(
        shared_secret.encode(),
        f"{timestamp}.{raw_body}".encode(),
        hashlib.sha256,
    ).hexdigest()
    try:
        response = requests.post(
            proxy_url,
            data=raw_body.encode(),
            headers={
                "Content-Type": "application/json",
                "X-Bgagent-Timestamp": timestamp,
                "X-Bgagent-Signature": f"sha256={signature}",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if not HTTPStatus.OK <= response.status_code < HTTPStatus.MULTIPLE_CHOICES:
            proxy_error = _proxy_error_code(response.text)
            non_retryable = proxy_error == "proxy_not_configured" or (
                response.status_code < HTTPStatus.INTERNAL_SERVER_ERROR
                and response.status_code != HTTPStatus.TOO_MANY_REQUESTS
            )
            level = "ERROR" if non_retryable else "WARN"
            error_id = (
                "JIRA_APP_ACTOR_PROXY_REJECTED"
                if non_retryable
                else "JIRA_APP_ACTOR_PROXY_TRANSIENT"
            )
            log(
                level,
                f"jira_reactions: Forge app proxy returned HTTP {response.status_code} "
                f"error_id={error_id} operation={operation} "
                f"proxy_error={proxy_error or 'unclassified'}",
            )
        return response
    except requests.RequestException as e:
        log(
            "WARN",
            f"jira_reactions: Forge app proxy request failed ({type(e).__name__}): {e}",
        )
        # nosemgrep: py-silent-success-masking -- Jira writes are advisory on network blips
        return None


def _proxy_error_code(raw_body: str) -> str | None:
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError):
        # nosemgrep: py-silent-success-masking -- not JSON: the caller logs it as unclassified
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get("error")
    return value if isinstance(value, str) and value in _PROXY_ERROR_CODES else None


def _post_comment(cloud_id: str, issue_key: str, text: str) -> bool:
    if _circuit_open():
        log("DEBUG", "jira_reactions: auth circuit still open; short-circuiting call")
        return False

    if _app_actor_intended():
        resp = _app_actor_request(
            cloud_id,
            "comment",
            issue_key=issue_key,
            body=_adf(text),
        )
        if resp is None:
            return False
    else:
        token = os.environ.get("JIRA_API_TOKEN", "")
        if not token:
            log("WARN", "jira_reactions: JIRA_API_TOKEN not set; skipping comment")
            return False
        log("WARN", "jira_reactions: app actor not configured; using OAuth fallback")
        url = (
            f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
            f"/rest/api/3/issue/{quote(issue_key, safe='')}/comment"
        )
        try:
            resp = requests.post(
                url,
                json={"body": _adf(text)},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            log("WARN", f"jira_reactions: request failed ({type(e).__name__}): {e}")
            return False

    if resp.status_code in (401, 403):
        _note_auth_status(resp.status_code)
        return False

    if resp.status_code not in (200, 201):
        log("WARN", f"jira_reactions: HTTP {resp.status_code} from Jira: {resp.text[:200]}")
        return False

    _note_auth_status(resp.status_code)
    return True


# Jira's REST API has no lightweight reaction primitive.
def comment_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Post a "starting" comment on the Jira issue. No-op for non-Jira tasks."""
    target = _enabled(channel_source, channel_metadata)
    if not target:
        return
    cloud_id, issue_key = target
    ok = _post_comment(
        cloud_id,
        issue_key,
        "🤖 ABCA picked up this issue and started working on it. "
        "I'll comment again when the pull request is ready.",
    )
    log("TASK", f"jira_reactions: comment_task_started issue={issue_key} ok={ok}")


# No terminal comment from here: ``dispatchToJira`` in
# ``cdk/src/handlers/fanout-task-events.ts`` posts it (issue #573).


# Jira status can only change via the transitions API (``PUT issue`` ignores
# status), and valid transition IDs are workflow- and current-status-specific
# (issue #572).

_IN_PROGRESS_CATEGORY = "indeterminate"

_CATEGORY_RANK = {"new": 0, "indeterminate": 1, "done": 2}

_START_STATUS_NAME = "in progress"

_REVIEW_STATUS_NAMES = (
    "in review",
    "code review",
    "review",
    "peer review",
    "reviewing",
    _START_STATUS_NAME,
)

# ``Blocked`` shares the ``indeterminate`` category with ``In Progress`` (#605).
_CATEGORY_FALLBACK_DENY = ("blocked",)


def _get_issue_transitions(
    cloud_id: str, issue_key: str, token: str
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    if _app_actor_intended():
        resp = _app_actor_request(cloud_id, "get_transitions", issue_key=issue_key)
        if resp is None:
            return None
    else:
        url = (
            f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
            f"/rest/api/3/issue/{quote(issue_key, safe='')}?fields=status&expand=transitions"
        )
        try:
            resp = requests.get(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            log("WARN", f"jira_reactions: issue GET failed ({type(e).__name__}): {e}")
            # nosemgrep: py-silent-success-masking -- advisory Jira transition read
            return None

    if resp.status_code in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        _note_auth_status(resp.status_code)
        return None
    if resp.status_code != HTTPStatus.OK:
        log("WARN", f"jira_reactions: issue GET HTTP {resp.status_code}: {resp.text[:200]}")
        return None

    _note_auth_status(resp.status_code)
    try:
        payload = resp.json()
    except ValueError as e:
        log("WARN", f"jira_reactions: issue GET returned non-JSON: {e}")
        # nosemgrep: py-silent-success-masking -- Jira transitions are best-effort on bad responses
        return None
    if not isinstance(payload, dict):
        log("WARN", "jira_reactions: issue GET returned non-object JSON — skipping")
        return None
    current_status = (payload.get("fields") or {}).get("status") or {}
    transitions = payload.get("transitions", [])
    if not isinstance(current_status, dict):
        current_status = {}
    if not isinstance(transitions, list):
        transitions = []
    return current_status, transitions


def _to_name(t: dict[str, Any]) -> str:
    return ((t.get("to") or {}).get("name") or "").strip().lower()


def _to_category(t: dict[str, Any]) -> str | None:
    return ((t.get("to") or {}).get("statusCategory") or {}).get("key")


def _usable(t: dict[str, Any]) -> bool:
    """A ``hasScreen`` transition may demand fields; without them Jira answers the POST with 400."""
    return isinstance(t, dict) and not t.get("hasScreen", False)


def _select_transition(
    transitions: list[dict[str, Any]],
    *,
    override: str | None,
    prefer_names: tuple[str, ...],
    fallback_category: str | None,
) -> dict[str, Any] | None:
    usable = [t for t in transitions if _usable(t)]

    if override:
        wanted = override.strip().lower()
        return next((t for t in usable if _to_name(t) == wanted), None)

    for name in prefer_names:
        match = next((t for t in usable if _to_name(t) == name), None)
        if match:
            return match

    if fallback_category:
        return next(
            (
                t
                for t in usable
                if _to_category(t) == fallback_category
                and _to_name(t) not in _CATEGORY_FALLBACK_DENY
            ),
            None,
        )
    return None


def _post_transition(cloud_id: str, issue_key: str, token: str, transition_id: str) -> bool:
    if _app_actor_intended():
        resp = _app_actor_request(
            cloud_id,
            "transition",
            issue_key=issue_key,
            transition_id=transition_id,
        )
        if resp is None:
            return False
    else:
        url = (
            f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
            f"/rest/api/3/issue/{quote(issue_key, safe='')}/transitions"
        )
        try:
            resp = requests.post(
                url,
                json={"transition": {"id": transition_id}},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            log("WARN", f"jira_reactions: transition POST failed ({type(e).__name__}): {e}")
            return False

    if resp.status_code in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        _note_auth_status(resp.status_code)
        return False
    if resp.status_code != HTTPStatus.NO_CONTENT:
        log("WARN", f"jira_reactions: transition POST HTTP {resp.status_code}: {resp.text[:200]}")
        return False

    _note_auth_status(resp.status_code)
    return True


def _transition(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
    *,
    lifecycle: str,
    override: str | None,
    prefer_names: tuple[str, ...],
    fallback_category: str | None,
    max_source_rank: int | None,
) -> None:
    target = _enabled(channel_source, channel_metadata)
    if not target:
        return
    cloud_id, issue_key = target

    if _circuit_open():
        log("DEBUG", "jira_reactions: auth circuit open; skipping transition")
        return

    token = os.environ.get("JIRA_API_TOKEN", "")
    if not _app_actor_intended() and not token:
        log("WARN", "jira_reactions: JIRA_API_TOKEN not set; skipping transition")
        return
    if not _app_actor_intended():
        log("WARN", "jira_reactions: app actor not configured; using OAuth fallback")

    result = _get_issue_transitions(cloud_id, issue_key, token)
    if result is None:
        log("WARN", f"jira_reactions: could not read issue {issue_key} — skipping {lifecycle}")
        return
    current_status, transitions = result

    if max_source_rank is not None:
        current_category = (current_status.get("statusCategory") or {}).get("key")
        current_rank = _CATEGORY_RANK.get(current_category)
        if current_rank is not None and current_rank >= max_source_rank:
            log(
                "TASK",
                f"jira_reactions: {lifecycle} skip issue={issue_key} — already at "
                f"{current_status.get('name')!r} (category {current_category!r})",
            )
            return

    if not transitions:
        # Jira returns [] when the user lacks the Transition Issues permission.
        log(
            "WARN",
            f"jira_reactions: no available transitions for {lifecycle} "
            f"issue={issue_key} — skipping",
        )
        return

    current_name = str(current_status.get("name") or "").strip().lower()
    if current_name in prefer_names:
        prefer_names = prefer_names[: prefer_names.index(current_name)]
        fallback_category = None

    chosen = _select_transition(
        transitions,
        override=override,
        prefer_names=prefer_names,
        fallback_category=fallback_category,
    )
    if not chosen:
        log(
            "WARN",
            f"jira_reactions: no matching {lifecycle} transition for issue={issue_key} "
            f"(override={override!r} names={prefer_names} category={fallback_category!r}) "
            "— skipping",
        )
        return

    to_name = (chosen.get("to") or {}).get("name")
    ok = _post_transition(cloud_id, issue_key, token, str(chosen.get("id")))
    log(
        "TASK",
        f"jira_reactions: transition {lifecycle} issue={issue_key} → {to_name!r} ok={ok}",
    )


def transition_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Move the Jira issue to an in-progress status at task start.

    Resolution: ``jira_status_on_start`` override → a destination named
    ``In Progress`` → any ``indeterminate``-category destination. Skips if the
    issue is already In Progress or later (won't move a card backward); an
    override lifts that skip, except for an ``@bgagent`` iteration.
    Best-effort; no-op for non-Jira tasks.
    """
    metadata = channel_metadata or {}
    override = metadata.get("jira_status_on_start")
    from_any_status = bool(override) and not metadata.get("jira_prior_task_id")
    _transition(
        channel_source,
        channel_metadata,
        lifecycle="start",
        override=override,
        prefer_names=() if override else (_START_STATUS_NAME,),
        fallback_category=None if override else _IN_PROGRESS_CATEGORY,
        max_source_rank=None if from_any_status else _CATEGORY_RANK[_IN_PROGRESS_CATEGORY],
    )


def transition_pr_opened(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Move the Jira issue to a review status once a PR is opened.

    Resolution: ``jira_status_on_pr`` override → a destination named
    ``In Review`` (or a common review-column synonym) → any
    ``indeterminate``-category destination. Skips if the issue is already
    Done; an issue that is on one of these names only moves to a name that
    comes before it. Best-effort; no-op for non-Jira tasks.
    """
    override = (channel_metadata or {}).get("jira_status_on_pr")
    _transition(
        channel_source,
        channel_metadata,
        lifecycle="pr_opened",
        override=override,
        prefer_names=() if override else _REVIEW_STATUS_NAMES,
        fallback_category=None if override else _IN_PROGRESS_CATEGORY,
        max_source_rank=None if override else _CATEGORY_RANK["done"],
    )


def _reset_state_for_testing() -> None:
    global _consecutive_auth_failures, _auth_circuit_open
    with _auth_state_lock:
        _consecutive_auth_failures = 0
        _auth_circuit_open = False
