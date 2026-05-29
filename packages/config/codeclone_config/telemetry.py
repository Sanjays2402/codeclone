"""Centralized OpenTelemetry hookup."""

from __future__ import annotations

from typing import Any


def setup_tracing(service_name: str, endpoint: str | None) -> Any | None:
    """Initialize OTel tracing if `endpoint` is set; otherwise no-op."""
    if not endpoint:
        return None
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return None
    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    return provider
