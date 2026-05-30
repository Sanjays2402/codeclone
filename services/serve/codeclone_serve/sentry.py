"""Sentry error tracking integration for the serve API.

Initialized once per process at FastAPI app construction. No-op when
``SENTRY_DSN`` is unset so local development and CI stay quiet.

The Sentry SDK is an optional runtime dependency: if it is not installed
we log a warning and continue, rather than crash the serve process.
"""

from __future__ import annotations

from typing import Any

from codeclone_config.logging import get_logger
from codeclone_config.settings import Settings

log = get_logger(__name__)

# Module-level flag so tests and /healthz consumers can confirm wiring.
_INITIALIZED: bool = False


def is_initialized() -> bool:
    """Whether Sentry was initialized in this process."""
    return _INITIALIZED


def _reset_for_tests() -> None:
    """Test hook only. Lets tests re-exercise the init path."""
    global _INITIALIZED
    _INITIALIZED = False


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any] | None:
    """Strip the bearer API key out of any request headers Sentry captures."""
    try:
        request = event.get("request") or {}
        headers = request.get("headers")
        if isinstance(headers, dict):
            for k in list(headers.keys()):
                if k.lower() in ("authorization", "x-api-key", "cookie"):
                    headers[k] = "[redacted]"
        elif isinstance(headers, list):
            for i, pair in enumerate(headers):
                if (
                    isinstance(pair, (list, tuple))
                    and len(pair) == 2
                    and isinstance(pair[0], str)
                    and pair[0].lower() in ("authorization", "x-api-key", "cookie")
                ):
                    headers[i] = [pair[0], "[redacted]"]
    except Exception:  # pragma: no cover - defensive
        return event
    return event


def init_sentry(settings: Settings) -> bool:
    """Initialize the Sentry SDK from settings. Idempotent.

    Returns True when Sentry is now active in this process, False otherwise
    (no DSN configured, SDK not installed, or init failed).
    """
    global _INITIALIZED
    if _INITIALIZED:
        return True

    dsn = settings.sentry_dsn
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except Exception as e:  # pragma: no cover - optional dep
        log.warning("sentry.sdk_missing", error=str(e))
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=settings.sentry_environment,
            release=settings.sentry_release,
            traces_sample_rate=settings.sentry_traces_sample_rate,
            send_default_pii=settings.sentry_send_default_pii,
            integrations=[
                StarletteIntegration(transaction_style="endpoint"),
                FastApiIntegration(transaction_style="endpoint"),
            ],
            before_send=_scrub_event,
        )
        sentry_sdk.set_tag("service", settings.otel_service)
    except Exception as e:  # pragma: no cover - defensive
        log.warning("sentry.init_failed", error=str(e))
        return False

    _INITIALIZED = True
    log.info(
        "sentry.initialized",
        environment=settings.sentry_environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        release=settings.sentry_release,
    )
    return True
