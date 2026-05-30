"""Tests for the GDPR data lifecycle endpoints.

Covers:
- Export streams only rows belonging to the caller's key fingerprint.
- Delete actually removes those rows from the JSONL file on disk.
- Delete records an auditable ``gdpr.erasure`` event afterwards.
- Non-admin callers cannot target another caller's actor fingerprint.
- Admin (wildcard scope) callers can target any actor.
- A malformed actor query is rejected with 400.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_serve.app import create_app
from fastapi.testclient import TestClient


def _fingerprint(raw: str) -> str:
    import hashlib

    return f"key:{hashlib.sha256(raw.encode()).hexdigest()[:12]}"


@pytest.fixture
def audit_env(tmp_path: Path, monkeypatch):
    p = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(p))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    # Two keys: a regular caller and an admin (wildcard via legacy slot).
    monkeypatch.setenv(
        "CODECLONE_API_KEYS", "sk-alice:models:read+infer,sk-admin:*"
    )
    monkeypatch.delenv("CODECLONE_API_KEY", raising=False)
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return p


def _client() -> TestClient:
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


def _generate_audit_rows(client: TestClient) -> None:
    # Two requests as alice, one as admin, all on /v1/models.
    for _ in range(2):
        r = client.get(
            "/v1/models", headers={"Authorization": "Bearer sk-alice"}
        )
        assert r.status_code == 200
    r = client.get("/v1/models", headers={"Authorization": "Bearer sk-admin"})
    assert r.status_code == 200
    client.app.state.audit_sink.flush(timeout=2.0)  # type: ignore[attr-defined]


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_export_returns_only_callers_rows(audit_env: Path):
    client = _client()
    _generate_audit_rows(client)

    r = client.get(
        "/v1/data/export", headers={"Authorization": "Bearer sk-alice"}
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    # First line is meta, last is summary, middle are matching rows.
    assert lines[0]["_meta"]["actor"] == _fingerprint("sk-alice")
    summary = lines[-1]["_summary"]
    assert summary["actor"] == _fingerprint("sk-alice")
    assert summary["rows"] == 2
    middle = lines[1:-1]
    assert len(middle) == 2
    for row in middle:
        assert row["actor"] == _fingerprint("sk-alice")
        assert row["path"] == "/v1/models"


def test_delete_purges_callers_rows_and_logs_erasure(audit_env: Path):
    client = _client()
    _generate_audit_rows(client)
    before = _read_jsonl(audit_env)
    alice_before = [r for r in before if r.get("actor") == _fingerprint("sk-alice")]
    assert len(alice_before) == 2

    r = client.request(
        "DELETE",
        "/v1/data/delete",
        headers={"Authorization": "Bearer sk-alice"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["actor"] == _fingerprint("sk-alice")
    assert body["deleted"] == 2
    assert body["purged_at"]

    # Allow the erasure event to be flushed.
    client.app.state.audit_sink.flush(timeout=2.0)  # type: ignore[attr-defined]
    after = _read_jsonl(audit_env)
    # Alice's request rows for /v1/models and /v1/data/delete are gone. The
    # only alice-actor row that should remain is the gdpr.erasure event.
    alice_after = [r for r in after if r.get("actor") == _fingerprint("sk-alice")]
    assert len(alice_after) == 1
    assert alice_after[0].get("event") == "gdpr.erasure"

    erasure = [r for r in after if r.get("event") == "gdpr.erasure"]
    assert len(erasure) == 1
    assert erasure[0]["target_actor"] == _fingerprint("sk-alice")
    assert erasure[0]["deleted"] == 2
    # Admin row should still be present.
    assert any(r.get("actor") == _fingerprint("sk-admin") for r in after)


def test_non_admin_cannot_target_other_actor(audit_env: Path):
    client = _client()
    _generate_audit_rows(client)
    r = client.get(
        "/v1/data/export",
        params={"actor": _fingerprint("sk-admin")},
        headers={"Authorization": "Bearer sk-alice"},
    )
    assert r.status_code == 403


def test_admin_can_target_any_actor(audit_env: Path):
    client = _client()
    _generate_audit_rows(client)
    r = client.get(
        "/v1/data/export",
        params={"actor": _fingerprint("sk-alice")},
        headers={"Authorization": "Bearer sk-admin"},
    )
    assert r.status_code == 200
    summary = json.loads(r.text.splitlines()[-1])["_summary"]
    assert summary["actor"] == _fingerprint("sk-alice")
    assert summary["rows"] == 2


def test_malformed_actor_rejected(audit_env: Path):
    client = _client()
    _generate_audit_rows(client)
    r = client.get(
        "/v1/data/export",
        params={"actor": "not-a-fingerprint"},
        headers={"Authorization": "Bearer sk-alice"},
    )
    assert r.status_code == 400
