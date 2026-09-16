# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Bounded service-owned MicroVM pause/wake routes; no public ingress is added."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Literal

from fastapi import Request  # noqa: TC002 — FastAPI resolves this annotation at registration.
from fastapi.responses import JSONResponse

from microvm_checkpoint import checkpoint_before_suspend, refresh_and_reconcile_after_resume
from microvm_diagnostics import hook_diagnostics, lifecycle_stage
from microvm_lifecycle import LifecycleUnavailable, get_registered_context
from shared_constants import SHARED_CONSTANTS

_BUDGETS = SHARED_CONSTANTS["microvm_hook_budgets"]
LIFECYCLE_HANDLER_BUDGET_S: float = _BUDGETS["lifecycle_handler_budget_seconds"]
LIFECYCLE_HOOK_TIMEOUT_S: float = _BUDGETS["lifecycle_hook_timeout_seconds"]
if not 0 < LIFECYCLE_HANDLER_BUDGET_S < LIFECYCLE_HOOK_TIMEOUT_S:
    raise ValueError("Lifecycle handler must leave time for the service hook response")
_MAX_BODY_BYTES = 4096


class _InvalidBody(ValueError):
    def __init__(self, status: int):
        self.status = status


async def _microvm_id(request: Request) -> str:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_BODY_BYTES:
            raise _InvalidBody(413)
    try:
        payload = json.loads(body) if body else {}
    except (ValueError, UnicodeError) as exc:
        raise _InvalidBody(400) from exc
    if not isinstance(payload, dict):
        raise _InvalidBody(400)
    microvm_id = payload.get("microvmId", "")
    if not isinstance(microvm_id, str) or microvm_id != microvm_id.strip():
        raise _InvalidBody(400)
    # The service sends an empty id on /terminate; tolerate an absent/empty id
    # here too, using only the local /run registration. A supplied id must match.
    return microvm_id


async def _transition(request: Request, action: Literal["suspend", "resume"]) -> JSONResponse:
    lifecycle = get_registered_context()
    with hook_diagnostics(
        action, lifecycle.diagnostic_snapshot if lifecycle else dict
    ) as diagnostics:
        try:
            response = await _handle_transition(request, action)
        except asyncio.CancelledError as exc:
            diagnostics.finish(None, "MICROVM_LIFECYCLE_CANCELLED", exc)
            raise
        diagnostics.finish(
            response.status_code, json.loads(bytes(response.body)).get("code", "acknowledged")
        )
        return response


async def _handle_transition(
    request: Request, action: Literal["suspend", "resume"]
) -> JSONResponse:
    try:
        end = time.monotonic() + LIFECYCLE_HANDLER_BUDGET_S
        async with asyncio.timeout(LIFECYCLE_HANDLER_BUDGET_S):
            with lifecycle_stage("body-read"):
                microvm_id = await _microvm_id(request)
            with lifecycle_stage("identity-check"):
                lifecycle = get_registered_context()
                if lifecycle is None or (microvm_id and microvm_id != lifecycle.microvm_id):
                    raise LifecycleUnavailable("No matching MicroVM task is registered")
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Lifecycle body consumed its budget")
            with lifecycle_stage("controller"):
                if action == "suspend":
                    park = await lifecycle.suspend(checkpoint_before_suspend, budget_s=remaining)
                else:
                    park = await lifecycle.resume(
                        refresh_and_reconcile_after_resume, budget_s=remaining
                    )
            return JSONResponse(
                content={
                    "status": "acknowledged",
                    "action": action,
                    "task_id": park.task_id,
                    "microvm_id": park.microvm_id,
                    "request_id": park.request_id,
                }
            )
    except _InvalidBody as exc:
        return JSONResponse(
            status_code=exc.status, content={"code": "MICROVM_LIFECYCLE_BODY_INVALID"}
        )
    except LifecycleUnavailable:
        return JSONResponse(status_code=409, content={"code": "MICROVM_LIFECYCLE_UNAVAILABLE"})
    except TimeoutError:
        return JSONResponse(status_code=503, content={"code": "MICROVM_LIFECYCLE_TIMEOUT"})
    except Exception as exc:
        # Neither service-hook responses nor logs may echo AWS exception details.
        # A failed/uncertain wake stays behind the controller's closed barrier.
        return JSONResponse(
            status_code=503,
            content={"code": "MICROVM_LIFECYCLE_FAILED", "error_type": type(exc).__name__},
        )


async def microvm_suspend(request: Request) -> JSONResponse:
    return await _transition(request, "suspend")


async def microvm_resume(request: Request) -> JSONResponse:
    return await _transition(request, "resume")
