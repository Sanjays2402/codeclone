"""Tests for per-tenant monthly request quotas."""

from __future__ import annotations

from pathlib import Path

import pytest
from codeclone_serve.app import create_app
from codeclone_serve.quota import (
    QuotaStore,
    current_period,
    parse_overrides,
    period_reset_epoch,
)
from fastapi.testclient import TestClient


def _client(monkeypatch, tmp_path: Path, **env: str) -> TestClient:
    state = tmp_path / "quota.json"
    base = {
        "CODECLONE_QUOTA_ENABLED": "true",
        "CODECLONE_QUOTA_STATE_PATH": str(state),
        # Keep the per-minute limiter generous so quota tests don't trip it.
        "CODECLONE_RATELIMIT_PER_IP_RPM": "10000",
        "CODECLONE_RATELIMIT_PER_KEY_RPM": "10000",
        "CODECLONE_RATELIMIT_PER_TENANT_RPM": "10000",
        "CODECLONE_RATELIMIT_BURST": "1000",
        "CODECLONE_AUDIT_LOG_ENABLED": "false",
    }
    base.update(env)
    for k, v in base.items():
        monkeypatch.setenv(k, v)
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return TestClient(app=create_app(model_dir=None, model_name="codeclone-test"))


def test_parse_overrides_roundtrip():
    assert parse_overrides("") == {}
    assert parse_overrides("acme=100, globex=0") == {"acme": 100, "globex": 0}
    with pytest.raises(ValueError):
        parse_overrides("acme")
    with pytest.raises(ValueError):
        parse_overrides("BAD=10")
    with pytest.raises(ValueError):
        parse_overrides("acme=-5")
    with pytest.raises(ValueError):
        parse_overrides("acme=oops")


def test_period_reset_epoch_rolls_to_next_month():
    e_dec = period_reset_epoch("2026-12")
    e_jan = period_reset_epoch("2027-01")
    # December rolls into 2027-01-01 UTC.
    assert e_dec < e_jan
    # And January rolls into 2027-02-01 UTC, which is 31 days later.
    e_feb = period_reset_epoch("2027-02")
    assert e_feb - e_jan == 28 * 86400  # Feb 2027 has 28 days


def test_quota_store_persists_across_instances(tmp_path: Path):
    p = tmp_path / "q.json"
    s1 = QuotaStore(p)
    assert s1.consume("acme", limit=5)[:2] == (True, 1)
    assert s1.consume("acme", limit=5)[:2] == (True, 2)
    s2 = QuotaStore(p)
    # Reopening the store recovers the persisted counter.
    snap = s2.snapshot("acme")
    assert snap["used"] == 2
    assert snap["period"] == current_period()


def test_quota_store_blocks_after_limit(tmp_path: Path):
    s = QuotaStore(tmp_path / "q.json")
    assert s.consume("acme", limit=2)[0] is True
    assert s.consume("acme", limit=2)[0] is True
    allowed, used, lim, _ = s.consume("acme", limit=2)
    assert allowed is False
    assert used == 2
    assert lim == 2


def test_quota_store_unlimited_when_zero(tmp_path: Path):
    s = QuotaStore(tmp_path / "q.json")
    # limit=0 means no cap; still counts for reporting.
    for _ in range(50):
        assert s.consume("acme", limit=0)[0] is True
    assert s.snapshot("acme")["used"] == 50


def test_response_carries_ratelimit_month_headers(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="3",
    )
    r = c.get("/v1/models", headers={"Authorization": "Bearer sk-acme"})
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Limit-Month"] == "3"
    assert r.headers["X-RateLimit-Remaining-Month"] == "2"
    assert r.headers["X-RateLimit-Period"] == current_period()
    assert int(r.headers["X-RateLimit-Reset-Month"]) > 0


def test_quota_blocks_after_monthly_cap(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="2",
    )
    h = {"Authorization": "Bearer sk-acme"}
    assert c.get("/v1/models", headers=h).status_code == 200
    assert c.get("/v1/models", headers=h).status_code == 200
    r = c.get("/v1/models", headers=h)
    assert r.status_code == 429
    body = r.json()
    assert body["error"]["type"] == "quota_exceeded"
    assert body["error"]["tenant"] == "acme"
    assert body["error"]["limit"] == 2
    # 429 still carries the standard headers so SDKs can show usage.
    assert r.headers["X-RateLimit-Remaining-Month"] == "0"
    assert "Retry-After" in r.headers


def test_quota_isolates_tenants(monkeypatch, tmp_path):
    """Hitting acme's cap must not affect globex."""
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme,sk-globex:models:read+infer@globex",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="1",
    )
    a = {"Authorization": "Bearer sk-acme"}
    g = {"Authorization": "Bearer sk-globex"}
    assert c.get("/v1/models", headers=a).status_code == 200
    assert c.get("/v1/models", headers=a).status_code == 429
    # Globex still has its full quota despite acme being exhausted.
    r = c.get("/v1/models", headers=g)
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Remaining-Month"] == "0"


def test_quota_overrides_per_tenant(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS=(
            "sk-acme:models:read+infer@acme,"
            "sk-big:models:read+infer@bigco"
        ),
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="1",
        CODECLONE_QUOTA_OVERRIDES="bigco=5",
    )
    a = {"Authorization": "Bearer sk-acme"}
    b = {"Authorization": "Bearer sk-big"}
    assert c.get("/v1/models", headers=a).status_code == 200
    assert c.get("/v1/models", headers=a).status_code == 429
    # bigco has an override of 5.
    for _ in range(5):
        assert c.get("/v1/models", headers=b).status_code == 200
    assert c.get("/v1/models", headers=b).status_code == 429


def test_health_endpoints_never_count(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="1",
    )
    for _ in range(10):
        assert c.get("/healthz").status_code == 200
        assert c.get("/readyz").status_code == 200
    # Real call still gets its full quota.
    r = c.get("/v1/models", headers={"Authorization": "Bearer sk-acme"})
    assert r.status_code == 200


def test_quota_endpoint_returns_caller_usage(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="10",
    )
    h = {"Authorization": "Bearer sk-acme"}
    c.get("/v1/models", headers=h)
    c.get("/v1/models", headers=h)
    r = c.get("/v1/quota", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["tenant"] == "acme"
    assert body["used"] == 2
    assert body["limit"] == 10
    assert body["remaining"] == 8
    assert body["period"] == current_period()


def test_quota_endpoint_forbids_cross_tenant_for_non_admin(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS=(
            "sk-acme:models:read+infer@acme,"
            "sk-globex:models:read+infer@globex"
        ),
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="10",
    )
    r = c.get(
        "/v1/quota?tenant=globex",
        headers={"Authorization": "Bearer sk-acme"},
    )
    assert r.status_code == 403


def test_quota_endpoint_allows_admin_cross_tenant(monkeypatch, tmp_path):
    c = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_API_KEYS="sk-acme:models:read+infer@acme,sk-admin:*@ops",
        CODECLONE_QUOTA_PER_TENANT_MONTHLY="10",
    )
    c.get("/v1/models", headers={"Authorization": "Bearer sk-acme"})
    r = c.get(
        "/v1/quota?tenant=acme",
        headers={"Authorization": "Bearer sk-admin"},
    )
    assert r.status_code == 200
    assert r.json()["tenant"] == "acme"
    assert r.json()["used"] == 1
