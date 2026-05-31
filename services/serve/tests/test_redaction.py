"""Tests for inbound PII / secret redaction on the inference surface.

These tests cover the three policy modes and the audit-emit side-effect.
They lean on the existing :class:`MockHandle` so they don't need a real
model on disk.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from codeclone_config.settings import reset_settings_cache
from codeclone_serve.app import create_app
from codeclone_serve.redaction import (
    RedactionPolicy,
    enforce,
    parse_overrides,
    policy_from_env,
    redact,
)
from fastapi.testclient import TestClient


# ---- unit: detectors --------------------------------------------------------


def test_redact_rewrites_aws_access_key():
    out = redact("aws_key=AKIAIOSFODNN7EXAMPLE rest")
    assert "AKIA" not in out.text
    assert "[REDACTED_AWS_ACCESS_KEY_ID]" in out.text
    assert out.summary() == {"aws_access_key_id": 1}


def test_redact_rewrites_github_token_and_email():
    raw = "contact alice@example.com token ghp_" + "a" * 36
    out = redact(raw)
    cats = out.summary()
    assert cats.get("github_token") == 1
    assert cats.get("email") == 1
    assert "alice@example.com" not in out.text
    assert "ghp_" not in out.text


def test_redact_handles_private_key_block():
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIBowIBAAKBgQ==\n"
        "-----END RSA PRIVATE KEY-----"
    )
    out = redact(f"before\n{pem}\nafter")
    assert "[REDACTED_PRIVATE_KEY]" in out.text
    assert "BEGIN RSA PRIVATE KEY" not in out.text
    assert out.summary() == {"private_key": 1}


def test_redact_is_noop_on_clean_code():
    src = "def add(a, b):\n    return a + b\n"
    out = redact(src)
    assert out.text == src
    assert out.findings == []


def test_redact_ignores_unspecified_ipv4():
    # 0.0.0.0 is a common literal in source ("--host 0.0.0.0"); skipped on
    # purpose so it does not generate noise.
    out = redact("server.listen('0.0.0.0', 8080)")
    assert out.summary().get("ipv4") in (None, 0)


def test_redact_catches_real_ipv4():
    out = redact("client connected from 10.0.0.42")
    assert out.summary().get("ipv4") == 1
    assert "10.0.0.42" not in out.text


# ---- unit: policy parsing ---------------------------------------------------


def test_parse_overrides_happy_path():
    assert parse_overrides("acme=block,beta=redact") == {
        "acme": "block",
        "beta": "redact",
    }


def test_parse_overrides_rejects_bad_mode():
    with pytest.raises(ValueError):
        parse_overrides("acme=loud")


def test_parse_overrides_rejects_missing_equals():
    with pytest.raises(ValueError):
        parse_overrides("acme")


def test_policy_from_env_reads_default_and_overrides(monkeypatch):
    monkeypatch.setenv("CODECLONE_REDACT_POLICY", "redact")
    monkeypatch.setenv("CODECLONE_REDACT_OVERRIDES", "acme=block")
    p = policy_from_env()
    assert p.default_mode == "redact"
    assert p.mode_for("acme") == "block"
    assert p.mode_for("beta") == "redact"
    assert p.enabled is True


def test_policy_disabled_when_all_off():
    p = RedactionPolicy(default_mode="off", overrides={"acme": "off"})
    assert p.enabled is False


def test_enforce_off_is_passthrough():
    out = enforce(["token=ghp_" + "a" * 36], "off")
    assert out.blocked is False
    assert out.rewritten == ["token=ghp_" + "a" * 36]
    assert out.summary == {}


def test_enforce_block_flags_blocked():
    out = enforce(["AKIAIOSFODNN7EXAMPLE"], "block")
    assert out.blocked is True
    assert out.summary == {"aws_access_key_id": 1}


# ---- integration: HTTP surface ---------------------------------------------


def _setup_env(monkeypatch, tmp_path: Path, **overrides: str) -> Path:
    audit_path = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-test")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(audit_path))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "0")
    # Disable noisy middleware that other tests cover separately.
    monkeypatch.setenv("CODECLONE_RATELIMIT_ENABLED", "false")
    monkeypatch.setenv("CODECLONE_QUOTA_ENABLED", "false")
    for k, v in overrides.items():
        monkeypatch.setenv(k, v)
    reset_settings_cache()
    return audit_path


def _client(monkeypatch, tmp_path: Path, **overrides: str) -> tuple[TestClient, Path]:
    audit_path = _setup_env(monkeypatch, tmp_path, **overrides)
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app), audit_path


def test_redact_mode_rewrites_request_and_sets_header(monkeypatch, tmp_path):
    client, audit_path = _client(
        monkeypatch, tmp_path, CODECLONE_REDACT_POLICY="redact"
    )
    body = {
        "model": "codeclone-test",
        "messages": [
            {
                "role": "user",
                "content": "please review aws_key=AKIAIOSFODNN7EXAMPLE alice@example.com",
            }
        ],
    }
    r = client.post(
        "/v1/chat/completions",
        json=body,
        headers={"Authorization": "Bearer sk-test"},
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("X-Codeclone-Redactions") == "2"
    cats = r.headers.get("X-Codeclone-Redaction-Categories", "")
    assert "aws_access_key_id=1" in cats
    assert "email=1" in cats
    # Audit log should carry a redaction.scan event.
    lines = [json.loads(l) for l in audit_path.read_text().splitlines() if l.strip()]
    scans = [l for l in lines if l.get("event") == "redaction.scan"]
    assert scans, lines
    assert scans[-1]["mode"] == "redact"
    assert scans[-1]["blocked"] is False
    assert scans[-1]["findings"]["aws_access_key_id"] == 1


def test_block_mode_returns_422_with_structured_error(monkeypatch, tmp_path):
    client, audit_path = _client(
        monkeypatch, tmp_path, CODECLONE_REDACT_POLICY="block"
    )
    r = client.post(
        "/v1/completions",
        json={
            "model": "codeclone-test",
            "prompt": "ssh key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBowIBAAKBgQ==\n-----END RSA PRIVATE KEY-----",
            "max_tokens": 4,
        },
        headers={"Authorization": "Bearer sk-test"},
    )
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["error"]["type"] == "redaction_blocked"
    assert body["error"]["findings"]["private_key"] == 1
    assert r.headers.get("X-Codeclone-Redactions") == "1"
    scans = [
        json.loads(l)
        for l in audit_path.read_text().splitlines()
        if l.strip() and json.loads(l).get("event") == "redaction.scan"
    ]
    assert scans and scans[-1]["blocked"] is True


def test_off_mode_is_passthrough_no_header(monkeypatch, tmp_path):
    client, audit_path = _client(monkeypatch, tmp_path)  # default off
    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "codeclone-test",
            "messages": [
                {"role": "user", "content": "AKIAIOSFODNN7EXAMPLE alice@example.com"}
            ],
        },
        headers={"Authorization": "Bearer sk-test"},
    )
    assert r.status_code == 200
    assert "X-Codeclone-Redactions" not in r.headers
    # No redaction.scan event written.
    lines = [json.loads(l) for l in audit_path.read_text().splitlines() if l.strip()]
    assert not any(l.get("event") == "redaction.scan" for l in lines)


def test_tenant_override_isolates_policy(monkeypatch, tmp_path):
    # acme = block, beta = off (default). Same secret, different outcomes.
    monkeypatch.setenv(
        "CODECLONE_API_KEYS",
        "sk-acme:infer@acme,sk-beta:infer@beta",
    )
    client, _ = _client(
        monkeypatch,
        tmp_path,
        CODECLONE_REDACT_OVERRIDES="acme=block",
    )
    body = {
        "model": "codeclone-test",
        "prompt": "AKIAIOSFODNN7EXAMPLE",
        "max_tokens": 4,
    }
    r_acme = client.post(
        "/v1/completions", json=body, headers={"Authorization": "Bearer sk-acme"}
    )
    r_beta = client.post(
        "/v1/completions", json=body, headers={"Authorization": "Bearer sk-beta"}
    )
    assert r_acme.status_code == 422, r_acme.text
    assert r_beta.status_code == 200, r_beta.text
