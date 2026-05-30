"""Tests for the Sentry error tracking integration."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from codeclone_config.settings import Settings
from codeclone_serve import sentry as sentry_mod


@pytest.fixture(autouse=True)
def _reset_sentry_state():
    sentry_mod._reset_for_tests()
    yield
    sentry_mod._reset_for_tests()


def _settings(**overrides) -> Settings:
    base = {
        "SENTRY_DSN": None,
        "SENTRY_ENVIRONMENT": "test",
        "SENTRY_TRACES_SAMPLE_RATE": 0.0,
    }
    base.update(overrides)
    # Settings reads from kwargs via aliases.
    return Settings(**{k: v for k, v in base.items() if v is not None})


def test_init_noop_when_dsn_missing():
    s = _settings()
    assert sentry_mod.init_sentry(s) is False
    assert sentry_mod.is_initialized() is False


def test_init_calls_sdk_when_dsn_present():
    s = _settings(SENTRY_DSN="https://public@o0.ingest.sentry.io/0")
    with patch("sentry_sdk.init") as mock_init, patch("sentry_sdk.set_tag"):
        ok = sentry_mod.init_sentry(s)
    assert ok is True
    assert sentry_mod.is_initialized() is True
    assert mock_init.called
    kwargs = mock_init.call_args.kwargs
    assert kwargs["dsn"] == "https://public@o0.ingest.sentry.io/0"
    assert kwargs["environment"] == "test"
    assert kwargs["traces_sample_rate"] == 0.0
    assert callable(kwargs["before_send"])


def test_init_is_idempotent():
    s = _settings(SENTRY_DSN="https://public@o0.ingest.sentry.io/0")
    with patch("sentry_sdk.init") as mock_init, patch("sentry_sdk.set_tag"):
        sentry_mod.init_sentry(s)
        sentry_mod.init_sentry(s)
    assert mock_init.call_count == 1


def test_before_send_redacts_auth_dict():
    event = {
        "request": {
            "headers": {
                "Authorization": "Bearer sk-secret",
                "User-Agent": "pytest",
            }
        }
    }
    out = sentry_mod._scrub_event(event, {})
    assert out is not None
    assert out["request"]["headers"]["Authorization"] == "[redacted]"
    assert out["request"]["headers"]["User-Agent"] == "pytest"


def test_before_send_redacts_auth_list():
    event = {
        "request": {
            "headers": [
                ["Authorization", "Bearer sk-secret"],
                ["X-Api-Key", "another-secret"],
                ["Accept", "application/json"],
            ]
        }
    }
    out = sentry_mod._scrub_event(event, {})
    assert out is not None
    headers = out["request"]["headers"]
    assert headers[0] == ["Authorization", "[redacted]"]
    assert headers[1] == ["X-Api-Key", "[redacted]"]
    assert headers[2] == ["Accept", "application/json"]


def test_init_rejects_invalid_sample_rate():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        _settings(SENTRY_TRACES_SAMPLE_RATE=2.5)


def test_init_returns_false_when_sdk_missing(monkeypatch):
    s = _settings(SENTRY_DSN="https://public@o0.ingest.sentry.io/0")
    # Force the import inside init_sentry to fail.
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("sentry_sdk"):
            raise ImportError("simulated missing dep")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    assert sentry_mod.init_sentry(s) is False
    assert sentry_mod.is_initialized() is False


def test_healthz_reports_sentry_flag():
    # When no DSN is configured, /healthz reports sentry=false.
    from codeclone_serve.app import create_app
    from fastapi.testclient import TestClient

    app = create_app(model_dir=None, model_name="codeclone-test")
    client = TestClient(app)
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["sentry"] is False
