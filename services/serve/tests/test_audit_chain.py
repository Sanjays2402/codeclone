"""Tests for the tamper-evident audit log hash chain.

We verify:

- Every emitted JSONL row carries ``seq``, ``prev_hash``, and ``hash``.
- The chain links: every row's ``prev_hash`` equals the previous row's ``hash``.
- ``GET /v1/audit/verify`` reports ``ok`` and returns the head hash on a
  clean log, and the endpoint is admin-scoped (a ``models:read`` key gets 403).
- Tampering with a row's payload (or its ``hash``) causes verification to fail
  with ``broken_at_seq`` pointing at the tampered row, and the endpoint
  responds with HTTP 409.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_serve.app import create_app
from codeclone_serve.audit import AuditSink, verify_chain
from fastapi.testclient import TestClient


@pytest.fixture
def audit_path(tmp_path: Path, monkeypatch) -> Path:
    p = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(p))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    # Two keys: an admin (wildcard) and a read-only key, both tenant-scoped.
    monkeypatch.setenv(
        "CODECLONE_API_KEYS",
        "sk-admin:*@acme,sk-ro:models:read@acme",
    )
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return p


def _flush(client: TestClient) -> None:
    client.app.state.audit_sink.flush(timeout=2.0)  # type: ignore[attr-defined]


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_audit_log_is_chained_per_row(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    for _ in range(4):
        r = client.get(
            "/v1/models", headers={"Authorization": "Bearer sk-admin"}
        )
        assert r.status_code == 200
    _flush(client)

    rows = _rows(audit_path)
    assert len(rows) >= 4
    # Every row has the chain triple.
    for row in rows:
        assert "seq" in row and "prev_hash" in row and "hash" in row
        assert isinstance(row["seq"], int) and row["seq"] >= 1
        assert len(row["hash"]) == 64 and len(row["prev_hash"]) == 64

    # And the chain links: prev_hash[i] == hash[i-1], seq increments by 1.
    prev = AuditSink.GENESIS_HASH
    expected_seq = 1
    for row in rows:
        assert row["prev_hash"] == prev, row
        assert row["seq"] == expected_seq, row
        prev = row["hash"]
        expected_seq += 1


def test_verify_endpoint_ok_on_clean_log(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    # Generate some traffic to chain.
    for _ in range(3):
        client.get("/v1/models", headers={"Authorization": "Bearer sk-admin"})

    r = client.get(
        "/v1/audit/verify", headers={"Authorization": "Bearer sk-admin"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["enabled"] is True
    assert body["chained_entries"] >= 3
    assert body["last_hash"] and len(body["last_hash"]) == 64
    assert r.headers.get("X-Audit-Chain-Status") == "ok"


def test_verify_endpoint_requires_admin_scope(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    r = client.get(
        "/v1/audit/verify", headers={"Authorization": "Bearer sk-ro"}
    )
    assert r.status_code == 403, r.text


def test_verify_detects_tampering(audit_path: Path):
    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    for _ in range(3):
        client.get("/v1/models", headers={"Authorization": "Bearer sk-admin"})
    _flush(client)

    # Tamper with the middle row: change the recorded status. This must be
    # detected because the hash was computed over the original payload.
    lines = audit_path.read_text().splitlines()
    assert len(lines) >= 3
    target_idx = len(lines) // 2
    tampered = json.loads(lines[target_idx])
    tampered["status"] = 418
    lines[target_idx] = json.dumps(tampered, separators=(",", ":"))
    audit_path.write_text("\n".join(lines) + "\n")

    # Direct verifier call sees the break.
    result = verify_chain(audit_path)
    assert result["ok"] is False
    assert result["broken_at_seq"] == target_idx + 1
    assert result["broken_reason"] in {"hash_mismatch", "prev_hash_mismatch"}

    # Endpoint surfaces 409 + broken header.
    r = client.get(
        "/v1/audit/verify", headers={"Authorization": "Bearer sk-admin"}
    )
    assert r.status_code == 409, r.text
    assert r.headers.get("X-Audit-Chain-Status") == "broken"
    body = r.json()
    assert body["ok"] is False
    assert body["broken_at_seq"] is not None
