"""Structured logging helpers shared across services."""

from __future__ import annotations

import logging
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog


def _add_otel_trace_context(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Inject trace_id/span_id from the active OTel span into every log event.

    No-op when opentelemetry is not installed or no valid span is active. Runs
    at log emit time so it always reflects the *current* span, not the one
    that happened to be active when contextvars were bound.
    """
    if "trace_id" in event_dict and "span_id" in event_dict:
        return event_dict
    try:
        from opentelemetry import trace
    except Exception:
        return event_dict
    span = trace.get_current_span()
    if span is None:
        return event_dict
    ctx = span.get_span_context()
    if not getattr(ctx, "is_valid", False):
        return event_dict
    event_dict.setdefault("trace_id", f"{ctx.trace_id:032x}")
    event_dict.setdefault("span_id", f"{ctx.span_id:016x}")
    return event_dict


def configure_logging(level: str = "INFO", json_logs: bool = True) -> None:
    """Configure structlog + stdlib logging consistently across services."""
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=log_level,
    )

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        _add_otel_trace_context,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    if json_logs:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> Any:
    return structlog.get_logger(name)
