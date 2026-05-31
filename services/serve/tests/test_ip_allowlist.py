"""Tests for the per-tenant IP allowlist middleware.

These exercise both the pure parser and the wired-up FastAPI app to prove
cross-tenant isolation: a request authenticated as ``acme`` from an IP
outside the ``acme`` policy is rejected with HTTP 403, while a request from
an allowed IP succeeds, and tenants with no policy are not affected.

The serve API uses ``TestClient`` whose synthetic client address is
``127.0.0.1``. To simulate different source IPs without standing up a real
network, we enable ``CODECLONE_RATELIMIT_TRUST_FORWARDED=true`` and set the
``X-Forwarded-For`` header; the allowlist middleware reuses the same
forwarded-header logic as the rate limiter so the policies are consistent
across both layers.
"""

from __future__ import annotations

import pytest
from codeclone_serve.app import create_app
from codeclone_serve.ip_allowlist import TenantPolicy, parse_policy
from fastapi.testclient import TestClient


def _client(monkeypatch, **env: str) -> TestClient:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    return TestClient(app=create_app(model_dir=None, model_name="codeclone-test"))


# ---------------------------------------------------------------- parser ----


def test_parse_policy_empty_returns_empty_mapping():
    assert parse_policy("") == {}
    assert parse_policy("   ") == {}


def test_parse_policy_accepts_multiple_cidrs():
    policy = parse_policy("acme=10.0.0.0/8+192.0.2.5/32")
    assert set(policy) == {"acme"}
    p = policy["acme"]
    assert p.allow_any is False
    assert p.permits("10.1.2.3") is True
    assert p.permits("192.0.2.5") is True
    assert p.permits("203.0.113.1") is False


def test_parse_policy_wildcard_means_allow_any():
    policy = parse_policy("beta=*")
    p = policy["beta"]
    assert p.allow_any is True
    assert p.permits("203.0.113.1") is True
    # Even an unparseable client address is permitted under wildcard, since
    # the explicit operator intent is "any source".
    assert p.permits("unknown") is True


def test_parse_policy_rejects_wildcard_mixed_with_cidrs():
    with pytest.raises(ValueError, match="wildcard"):
        parse_policy("acme=10.0.0.0/8+*")


def test_parse_policy_rejects_missing_equals():
    with pytest.raises(ValueError, match="missing '='"):
        parse_policy("acme")


def test_parse_policy_rejects_bad_cidr():
    with pytest.raises(ValueError, match="invalid CIDR"):
        parse_policy("acme=not-a-cidr")


def test_policy_denies_unparseable_ip_under_non_wildcard():
    p = TenantPolicy(
        tenant="acme",
        networks=(__import__("ipaddress").ip_network("10.0.0.0/8"),),
    )
    assert p.permits("unknown") is False


def test_parse_policy_supports_ipv6():
    policy = parse_policy("acme=2001:db8::/32")
    p = policy["acme"]
    assert p.permits("2001:db8::1") is True
    assert p.permits("2001:db9::1") is False


# ---------------------------------------------------------- wired into app ----


def _base_env() -> dict:
    """Disable rate limiting so tests do not flake under repeated calls.

    The allowlist is independent of the rate limiter; turning the limiter
    off keeps these tests focused on the policy under test.
    """
    return {
        "CODECLONE_RATELIMIT_ENABLED": "false",
        "CODECLONE_AUDIT_LOG_ENABLED": "false",
        "CODECLONE_RATELIMIT_TRUST_FORWARDED": "true",
        # Two tenants: ``acme`` is restricted to 10.0.0.0/8, ``open`` has
        # no policy at all, ``wild`` is explicitly any-source.
        "CODECLONE_API_KEYS": "sk-acme:models:read@acme,sk-open:models:read@open,sk-wild:models:read@wild",
        "CODECLONE_IP_ALLOWLIST": "acme=10.0.0.0/8,wild=*",
    }


def test_blocks_request_from_disallowed_ip_for_restricted_tenant(monkeypatch):
    client = _client(monkeypatch, **_base_env())
    resp = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-acme",
            "X-Forwarded-For": "203.0.113.7",
        },
    )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["error"]["type"] == "ip_not_allowed"
    assert body["error"]["tenant"] == "acme"
    assert body["error"]["source_ip"] == "203.0.113.7"


def test_allows_request_from_allowed_ip_for_restricted_tenant(monkeypatch):
    client = _client(monkeypatch, **_base_env())
    resp = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-acme",
            "X-Forwarded-For": "10.1.2.3",
        },
    )
    assert resp.status_code == 200, resp.text


def test_unrestricted_tenant_is_not_affected(monkeypatch):
    client = _client(monkeypatch, **_base_env())
    # ``open`` has no entry in the allowlist, so any source is fine.
    resp = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-open",
            "X-Forwarded-For": "203.0.113.7",
        },
    )
    assert resp.status_code == 200, resp.text


def test_cross_tenant_policy_does_not_leak(monkeypatch):
    """An allowed IP for tenant A must not bypass tenant B's policy.

    This is the core multi-tenancy guarantee: the policy is evaluated
    against the tenant of the authenticated principal, never the tenant
    the caller claims, and never some cached "last seen" IP.
    """
    client = _client(monkeypatch, **_base_env())
    # 10.1.2.3 is fine for ``acme``, but ``wild`` is wildcard so any IP is
    # fine; conversely, switching back to ``acme`` from a public IP must
    # still be rejected even after a successful ``wild`` call from that IP.
    ok = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-wild",
            "X-Forwarded-For": "203.0.113.7",
        },
    )
    assert ok.status_code == 200
    blocked = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-acme",
            "X-Forwarded-For": "203.0.113.7",
        },
    )
    assert blocked.status_code == 403
    assert blocked.json()["error"]["tenant"] == "acme"


def test_wildcard_tenant_accepts_any_source(monkeypatch):
    client = _client(monkeypatch, **_base_env())
    resp = client.get(
        "/v1/models",
        headers={
            "Authorization": "Bearer sk-wild",
            "X-Forwarded-For": "198.51.100.42",
        },
    )
    assert resp.status_code == 200


def test_health_endpoints_are_never_gated(monkeypatch):
    """Health and metrics must never be blocked, even from a public IP.

    The contract is that kubelet probes and the Prometheus scraper share
    the pod network with the application, and an operator misconfiguring
    the allowlist must not take the pod out of rotation.
    """
    client = _client(monkeypatch, **_base_env())
    for path in ("/healthz", "/readyz", "/metrics"):
        resp = client.get(path, headers={"X-Forwarded-For": "203.0.113.99"})
        assert resp.status_code in (200, 503), (path, resp.text)


def test_anonymous_request_is_not_gated_by_allowlist(monkeypatch):
    """No Authorization header means no tenant, which means no policy applies.

    The route's own auth dependency will still reject the call with 401,
    but the rejection must come from the auth layer (so the response is
    the standard auth error) rather than from the allowlist (which would
    expose tenant policy details to anonymous callers).
    """
    client = _client(monkeypatch, **_base_env())
    resp = client.get("/v1/models", headers={"X-Forwarded-For": "203.0.113.7"})
    assert resp.status_code == 401
