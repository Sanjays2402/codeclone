"""Tests for the audit log middleware.

We verify:
- Successful and unauthorized requests both produce a JSONL row.
- The API key is hashed (never recorded in plaintext) and stable per key.
- Excluded paths (health, metrics) do not appear in the log.
- The X-Request-ID response header is set and matches the persisted row.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_serve.app import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def audit_path(tmp_path: Path, monkeypatch) -> Path:
    p = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(p))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return p


def _flush_sink(client: TestClient) -> None:
    sink = client.app.state.audit_sink  # type: ignore[attr-defined]
    sink.flush(timeout=2.0)


def _read_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_audit_records_authed_request(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    r = client.get("/v1/models", headers={"Authorization": "Bearer sk-test-key"})
    assert r.status_code == 200
    assert r.headers.get("X-Request-ID")

    _flush_sink(client)
    rows = _read_rows(audit_path)
    matching = [r for r in rows if r["path"] == "/v1/models"]
    assert matching, f"expected /v1/models row, got {rows!r}"
    row = matching[-1]
    assert row["status"] == 200
    assert row["method"] == "GET"
    assert row["actor"].startswith("key:")
    assert "sk-test-key" not in json.dumps(row)
    assert row["request_id"] == r.headers["X-Request-ID"]
    assert isinstance(row["latency_ms"], (int, float))


def test_audit_records_auth_failure(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    r = client.get("/v1/models")  # no Authorization header
    assert r.status_code == 401

    _flush_sink(client)
    rows = _read_rows(audit_path)
    matching = [r for r in rows if r["path"] == "/v1/models"]
    assert matching
    row = matching[-1]
    assert row["status"] == 401
    assert row["actor"] == "anonymous"


def test_audit_skips_health_and_metrics(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    client.get("/healthz")
    client.get("/readyz")
    client.get("/metrics")

    _flush_sink(client)
    rows = _read_rows(audit_path)
    for row in rows:
        assert row["path"] not in {"/healthz", "/readyz", "/metrics"}


def test_audit_actor_hash_is_stable(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    client.get("/v1/models", headers={"Authorization": "Bearer sk-test-key"})
    client.get("/v1/models", headers={"Authorization": "Bearer sk-test-key"})

    _flush_sink(client)
    rows = [r for r in _read_rows(audit_path) if r["path"] == "/v1/models"]
    actors = {row["actor"] for row in rows}
    assert len(actors) == 1
    assert next(iter(actors)).startswith("key:")


def test_audit_captures_model_field_from_post(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 4,
    }
    r = client.post(
        "/v1/chat/completions",
        json=body,
        headers={"Authorization": "Bearer sk-test-key"},
    )
    assert r.status_code == 200

    _flush_sink(client)
    rows = [r for r in _read_rows(audit_path) if r["path"] == "/v1/chat/completions"]
    assert rows
    assert rows[-1].get("model") == "codeclone"
