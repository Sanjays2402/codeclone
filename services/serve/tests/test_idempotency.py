"""Tests for Idempotency-Key replay, conflict, and cross-tenant isolation.

These prove the contract enterprise customers actually care about:

* Same key + same body within the TTL replays the cached response and
  surfaces ``Idempotency-Replayed: true`` so observability/billing pipelines
  can distinguish a real call from a retry.
* Same key + different body returns ``409 Conflict``: silently serving stale
  data would be worse than erroring.
* The cache is partitioned by tenant: tenant A's idempotency key MUST NOT
  bleed into tenant B even when the opaque key string is identical. This is
  the multi-tenancy guarantee procurement reviewers will probe.
* Malformed keys are rejected with ``400`` (no silent acceptance).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_config.settings import reset_settings_cache
from codeclone_serve.app import create_app
from codeclone_serve.idempotency import (
    IdempotencyKeyError,
    IdempotencyStore,
    ReplayConflict,
    ReplayHit,
    fingerprint_body,
    validate_key,
)
from fastapi.testclient import TestClient


# ---------- unit: key validation ----------


@pytest.mark.parametrize("k", ["abc", "a" * 255, "key-with_punct.123", "sk_42!"])
def test_validate_key_accepts_visible_ascii(k):
    assert validate_key(k) == k


@pytest.mark.parametrize(
    "k",
    [
        "",
        "a" * 256,
        "has space",
        "tab\there",
        "newline\nhere",
        "non-ascii-é",
    ],
)
def test_validate_key_rejects_bad_input(k):
    with pytest.raises(IdempotencyKeyError):
        validate_key(k)


def test_fingerprint_is_order_independent():
    a = {"prompt": "x", "max_tokens": 4, "model": "codeclone"}
    b = {"model": "codeclone", "max_tokens": 4, "prompt": "x"}
    assert fingerprint_body(a) == fingerprint_body(b)


def test_fingerprint_differs_for_distinct_bodies():
    assert fingerprint_body({"prompt": "x"}) != fingerprint_body({"prompt": "y"})


# ---------- unit: store ----------


def test_store_replay_hit_after_put(tmp_path):
    s = IdempotencyStore(tmp_path / "idem.json")
    s.store("acme", "k1", "fp1", status=200, body={"ok": True}, headers={"content-type": "application/json"})
    res = s.lookup("acme", "k1", "fp1")
    assert isinstance(res, ReplayHit)
    assert res.response.body == {"ok": True}
    assert res.response.status == 200


def test_store_conflict_on_different_body(tmp_path):
    s = IdempotencyStore(tmp_path / "idem.json")
    s.store("acme", "k1", "fp1", status=200, body={"ok": True}, headers={})
    res = s.lookup("acme", "k1", "fp2")
    assert isinstance(res, ReplayConflict)


def test_store_isolates_tenants(tmp_path):
    """Same key string in two tenants does NOT collide."""
    s = IdempotencyStore(tmp_path / "idem.json")
    s.store("acme", "shared", "fp-a", status=200, body={"who": "acme"}, headers={})
    s.store("globex", "shared", "fp-g", status=200, body={"who": "globex"}, headers={})
    a = s.lookup("acme", "shared", "fp-a")
    g = s.lookup("globex", "shared", "fp-g")
    assert isinstance(a, ReplayHit) and a.response.body == {"who": "acme"}
    assert isinstance(g, ReplayHit) and g.response.body == {"who": "globex"}


def test_store_evicts_after_ttl(tmp_path):
    s = IdempotencyStore(tmp_path / "idem.json", ttl_seconds=1)
    s.store("acme", "k1", "fp1", status=200, body={"ok": True}, headers={})
    # Manually backdate the entry instead of sleeping.
    data = json.loads((tmp_path / "idem.json").read_text())
    for v in data.values():
        v["created_at"] = 0.0
    (tmp_path / "idem.json").write_text(json.dumps(data))
    assert s.lookup("acme", "k1", "fp1") is None


# ---------- end-to-end via the FastAPI app ----------


def _enable_two_tenant_app(monkeypatch, tmp_path, audit_path: Path | None = None) -> TestClient:
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-acme:infer@acme,sk-globex:infer@globex")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_QUOTA_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_IDEMPOTENCY_ENABLED", "true")
    monkeypatch.setenv(
        "CODECLONE_IDEMPOTENCY_STATE_PATH", str(tmp_path / "idem.json")
    )
    if audit_path is not None:
        monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
        monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit_path))
        monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "0")
    else:
        monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "false")
    reset_settings_cache()
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


def _post(c: TestClient, key: str, *, bearer: str, prompt: str = "hello") -> "object":
    return c.post(
        "/v1/completions",
        json={"model": "codeclone", "prompt": prompt, "max_tokens": 4},
        headers={"Authorization": f"Bearer {bearer}", "Idempotency-Key": key},
    )


def test_e2e_replays_same_key_same_body(monkeypatch, tmp_path):
    c = _enable_two_tenant_app(monkeypatch, tmp_path)
    r1 = _post(c, "abc-123", bearer="sk-acme")
    assert r1.status_code == 200
    assert r1.headers.get("Idempotency-Replayed") is None
    r2 = _post(c, "abc-123", bearer="sk-acme")
    assert r2.status_code == 200
    assert r2.headers.get("Idempotency-Replayed") == "true"
    assert r2.json() == r1.json()


def test_e2e_conflict_same_key_different_body(monkeypatch, tmp_path):
    c = _enable_two_tenant_app(monkeypatch, tmp_path)
    r1 = _post(c, "abc-123", bearer="sk-acme", prompt="alpha")
    assert r1.status_code == 200
    r2 = _post(c, "abc-123", bearer="sk-acme", prompt="bravo")
    assert r2.status_code == 409
    body = r2.json()
    assert body["error"]["type"] == "idempotency_conflict"


def test_e2e_cross_tenant_isolation(monkeypatch, tmp_path):
    """Same opaque key in two tenants does NOT replay across the boundary."""
    c = _enable_two_tenant_app(monkeypatch, tmp_path)
    a = _post(c, "shared-key", bearer="sk-acme", prompt="acme-prompt")
    assert a.status_code == 200
    assert a.headers.get("Idempotency-Replayed") is None
    # Same key, different tenant. Must be processed fresh, NOT replayed.
    g = _post(c, "shared-key", bearer="sk-globex", prompt="globex-prompt")
    assert g.status_code == 200, g.text
    assert g.headers.get("Idempotency-Replayed") is None
    # And a different body under tenant globex with the same key must NOT
    # leak acme's cached body via a 409 from acme's entry.
    g2 = _post(c, "shared-key", bearer="sk-globex", prompt="globex-prompt")
    assert g2.status_code == 200
    assert g2.headers.get("Idempotency-Replayed") == "true"


def test_e2e_rejects_malformed_key(monkeypatch, tmp_path):
    c = _enable_two_tenant_app(monkeypatch, tmp_path)
    r = c.post(
        "/v1/completions",
        json={"model": "codeclone", "prompt": "x", "max_tokens": 4},
        headers={
            "Authorization": "Bearer sk-acme",
            "Idempotency-Key": "bad key with space",
        },
    )
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "invalid_idempotency_key"


def test_e2e_audit_records_replay(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    c = _enable_two_tenant_app(monkeypatch, tmp_path, audit_path=audit)
    _post(c, "audit-key", bearer="sk-acme")
    r2 = _post(c, "audit-key", bearer="sk-acme")
    assert r2.headers.get("Idempotency-Replayed") == "true"
    c.app.state.audit_sink.flush(timeout=2.0)
    rows = [json.loads(line) for line in audit.read_text().splitlines() if line]
    events = {r.get("event") for r in rows}
    assert "idempotency.replay" in events
