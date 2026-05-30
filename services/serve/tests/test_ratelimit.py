"""Tests for the per-IP and per-API-key rate limit middleware."""

from __future__ import annotations

from codeclone_serve.app import create_app
from codeclone_serve.ratelimit import TokenBucketLimiter
from fastapi.testclient import TestClient


def _client(monkeypatch, **env: str) -> TestClient:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return TestClient(app=create_app(model_dir=None, model_name="codeclone-test"))


def _h() -> dict:
    return {"Authorization": "Bearer sk-test-key"}


def test_token_bucket_allows_burst_then_blocks():
    b = TokenBucketLimiter(rate_per_minute=60, burst=3)
    t = 1_000.0
    # Three calls within the same instant: all allowed.
    assert b.check("x", now=t)[0] is True
    assert b.check("x", now=t)[0] is True
    assert b.check("x", now=t)[0] is True
    # Fourth at the same instant should be blocked with a positive retry.
    ok, retry = b.check("x", now=t)
    assert ok is False
    assert retry > 0
    # After enough time to refill one token, it allows again.
    ok2, _ = b.check("x", now=t + retry + 0.01)
    assert ok2 is True


def test_token_bucket_isolates_identities():
    b = TokenBucketLimiter(rate_per_minute=60, burst=1)
    t = 1_000.0
    assert b.check("a", now=t)[0] is True
    # Different identity has its own bucket.
    assert b.check("b", now=t)[0] is True
    # And the original is now empty.
    assert b.check("a", now=t)[0] is False


def test_health_endpoints_are_never_rate_limited(monkeypatch):
    c = _client(
        monkeypatch,
        CODECLONE_RATELIMIT_PER_IP_RPM="1",
        CODECLONE_RATELIMIT_PER_KEY_RPM="1",
        CODECLONE_RATELIMIT_BURST="1",
    )
    for _ in range(5):
        r = c.get("/healthz")
        assert r.status_code == 200
        r = c.get("/readyz")
        assert r.status_code == 200
        r = c.get("/metrics")
        assert r.status_code == 200


def test_per_ip_rate_limit_returns_429(monkeypatch):
    c = _client(
        monkeypatch,
        CODECLONE_RATELIMIT_PER_IP_RPM="60",
        CODECLONE_RATELIMIT_PER_KEY_RPM="100000",
        CODECLONE_RATELIMIT_BURST="2",
    )
    r1 = c.get("/v1/models", headers=_h())
    r2 = c.get("/v1/models", headers=_h())
    r3 = c.get("/v1/models", headers=_h())
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    body = r3.json()
    assert body["error"]["type"] == "rate_limit_exceeded"
    # Per-IP bucket is the tighter one in this config.
    assert body["error"]["scope"] == "ip"
    assert "Retry-After" in r3.headers
    assert int(r3.headers["Retry-After"]) >= 1


def test_per_key_rate_limit_returns_429(monkeypatch):
    # Loose per-IP, tight per-key, so the key bucket trips first.
    c = _client(
        monkeypatch,
        CODECLONE_RATELIMIT_PER_IP_RPM="100000",
        CODECLONE_RATELIMIT_PER_KEY_RPM="60",
        CODECLONE_RATELIMIT_BURST="2",
    )
    assert c.get("/v1/models", headers=_h()).status_code == 200
    assert c.get("/v1/models", headers=_h()).status_code == 200
    r = c.get("/v1/models", headers=_h())
    assert r.status_code == 429
    assert r.json()["error"]["scope"] == "api_key"


def test_rate_limit_can_be_disabled(monkeypatch):
    c = _client(
        monkeypatch,
        CODECLONE_RATELIMIT_ENABLED="false",
        CODECLONE_RATELIMIT_PER_IP_RPM="1",
        CODECLONE_RATELIMIT_PER_KEY_RPM="1",
        CODECLONE_RATELIMIT_BURST="1",
    )
    for _ in range(5):
        r = c.get("/v1/models", headers=_h())
        assert r.status_code == 200
