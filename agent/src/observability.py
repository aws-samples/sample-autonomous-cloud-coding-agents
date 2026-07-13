"""OpenTelemetry instrumentation helpers for the background agent.

Provides a tracer and a convenience context manager for creating spans
with standard task attributes.  ADOT auto-instrumentation (activated via
the ``opentelemetry-instrument`` wrapper in the Dockerfile) handles
exporter/propagator configuration automatically for AgentCore-hosted
agents — this module only needs to create spans and set baggage.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from opentelemetry import baggage, context, trace
from opentelemetry.trace import StatusCode

if TYPE_CHECKING:
    from collections.abc import Generator

    from opentelemetry.trace import Span

# Module-level initialisation is safe because ADOT auto-instrumentation
# (opentelemetry-instrument) configures the TracerProvider before the
# application is imported.  The tracer is a lightweight proxy.
_tracer: trace.Tracer = trace.get_tracer("backgroundagent")


def get_tracer() -> trace.Tracer:
    """Return the module-level OpenTelemetry tracer."""
    return _tracer


@contextmanager
def task_span(
    name: str,
    attributes: dict[str, Any] | None = None,
) -> Generator[Span]:
    """Context manager that wraps a pipeline phase in an OTEL span.

    * Records exceptions and sets span status to ERROR on failure.
    * Accepts optional *attributes* dict merged onto the span at creation.

    Usage::

        with task_span("task.repo_setup", {"repo.url": "owner/repo"}) as span:
            ...
            span.set_attribute("build.before", True)
    """
    tracer = get_tracer()
    with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
        try:
            yield span
        except Exception as exc:
            span.set_status(StatusCode.ERROR, str(exc))
            span.record_exception(exc)
            raise


def current_otel_trace_id() -> str | None:
    """Return the active span's trace id as a 32-char lowercase hex string.

    Used to persist a cross-plane correlation id on the TaskRecord (#515 replay
    bundle) so operators can join the task to its CloudWatch/X-Ray trace. Returns
    ``None`` when there is no recording span (e.g. tracing disabled locally) or
    the context is invalid, so callers can treat it as a graceful-missing field.

    Never raises: a broken/misconfigured tracer degrades to ``None`` rather than
    propagating. Callers read this inside DDB-write try-blocks (progress_writer),
    where a raised trace error would otherwise be misclassified as a DDB failure
    and trip the shared progress circuit breaker.
    """
    try:
        span = trace.get_current_span()
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return None
        # format_trace_id renders the 128-bit id as zero-padded 32-char hex — the
        # OTEL format, so it joins directly in CloudWatch Transaction Search. Note
        # the X-Ray console renders trace ids as ``1-{8hex}-{24hex}``; to look this
        # up there, transform to that form (the timestamp is the first 8 hex chars).
        return trace.format_trace_id(ctx.trace_id)
    except Exception:
        # nosemgrep: py-silent-success-masking -- trace id is a graceful-missing
        # correlation field; a tracer fault must not fail the caller's write path.
        return None


def propagate_correlation_context(
    session_id: str,
    user_id: str = "",
    # ``user_id`` uses ""-means-absent (Cognito sub, mirrors AgentConfig.user_id
    # which is never None); ``repo`` uses None-means-absent (mirrors the optional
    # TaskRecord.repo). Both conventions flow from upstream config types; the
    # ``if x:`` guards below flatten either to "don't set the baggage key".
    repo: str | None = None,
) -> None:
    """Propagate the correlation envelope via OTEL baggage.

    *session_id* correlates custom spans to the AgentCore session; *user_id*
    and *repo* (#245) carry the platform identity and target repo so baggage
    survives across pipeline phases on the task thread. Empty/None fields are
    not set — so this runs (and is useful) even when *session_id* is empty but
    the identity is known. *repo* is None for repo-less workflows (#248 Phase 3).

    The attached context is intentionally not detached: the background thread
    runs a single task then exits, so the context is garbage-collected with the
    thread.
    """
    ctx = context.get_current()
    if session_id:
        ctx = baggage.set_baggage("session.id", session_id, context=ctx)
    if user_id:
        ctx = baggage.set_baggage("user.id", user_id, context=ctx)
    if repo:
        ctx = baggage.set_baggage("repo.url", repo, context=ctx)
    context.attach(ctx)  # token not stored — thread-scoped lifetime
