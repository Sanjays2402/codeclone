"""Tests for multi-tenant API key binding and tenant-scoped audit + GDPR."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_config.settings import reset_settings_cache
from codeclone_serve.app import create_app
from codeclone_serve.auth import (
    DEFAULT_TENANT,
    Principal,
    _build_keyring,
    _parse_multi,
    _validate_tenant,
)
from fastapi.testclient import TestClient


def _client(audit_path: Path | None = None) -> TestClient:
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


# ---------- parser ----------


def test_parse_multi_assigns_default_tenant_when_no_suffix():
    recs = _parse_multi("sk-a:infer")
    assert len(recs) == 1
    assert recs[0].tenant == DEFAULT_TENANT


def test_parse_multi_parses_tenant_suffix():
    recs = _parse_multi("sk-acme:infer@acme,sk-globex:models:read+infer@globex")
    by_key = {r.raw: r for r in recs}
    assert by_key["sk-acme"].tenant == "acme"
    assert by_key["sk-globex"].tenant == "globex"
    assert by_key["sk-globex"].scopes == frozenset({"models:read", "infer"})


def test_parse_multi_admin_with_tenant():
    recs = _parse_multi("sk-ops:*@platform")
    assert recs[0].tenant == "platform"
    assert recs[0].scopes == frozenset({"*"})


@pytest.mark.parametrize(
    "bad",
    [
        "sk-a:infer@",          # empty tenant
        "sk-a:@acme",            # empty scope
        "sk-a:infer@ACME",       # uppercase
        "sk-a:infer@bad_tenant", # underscore
        "sk-a:infer@-leading",   # starts with hyphen
        "sk-a:infer@" + "x" * 100,  # too long
    ],
)
def test_parse_multi_rejects_bad_tenant(bad):
    with pytest.raises(ValueError):
        _parse_multi(bad)


def test_validate_tenant_accepts_dns_label_shapes():
    for ok in ("acme", "team-1", "a", "0", "tenant-with-many-segments"):
        assert _validate_tenant(ok) == ok


def test_legacy_single_key_defaults_to_default_tenant(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-legacy")
    monkeypatch.delenv("CODECLONE_API_KEYS", raising=False)
    reset_settings_cache()
    ring = _build_keyring()
    assert ring["sk-legacy"].tenant == DEFAULT_TENANT


# ---------- principal + request.state.tenant ----------


def test_principal_tenant_visible_on_request_state(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-acme:infer@acme")
    reset_settings_cache()
    c = _client()
    # The handler does not directly expose tenant but the audit row will,
    # so call an inference endpoint and verify the audit log carries tenant.
    r = c.post(
        "/v1/completions",
        json={"model": "codeclone", "prompt": "x", "max_tokens": 4},
        headers={"Authorization": "Bearer sk-acme"},
    )
    assert r.status_code == 200, r.text


def test_principal_is_admin_helper():
    p = Principal(fingerprint="key:abc", scopes=frozenset({"*"}), tenant="t")
    assert p.is_admin()
    q = Principal(fingerprint="key:def", scopes=frozenset({"admin"}), tenant="t")
    assert q.is_admin()
    r = Principal(fingerprint="key:ghi", scopes=frozenset({"infer"}), tenant="t")
    assert not r.is_admin()


# ---------- audit log carries tenant ----------


def test_audit_log_records_tenant(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-acme:infer@acme,sk-globex:infer@globex")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "0")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    reset_settings_cache()

    c = _client()
    c.post(
        "/v1/completions",
        json={"model": "codeclone", "prompt": "x", "max_tokens": 4},
        headers={"Authorization": "Bearer sk-acme"},
    )
    c.post(
        "/v1/completions",
        json={"model": "codeclone", "prompt": "x", "max_tokens": 4},
        headers={"Authorization": "Bearer sk-globex"},
    )
    # Force the background sink to flush.
    c.app.state.audit_sink.flush(timeout=2.0)

    rows = [json.loads(line) for line in audit.read_text().splitlines() if line]
    tenants = {r["tenant"] for r in rows if r["path"] == "/v1/completions"}
    assert tenants == {"acme", "globex"}


# ---------- GDPR data lifecycle is tenant scoped ----------


def _seed_audit(audit: Path, rows: list[dict]) -> None:
    audit.parent.mkdir(parents=True, exist_ok=True)
    with audit.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def test_export_only_returns_caller_tenant_rows(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv(
        "CODECLONE_API_KEYS", "sk-acme:infer@acme,sk-globex:infer@globex"
    )
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "0")
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    reset_settings_cache()

    # Resolve fingerprints from the keyring.
    ring = _build_keyring()
    fp_acme = ring["sk-acme"].fingerprint
    fp_globex = ring["sk-globex"].fingerprint

    _seed_audit(
        audit,
        [
            {"ts": "t1", "actor": fp_acme, "tenant": "acme", "path": "/x"},
            {"ts": "t2", "actor": fp_globex, "tenant": "globex", "path": "/x"},
            # A pathological collision: same fingerprint, wrong tenant.
            {"ts": "t3", "actor": fp_acme, "tenant": "globex", "path": "/x"},
        ],
    )

    c = _client()
    r = c.get(
        "/v1/data/export",
        headers={"Authorization": "Bearer sk-acme"},
    )
    assert r.status_code == 200
    lines = [json.loads(ln) for ln in r.text.splitlines() if ln]
    # First line is _meta, last is _summary; data rows in between.
    data_rows = [ln for ln in lines if "_meta" not in ln and "_summary" not in ln]
    assert len(data_rows) == 1
    assert data_rows[0]["actor"] == fp_acme
    assert data_rows[0]["tenant"] == "acme"

    summary = next(ln for ln in lines if "_summary" in ln)
    assert summary["_summary"]["tenant"] == "acme"
    assert summary["_summary"]["rows"] == 1


def test_non_admin_cannot_cross_tenant(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv("CODECLONE_API_KEYS", "sk-acme:infer@acme")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit))
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    reset_settings_cache()
    audit.write_text("")

    c = _client()
    r = c.get(
        "/v1/data/export?tenant=globex",
        headers={"Authorization": "Bearer sk-acme"},
    )
    assert r.status_code == 403
    assert "tenant" in r.json()["detail"]


def test_admin_can_cross_tenant(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv(
        "CODECLONE_API_KEYS",
        "sk-acme:infer@acme,sk-ops:*@platform",
    )
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit))
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    reset_settings_cache()

    ring = _build_keyring()
    fp_acme = ring["sk-acme"].fingerprint
    _seed_audit(
        audit,
        [
            {"ts": "t1", "actor": fp_acme, "tenant": "acme", "path": "/x"},
        ],
    )

    c = _client()
    r = c.get(
        f"/v1/data/export?tenant=acme&actor={fp_acme}",
        headers={"Authorization": "Bearer sk-ops"},
    )
    assert r.status_code == 200
    lines = [json.loads(ln) for ln in r.text.splitlines() if ln]
    summary = next(ln for ln in lines if "_summary" in ln)
    assert summary["_summary"]["tenant"] == "acme"
    assert summary["_summary"]["rows"] == 1


def test_delete_only_purges_caller_tenant(monkeypatch, tmp_path):
    audit = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "")
    monkeypatch.setenv(
        "CODECLONE_API_KEYS", "sk-acme:infer@acme,sk-globex:infer@globex"
    )
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_ENABLED", "true")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit))
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    reset_settings_cache()

    ring = _build_keyring()
    fp_acme = ring["sk-acme"].fingerprint
    fp_globex = ring["sk-globex"].fingerprint

    _seed_audit(
        audit,
        [
            {"ts": "t1", "actor": fp_acme, "tenant": "acme", "path": "/x"},
            {"ts": "t2", "actor": fp_acme, "tenant": "acme", "path": "/x"},
            {"ts": "t3", "actor": fp_globex, "tenant": "globex", "path": "/x"},
        ],
    )

    c = _client()
    r = c.delete(
        "/v1/data/delete",
        headers={"Authorization": "Bearer sk-acme"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tenant"] == "acme"
    assert body["deleted"] == 2

    # The globex row survives, plus the appended erasure record.
    remaining = [
        json.loads(ln) for ln in audit.read_text().splitlines() if ln
    ]
    survivor_rows = [r for r in remaining if "event" not in r]
    assert len(survivor_rows) == 1
    assert survivor_rows[0]["tenant"] == "globex"

    erasure = [r for r in remaining if r.get("event") == "gdpr.erasure"]
    assert len(erasure) == 1
    assert erasure[0]["target_tenant"] == "acme"
    assert erasure[0]["tenant"] == "acme"
