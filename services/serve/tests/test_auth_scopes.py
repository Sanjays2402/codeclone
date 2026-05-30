"""Tests for multi-key API auth with per-key scopes (RBAC)."""

from __future__ import annotations

import pytest
from codeclone_config.settings import reset_settings_cache
from codeclone_serve.app import create_app
from codeclone_serve.auth import (
    KNOWN_SCOPES,
    Principal,
    _build_keyring,
    _parse_multi,
    require_scope,
)
from fastapi.testclient import TestClient


def _client() -> TestClient:
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


# ---------- parser ----------


def test_parse_multi_basic():
    recs = _parse_multi("sk-ro:models:read+infer, sk-admin:*")
    assert len(recs) == 2
    by_key = {r.raw: r for r in recs}
    assert by_key["sk-ro"].scopes == frozenset({"models:read", "infer"})
    assert by_key["sk-admin"].scopes == frozenset({"*"})
    # Fingerprints are deterministic sha256 prefixes.
    assert by_key["sk-ro"].fingerprint.startswith("key:")
    assert len(by_key["sk-ro"].fingerprint) == len("key:") + 12


def test_parse_multi_skips_empty_entries():
    recs = _parse_multi(" , sk-a:infer ,, ")
    assert [r.raw for r in recs] == ["sk-a"]


def test_parse_multi_rejects_missing_scope():
    with pytest.raises(ValueError, match="missing scope segment"):
        _parse_multi("sk-broken")


def test_parse_multi_rejects_unknown_scope():
    with pytest.raises(ValueError, match="unknown scope"):
        _parse_multi("sk-x:bogus")


def test_known_scopes_stable():
    # Adding a scope must be a deliberate edit; this guards accidental drift.
    assert frozenset({"models:read", "infer", "admin"}) == KNOWN_SCOPES


# ---------- keyring assembly ----------


def test_legacy_key_implicitly_wildcard(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-legacy")
    monkeypatch.delenv("CODECLONE_API_KEYS", raising=False)
    reset_settings_cache()
    ring = _build_keyring()
    assert "sk-legacy" in ring
    assert ring["sk-legacy"].scopes == frozenset({"*"})


def test_multi_keys_merge_with_legacy(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-legacy")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-ro:models:read,sk-infer:infer")
    reset_settings_cache()
    ring = _build_keyring()
    assert set(ring) == {"sk-legacy", "sk-ro", "sk-infer"}
    assert ring["sk-ro"].scopes == frozenset({"models:read"})
    assert ring["sk-infer"].scopes == frozenset({"infer"})


# ---------- end-to-end RBAC on routes ----------


def test_unauth_blocks_v1():
    c = _client()
    assert c.get("/v1/models").status_code == 401


def test_invalid_key_rejected():
    c = _client()
    r = c.get("/v1/models", headers={"Authorization": "Bearer not-a-real-key"})
    assert r.status_code == 401


def test_legacy_key_can_call_everything(monkeypatch):
    # conftest already sets CODECLONE_API_KEY=sk-test-key with wildcard.
    c = _client()
    r = c.get("/v1/models", headers={"Authorization": "Bearer sk-test-key"})
    assert r.status_code == 200
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 4,
    }
    r = c.post(
        "/v1/chat/completions",
        json=body,
        headers={"Authorization": "Bearer sk-test-key"},
    )
    assert r.status_code == 200, r.text


def test_models_read_key_cannot_infer(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-ro:models:read")
    reset_settings_cache()
    c = _client()
    hdr = {"Authorization": "Bearer sk-ro"}
    # models:read scope is allowed.
    assert c.get("/v1/models", headers=hdr).status_code == 200
    # infer is not, so chat completions must 403 not 401.
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 4,
    }
    r = c.post("/v1/chat/completions", json=body, headers=hdr)
    assert r.status_code == 403
    assert "infer" in r.json()["detail"]


def test_infer_key_cannot_list_models(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-i:infer")
    reset_settings_cache()
    c = _client()
    hdr = {"Authorization": "Bearer sk-i"}
    r = c.get("/v1/models", headers=hdr)
    assert r.status_code == 403
    assert "models:read" in r.json()["detail"]
    body = {"model": "codeclone", "prompt": "x", "max_tokens": 4}
    assert c.post("/v1/completions", json=body, headers=hdr).status_code == 200


def test_wildcard_explicit_in_multi(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-all:*")
    reset_settings_cache()
    c = _client()
    hdr = {"Authorization": "Bearer sk-all"}
    assert c.get("/v1/models", headers=hdr).status_code == 200
    body = {"model": "codeclone", "prompt": "x", "max_tokens": 4}
    assert c.post("/v1/completions", json=body, headers=hdr).status_code == 200


def test_require_scope_rejects_unknown_at_construction():
    with pytest.raises(ValueError, match="unknown scope"):
        require_scope("not-a-scope")


def test_principal_has_scope_logic():
    p = Principal(fingerprint="key:abc", scopes=frozenset({"infer"}))
    assert p.has_scope("infer")
    assert not p.has_scope("admin")
    star = Principal(fingerprint="key:xyz", scopes=frozenset({"*"}))
    assert star.has_scope("infer")
    assert star.has_scope("admin")
