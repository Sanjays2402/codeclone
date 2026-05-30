"""Tests for the configurable CORS middleware on the serve API.

The default posture is locked down: with no ``CODECLONE_CORS_ALLOW_ORIGINS``
env var set the middleware is not installed at all, so cross-origin browser
preflights do not get an ``Access-Control-Allow-Origin`` echo. When an origin
allow-list is supplied only those exact origins should be honored, and a
wildcard ``*`` must force credentials off because browsers reject the
``Access-Control-Allow-Credentials: true`` + ``*`` combination.
"""

from __future__ import annotations

import pytest
from codeclone_config.settings import reset_settings_cache
from codeclone_serve.app import create_app
from fastapi.testclient import TestClient


def _client() -> TestClient:
    reset_settings_cache()
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


def _preflight(c: TestClient, origin: str, path: str = "/v1/models") -> object:
    return c.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )


def test_cors_disabled_by_default_blocks_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    # No CODECLONE_CORS_ALLOW_ORIGINS -> middleware is not installed.
    monkeypatch.delenv("CODECLONE_CORS_ALLOW_ORIGINS", raising=False)
    c = _client()
    r = _preflight(c, "https://evil.example.com")
    # FastAPI/Starlette returns 405 for OPTIONS on a GET-only route when the
    # CORS middleware is absent; the key signal is the missing CORS header.
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_cors_allowlisted_origin_is_echoed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "CODECLONE_CORS_ALLOW_ORIGINS",
        "https://app.example.com,https://admin.example.com",
    )
    monkeypatch.setenv("CODECLONE_CORS_ALLOW_CREDENTIALS", "true")
    c = _client()

    r = _preflight(c, "https://app.example.com")
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://app.example.com"
    assert r.headers.get("access-control-allow-credentials") == "true"


def test_cors_unlisted_origin_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "CODECLONE_CORS_ALLOW_ORIGINS", "https://app.example.com"
    )
    c = _client()

    r = _preflight(c, "https://evil.example.com")
    # Starlette's CORSMiddleware returns 400 on a disallowed preflight and
    # never emits an Allow-Origin header for it.
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_cors_wildcard_forces_credentials_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODECLONE_CORS_ALLOW_ORIGINS", "*")
    monkeypatch.setenv("CODECLONE_CORS_ALLOW_CREDENTIALS", "true")
    c = _client()

    r = _preflight(c, "https://anywhere.example.com")
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
    # Browsers refuse credentials against `*`; the app must not advertise them.
    assert r.headers.get("access-control-allow-credentials") != "true"


def test_cors_rejects_malformed_origin_at_settings_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CODECLONE_CORS_ALLOW_ORIGINS", "not-a-url")
    reset_settings_cache()
    from codeclone_config.settings import Settings

    with pytest.raises(Exception):  # noqa: B017
        Settings()
