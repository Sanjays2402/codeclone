"""OpenTelemetry tracing for the serve API.

Wires distributed tracing into FastAPI so every request gets a real
``trace_id`` / ``span_id`` that is:

* propagated across services via W3C ``traceparent`` headers (default
  TextMap propagator),
* exported to an OTLP collector when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is set,
* bound into ``structlog`` contextvars so every log line emitted while a
  request is in flight carries ``trace_id`` and ``span_id``,
* surfaced in the JSONL audit log so a single id stitches an HTTP request
  to its trace, its logs, and (when enabled) its Sentry event.

The previous wiring lived inside ``app.py`` but was disabled by a comment
that swallowed the ``if`` guard, so the OTel block never executed. This
module replaces it with a tested, idempotent, no-op-safe init.

Initialization is a no-op when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is unset, so
local development and CI stay quiet. When the OTLP HTTP exporter package is
not installed we fall back to an in-process tracer provider (still useful:
spans show up in tests and ``trace_id`` still flows into logs), and we log a
single warning instead of crashing the process.
"""

from __future__ import annotations

from typing import Any

from codeclone_config.logging import get_logger
from codeclone_config.settings import Settings

log = get_logger(__name__)

# Module-level flag so tests, /healthz consumers, and audit can tell if
# tracing is live in this process.
_INITIALIZED: bool = False
_INSTRUMENTED_APP_IDS: set[int] = set()


def is_initialized() -> bool:
    """Whether OTel tracing was initialized in this process."""
    return _INITIALIZED


def _reset_for_tests() -> None:
    """Test hook. Lets tests re-exercise the init path on a fresh process."""
    global _INITIALIZED
    _INITIALIZED = False
    _INSTRUMENTED_APP_IDS.clear()


def current_trace_context() -> dict[str, str]:
    """Return ``{"trace_id": ..., "span_id": ...}`` for the active span.

    Returns an empty dict when OpenTelemetry is not installed, when there is
    no active span, or when the span has the all-zero invalid context. Safe
    to call from any thread; never raises.
    """
    try:
        from opentelemetry import trace
    except Exception:
        return {}
    span = trace.get_current_span()
    if span is None:
        return {}
    ctx = span.get_span_context()
    if not getattr(ctx, "is_valid", False):
        return {}
    return {
        "trace_id": f"{ctx.trace_id:032x}",
        "span_id": f"{ctx.span_id:016x}",
    }


def init_tracing(settings: Settings, app: Any | None = None) -> bool:
    """Initialize OTel tracing from settings. Idempotent.

    Returns True when tracing is active in this process, False otherwise
    (no endpoint configured, SDK missing, or init failed).
    """
    global _INITIALIZED

    if not settings.otel_endpoint:
        # Still allow FastAPI instrumentation so trace_ids exist even with
        # the default no-op provider? No: without a provider, get_current_span
        # returns an invalid context anyway. Cheaper to skip entirely.
        return _INITIALIZED

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception as e:  # pragma: no cover - exercised when SDK absent
        log.warning("otel.sdk_missing", error=str(e))
        return False

    if not _INITIALIZED:
        provider = TracerProvider(
            resource=Resource.create(
                {
                    "service.name": settings.otel_service,
                    "service.namespace": "codeclone",
                }
            )
        )
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )

            provider.add_span_processor(
                BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otel_endpoint))
            )
            log.info(
                "otel.exporter_otlp_http_ready",
                endpoint=settings.otel_endpoint,
                service=settings.otel_service,
            )
        except Exception as e:
            # No exporter installed: still set the provider so trace ids flow
            # into logs locally. Operators who care about export will see the
            # warning and install opentelemetry-exporter-otlp-proto-http.
            log.warning(
                "otel.exporter_missing",
                error=str(e),
                hint="pip install opentelemetry-exporter-otlp-proto-http",
            )

        trace.set_tracer_provider(provider)
        _INITIALIZED = True
        log.info(
            "otel.initialized",
            endpoint=settings.otel_endpoint,
            service=settings.otel_service,
        )

    if app is not None and id(app) not in _INSTRUMENTED_APP_IDS:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
            _INSTRUMENTED_APP_IDS.add(id(app))
        except Exception as e:  # pragma: no cover - defensive
            log.warning("otel.fastapi_instrument_failed", error=str(e))

    return _INITIALIZED
