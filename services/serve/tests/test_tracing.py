"""Tests for OpenTelemetry tracing wiring on the serve API.

Covers the regression that prompted this module: the previous OTel block in
``app.py`` was disabled by a comment that swallowed its ``if`` guard, so
distributed tracing silently did nothing. These tests prove the new
``init_tracing`` path actually:

1. Stays a quiet no-op when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is unset.
2. Installs a TracerProvider and instruments FastAPI when the endpoint is
   set, even without the OTLP HTTP exporter package present.
3. Produces a span per request whose ``trace_id`` shows up in both
   structlog output and the persisted audit log line for that request.
4. Exposes the tracing status on ``/healthz``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_tracing_state():
    from codeclone_serve import tracing

    tracing._reset_for_tests()
    yield
    tracing._reset_for_tests()


def _settings_no_endpoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-test")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    monkeypatch.setenv("SENTRY_DSN", "")
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    from codeclone_config.settings import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]


def _settings_with_endpoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-test")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    monkeypatch.setenv("SENTRY_DSN", "")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "codeclone-test")
    from codeclone_config.settings import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_init_is_noop_when_endpoint_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _settings_no_endpoint(monkeypatch, tmp_path)
    from codeclone_serve.app import create_app
    from codeclone_serve.tracing import is_initialized

    app = create_app(model_name="codeclone-test")
    client = TestClient(app)

    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["tracing"] is False
    assert is_initialized() is False


def test_init_installs_provider_when_endpoint_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _settings_with_endpoint(monkeypatch, tmp_path)
    from codeclone_serve.app import create_app
    from codeclone_serve.tracing import is_initialized

    app = create_app(model_name="codeclone-test")
    client = TestClient(app)

    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["tracing"] is True
    assert is_initialized() is True


def test_request_produces_span_and_trace_id_in_audit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _settings_with_endpoint(monkeypatch, tmp_path)

    from codeclone_serve.app import create_app

    app = create_app(model_name="codeclone-test")

    # Attach an in-memory exporter to whatever provider init_tracing set up
    # so we can assert a span was actually recorded for the request, without
    # needing a live OTLP collector.
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider), (
        f"init_tracing should have installed a real TracerProvider, got {type(provider)}"
    )
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    client = TestClient(app)
    r = client.get(
        "/v1/models",
        headers={"Authorization": "Bearer sk-test", "X-Request-ID": "trace-audit-001"},
    )
    assert r.status_code == 200

    spans = exporter.get_finished_spans()
    assert spans, "FastAPIInstrumentor should have recorded at least one span"
    request_spans = [s for s in spans if "/v1/models" in (s.name or "")]
    assert request_spans, f"expected span for /v1/models, got {[s.name for s in spans]}"
    span = request_spans[0]
    expected_trace_id = f"{span.context.trace_id:032x}"

    # Drain the audit sink and confirm the persisted line carries the same
    # trace_id and the request_id we sent.
    app.state.audit_sink.flush(timeout=2.0)
    audit_path = tmp_path / "audit.log"
    assert audit_path.exists(), "audit log should have been written"
    lines = [json.loads(line) for line in audit_path.read_text().splitlines() if line]
    matched = [r for r in lines if r.get("request_id") == "trace-audit-001"]
    assert matched, f"no audit record for our request id; got {lines}"
    rec = matched[0]
    assert rec.get("trace_id") == expected_trace_id, rec
    assert rec.get("span_id"), rec


def test_current_trace_context_is_safe_with_no_span() -> None:
    from codeclone_serve.tracing import current_trace_context

    # Outside any request, with the default no-op provider, this must return
    # an empty dict and never raise.
    assert current_trace_context() == {}
