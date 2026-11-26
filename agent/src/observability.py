"""OpenTelemetry instrumentation helpers for the background agent.

Creates spans and sets baggage.  Exporter and propagator configuration is
done by ADOT auto-instrumentation (the ``opentelemetry-instrument`` wrapper
in the Dockerfile), not here.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from opentelemetry import baggage, context, trace

from shell import log

if TYPE_CHECKING:
    from collections.abc import Generator

    from opentelemetry.trace import Span

_tracer: trace.Tracer = trace.get_tracer("backgroundagent")


def get_tracer() -> trace.Tracer:
    return _tracer


@contextmanager
def task_span(
    name: str,
    attributes: dict[str, Any] | None = None,
) -> Generator[Span]:
    """Context manager that wraps a pipeline phase in an OTEL span.

    * On failure the tracer records the exception on the span and sets its
      status to ERROR (the defaults of ``start_as_current_span``).
    * Accepts optional *attributes* dict merged onto the span at creation.
    """
    tracer = get_tracer()
    with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
        yield span


def current_otel_trace_id() -> str | None:
    """Return the active span's trace id as a 32-char lowercase hex string.

    Returns ``None`` when there is no recording span or the context is invalid.

    Never raises: a tracer fault is logged at WARN, once per occurrence, and
    yields ``None``.
    """
    try:
        span = trace.get_current_span()
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return None
        # The OTEL format, which CloudWatch Transaction Search takes as it is.
        # The X-Ray console shows the same id as ``1-{8hex}-{24hex}``.
        return trace.format_trace_id(ctx.trace_id)
    except Exception as exc:
        log(
            "WARN",
            f"current_otel_trace_id: tracer fault ({type(exc).__name__}: {exc}); "
            "persisting the record without a correlation id",
        )
        # nosemgrep: py-silent-success-masking -- graceful-missing correlation field, logged above; raising would surface inside the caller's DDB-write try-block and trip the progress circuit breaker (see docstring)  # noqa: E501
        return None


def propagate_correlation_context(
    session_id: str,
    user_id: str = "",
    repo: str | None = None,
) -> None:
    """Propagate the correlation envelope via OTEL baggage.

    Sets ``session.id``, ``user.id`` and ``repo.url``. Empty/None fields are
    not set.

    The attached context is never detached: call this on a thread that runs a
    single task and then exits.
    """
    ctx = context.get_current()
    if session_id:
        ctx = baggage.set_baggage("session.id", session_id, context=ctx)
    if user_id:
        ctx = baggage.set_baggage("user.id", user_id, context=ctx)
    if repo:
        ctx = baggage.set_baggage("repo.url", repo, context=ctx)
    context.attach(ctx)
