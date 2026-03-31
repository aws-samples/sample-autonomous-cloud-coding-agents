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


def set_session_id(session_id: str) -> None:
    """Propagate *session_id* via OTEL baggage for AgentCore session correlation.

    The attached context is intentionally not detached: the background thread
    runs a single task then exits, so the context is garbage-collected with the
    thread.
    """
    ctx = baggage.set_baggage("session.id", session_id)
    context.attach(ctx)  # token not stored — thread-scoped lifetime
