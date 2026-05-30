"""Tests for the request-id middleware: header echo, minting, sanitization,\nstructlog contextvar binding, and shared id with the audit log."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import pytest
import structlog
from codeclone_serve.app import create_app
from fastapi.testclient import TestClient

HEX16 = re.compile(r"^[0-9a-f]{16}$")


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-test")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    monkeypatch.setenv("SENTRY_DSN", "")
    from codeclone_config.settings import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    app = create_app(model_name="codeclone-test")
    return TestClient(app)


def test_mints_request_id_when_absent(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    rid = r.headers.get("x-request-id")
    assert rid is not None
    assert HEX16.match(rid), rid


def test_honors_valid_inbound_request_id(client: TestClient) -> None:
    given = "req-abc.123:42"
    r = client.get("/healthz", headers={"X-Request-ID": given})
    assert r.headers.get("x-request-id") == given


def test_rejects_malformed_inbound_request_id(client: TestClient) -> None:
    # Spaces are not in the allowed charset, must be replaced with a minted id.
    r = client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"})
    rid = r.headers.get("x-request-id")
    assert rid is not None and HEX16.match(rid)


def test_audit_log_uses_same_request_id(client: TestClient, tmp_path: Path) -> None:
    given = "trace-xyz-001"
    r = client.get(
        "/v1/models",
        headers={"Authorization": "Bearer sk-test", "X-Request-ID": given},
    )
    assert r.status_code == 200
    assert r.headers["x-request-id"] == given

    # Drain the background audit writer.
    sink = client.app.state.audit_sink  # type: ignore[attr-defined]
    sink.close()

    audit_path = Path(tmp_path / "audit.log")
    assert audit_path.exists()
    rows = [json.loads(line) for line in audit_path.read_text().splitlines() if line.strip()]
    matched = [row for row in rows if row.get("path") == "/v1/models"]
    assert matched, rows
    assert matched[-1]["request_id"] == given


def test_request_id_bound_into_structlog_contextvars(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    # Reconfigure structlog to render to stdlib so caplog captures structured
    # fields. Mirror the production processor chain but render as key=value.
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.KeyValueRenderer(key_order=["event", "request_id"]),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=False,
    )
    log = structlog.get_logger("rid-test")

    from codeclone_serve.app import create_app as _create

    app = _create(model_name="codeclone-test")

    @app.get("/__log_probe")
    def _probe() -> dict:
        log.info("probe")
        return {"ok": True}

    given = "rid-probe-9"
    with caplog.at_level(logging.INFO, logger="rid-test"), TestClient(app) as c:
        r = c.get("/__log_probe", headers={"X-Request-ID": given})
    assert r.status_code == 200
    probe_lines = [rec.message for rec in caplog.records if "probe" in rec.message]
    assert probe_lines, caplog.records
    assert any(f'"request_id": "{given}"' in line for line in probe_lines), probe_lines
