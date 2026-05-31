"""FastAPI app factory + routes."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from codeclone_config.logging import configure_logging, get_logger
from codeclone_config.settings import get_settings
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Histogram,
    generate_latest,
)
from sse_starlette.sse import EventSourceResponse

from .audit import AuditMiddleware, build_sink_from_env
from .auth import (
    require_scope,
    verify_api_key,  # noqa: F401  (re-exported for back-compat)
)
from .data_lifecycle import register as register_data_lifecycle
from .ip_allowlist import IpAllowlistMiddleware, parse_policy
from .model_handle import ModelHandle, load_handle
from .quota import QuotaMiddleware, QuotaStore, parse_overrides
from .ratelimit import RateLimitMiddleware, TokenBucketLimiter
from .readiness import ReadinessProbe
from .request_id import RequestIdMiddleware
from .schemas import (
    ChatCompletionChoice,
    ChatCompletionDelta,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionStreamChoice,
    ChatCompletionStreamChunk,
    ChatMessage,
    CompletionChoice,
    CompletionRequest,
    CompletionResponse,
    ModelCard,
    ModelList,
    Usage,
)
from .sentry import init_sentry
from .sentry import is_initialized as sentry_initialized
from .tracing import init_tracing
from .tracing import is_initialized as tracing_initialized

log = get_logger(__name__)


# Prometheus metrics (module-level singletons; safe under reload in tests).
REQ_COUNTER = Counter(
    "codeclone_requests_total",
    "Total requests served, by route and status",
    labelnames=("route", "status"),
)
LATENCY = Histogram(
    "codeclone_request_seconds",
    "Latency per route",
    labelnames=("route",),
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)


def _render_messages(messages: list[ChatMessage]) -> str:
    """Render a chat messages list into a single prompt the handle can consume."""
    out = []
    for m in messages:
        if m.role == "system":
            out.append(f"### system\n{m.content}")
        elif m.role == "user":
            out.append(f"### user\n{m.content}")
        elif m.role == "assistant":
            out.append(f"### assistant\n{m.content}")
        elif m.role == "tool":
            out.append(f"### tool\n{m.content}")
    out.append("### assistant\n")
    return "\n".join(out)


def create_app(model_dir: str | Path | None = None, model_name: str | None = None) -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    # Initialize Sentry first so it can capture handle-load failures too.
    init_sentry(settings)

    handle: ModelHandle = load_handle(model_dir, backend=settings.resolve_backend())
    if model_name:
        handle.name = model_name  # type: ignore[attr-defined]

    app = FastAPI(
        title="CodeClone",
        version="0.1.0",
        description="OpenAI-compatible API for a personally fine-tuned code model.",
    )
    # CORS is locked down by default. Set CODECLONE_CORS_ALLOW_ORIGINS to a
    # CSV of trusted origins (or `*` for a wildcard, which forces credentials
    # off per the CORS spec) to enable cross-origin browser callers. When the
    # list is empty the middleware is not installed at all, so the API simply
    # refuses cross-origin preflights.
    cors_origins = settings.cors_origins_list()
    if cors_origins:
        allow_credentials = settings.cors_allow_credentials
        if "*" in cors_origins and allow_credentials:
            # Browsers refuse credentials against a wildcard origin; force the
            # safer combination instead of silently misconfiguring the pod.
            log.warning(
                "cors.wildcard_with_credentials_disabled",
                reason="browsers reject Access-Control-Allow-Credentials with '*'",
            )
            allow_credentials = False
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=allow_credentials,
            allow_methods=settings.cors_methods_list(),
            allow_headers=settings.cors_headers_list(),
            max_age=settings.cors_max_age,
        )
        log.info(
            "cors.enabled",
            origins=cors_origins,
            credentials=allow_credentials,
            methods=settings.cors_methods_list(),
        )
    else:
        log.info("cors.disabled", reason="CODECLONE_CORS_ALLOW_ORIGINS is empty")

    # ---- Audit log (who/what/when, persisted JSONL) ----
    if settings.audit_log_enabled:
        sink = build_sink_from_env(settings.audit_log_path)
        app.state.audit_sink = sink
        app.add_middleware(
            AuditMiddleware,
            sink=sink,
            trust_forwarded=settings.ratelimit_trust_forwarded,
        )

        @app.on_event("shutdown")
        def _close_audit_sink() -> None:
            sink.close()

    # ---- Rate limiting (per IP and per API key, token bucket) ----
    # ---- Per-tenant IP allowlist ----
    # Enterprise customers commonly require that API credentials only work
    # from a fixed set of egress IPs. The allowlist is opt-in per tenant:
    # tenants with no entry are unrestricted, so existing deployments are
    # unaffected. Added BEFORE the rate limit middleware so that, given the
    # last-added-runs-first wrapping order, the rate limiter still evaluates
    # first (cheap brute-force defence) and only legitimate, throttled
    # traffic reaches the CIDR check.
    if settings.ip_allowlist_enabled:
        policy = parse_policy(settings.ip_allowlist)
        if policy:
            app.state.ip_allowlist_policy = policy
            app.add_middleware(
                IpAllowlistMiddleware,
                policy=policy,
                trust_forwarded=settings.ratelimit_trust_forwarded,
            )
            log.info(
                "ip_allowlist.enabled",
                tenants=sorted(policy.keys()),
            )
        else:
            log.info("ip_allowlist.disabled", reason="no tenant policies configured")

    # ---- Per-tenant monthly request quotas ----
    # Sits inside the per-minute rate limiter (added later, runs earlier in
    # Starlette's last-in-first-out wrapping order) so flood traffic is
    # rejected by the cheap token bucket before the persistent quota
    # counter touches disk. Default of 0 is unlimited so existing
    # deployments are unaffected.
    if settings.quota_enabled and (
        settings.quota_per_tenant_monthly > 0
        or settings.quota_overrides.strip()
    ):
        try:
            overrides = parse_overrides(settings.quota_overrides)
        except ValueError as exc:
            log.error("quota.invalid_overrides", error=str(exc))
            raise
        store = QuotaStore(Path(settings.quota_state_path))
        app.state.quota_store = store
        app.state.quota_default_limit = settings.quota_per_tenant_monthly
        app.state.quota_overrides = overrides
        app.add_middleware(
            QuotaMiddleware,
            store=store,
            default_limit=settings.quota_per_tenant_monthly,
            overrides=overrides,
        )
        log.info(
            "quota.enabled",
            default_monthly=settings.quota_per_tenant_monthly,
            overrides=overrides,
            state_path=str(settings.quota_state_path),
        )

    if settings.ratelimit_enabled:
        app.add_middleware(
            RateLimitMiddleware,
            per_ip=TokenBucketLimiter(
                rate_per_minute=settings.ratelimit_per_ip_rpm,
                burst=settings.ratelimit_burst,
            ),
            per_key=TokenBucketLimiter(
                rate_per_minute=settings.ratelimit_per_key_rpm,
                burst=settings.ratelimit_burst,
            ),
            per_tenant=TokenBucketLimiter(
                rate_per_minute=settings.ratelimit_per_tenant_rpm,
                burst=settings.ratelimit_burst,
            ),
            trust_forwarded=settings.ratelimit_trust_forwarded,
        )



    # ---- Observability: OpenTelemetry distributed tracing ----
    # No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset. When set, this installs
    # a TracerProvider, instruments FastAPI, and lets the request-id middleware
    # below bind trace_id/span_id into structlog so every log line correlates.
    init_tracing(settings, app)

    # ---- Request ID must be added LAST so it wraps every other middleware
    # and every downstream layer (audit, rate limit, OTel, route handlers,
    # structlog) sees the same id. ----
    app.add_middleware(RequestIdMiddleware)

    # ---- middleware: per-request latency ----
    @app.middleware("http")
    async def _latency_mw(request: Request, call_next):
        t0 = time.perf_counter()
        resp = await call_next(request)
        dt = time.perf_counter() - t0
        route = request.url.path
        LATENCY.labels(route=route).observe(dt)
        REQ_COUNTER.labels(route=route, status=str(resp.status_code)).inc()
        return resp

    # ---------------- ops endpoints ----------------

    # Liveness is intentionally cheap and decoupled from the model: a model
    # load failure must not trigger a kubelet restart loop. Readiness owns
    # the "is this pod fit to receive traffic" decision.
    def _handle_probe() -> None:
        # Exercises tokenizer plumbing without invoking generate(); cheap.
        handle.token_count("ready")

    readiness = ReadinessProbe(_handle_probe)
    app.state.readiness = readiness

    @app.on_event("shutdown")
    def _drain_readiness() -> None:
        readiness.begin_shutdown()

    def _health_payload() -> dict:
        return {
            "status": "ok",
            "model": handle.name,
            "sentry": sentry_initialized(),
            "tracing": tracing_initialized(),
            "shutting_down": readiness.is_shutting_down(),
        }

    @app.get("/healthz")
    def healthz() -> dict:
        return _health_payload()

    @app.get("/health")
    def health() -> dict:
        return _health_payload()

    def _ready_response() -> JSONResponse:
        result = readiness.check()
        body = {
            "status": "ready" if result.ok else "not_ready",
            "model": handle.name,
            "reason": result.reason,
            **result.details,
        }
        return JSONResponse(status_code=200 if result.ok else 503, content=body)

    @app.get("/readyz")
    def readyz() -> JSONResponse:
        return _ready_response()

    @app.get("/ready")
    def ready() -> JSONResponse:
        return _ready_response()

    @app.get("/metrics")
    def metrics() -> JSONResponse:
        from fastapi import Response

        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    # ---- GDPR data lifecycle (export-my-data, delete-my-data) ----
    # Lets an API key holder exercise GDPR Art. 15/17/20 over the audit log,
    # which is the only persisted caller-derived data this service keeps.
    register_data_lifecycle(app)

    # ---------------- /v1/quota ----------------
    # Returns the caller's current monthly request usage. Admin scope can
    # introspect any tenant via ``?tenant=...``; non-admin callers can only
    # see their own tenant, which prevents cross-tenant disclosure.
    from .auth import verify_api_key

    @app.get("/v1/quota")
    def quota_status(
        request: Request,
        tenant: str | None = None,
        principal=Depends(verify_api_key),
    ):
        store = getattr(app.state, "quota_store", None)
        if store is None:
            return JSONResponse(
                status_code=200,
                content={"enabled": False, "tenant": principal.tenant},
            )
        target = principal.tenant
        if tenant and tenant != principal.tenant:
            if not principal.is_admin():
                raise HTTPException(
                    status_code=403,
                    detail="admin scope required to read another tenant's quota",
                )
            target = tenant
        mw = _find_quota_middleware(app)
        limit = mw.limit_for(target) if mw is not None else 0
        snap = store.snapshot(target)
        from .quota import period_reset_epoch

        return {
            "enabled": True,
            "tenant": target,
            "period": snap["period"],
            "used": snap["used"],
            "limit": limit,
            "remaining": max(0, limit - snap["used"]) if limit > 0 else None,
            "reset_epoch": period_reset_epoch(snap["period"]),
        }

    # ---------------- /v1/models ----------------

    @app.get("/v1/models", dependencies=[Depends(require_scope("models:read"))])
    def list_models() -> ModelList:
        return ModelList(data=[ModelCard(id=handle.name), ModelCard(id="codeclone")])

    # ---------------- /v1/chat/completions ----------------

    @app.post("/v1/chat/completions", dependencies=[Depends(require_scope("infer"))])
    async def chat_completions(req: ChatCompletionRequest):
        if req.n != 1:
            raise HTTPException(400, "n must be 1")
        prompt = _render_messages(req.messages)
        stop_list = [req.stop] if isinstance(req.stop, str) else (req.stop or None)
        cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        if req.stream:
            return _sse_chat_stream(handle, cid, req, prompt, stop_list)
        text = handle.generate(
            prompt,
            max_tokens=min(req.max_tokens, get_settings().max_tokens),
            temperature=req.temperature,
            stop=stop_list,
        )
        prompt_tokens = handle.token_count(prompt)
        completion_tokens = handle.token_count(text)
        return ChatCompletionResponse(
            id=cid,
            model=req.model or handle.name,
            choices=[
                ChatCompletionChoice(
                    index=0,
                    message=ChatMessage(role="assistant", content=text),
                    finish_reason="stop",
                )
            ],
            usage=Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
        )

    # ---------------- /v1/completions ----------------

    @app.post("/v1/completions", dependencies=[Depends(require_scope("infer"))])
    async def completions(req: CompletionRequest):
        if req.n != 1:
            raise HTTPException(400, "n must be 1")
        if isinstance(req.prompt, list):
            prompt = "\n".join(req.prompt)
        else:
            prompt = req.prompt
        # FIM glue for Continue.dev tab autocomplete.
        if req.fim_prefix is not None or req.fim_suffix is not None:
            prompt = (req.fim_prefix or "") + "<|fim_hole|>" + (req.fim_suffix or "")
        stop_list = [req.stop] if isinstance(req.stop, str) else (req.stop or None)
        cid = f"cmpl-{uuid.uuid4().hex[:24]}"
        if req.stream:
            return _sse_text_stream(handle, cid, req, prompt, stop_list)
        text = handle.generate(
            prompt,
            max_tokens=min(req.max_tokens, get_settings().max_tokens),
            temperature=req.temperature,
            stop=stop_list,
        )
        if req.echo:
            text = prompt + text
        prompt_tokens = handle.token_count(prompt)
        completion_tokens = handle.token_count(text)
        return CompletionResponse(
            id=cid,
            model=req.model or handle.name,
            choices=[CompletionChoice(text=text, index=0, finish_reason="stop")],
            usage=Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
        )

    return app


def _find_quota_middleware(app: FastAPI):
    """Return a lightweight helper exposing the configured per-tenant limit.

    The actual middleware instance is constructed by Starlette deep inside
    the ASGI stack and is not easily reachable, so we reconstruct an
    equivalent :class:`QuotaMiddleware` (which is a pure-Python object with
    no per-request state of its own) from the configuration we stashed on
    ``app.state``. The returned object is only used for its ``limit_for``
    lookup, not for request handling.
    """
    store = getattr(app.state, "quota_store", None)
    if store is None:
        return None
    return QuotaMiddleware(
        app,
        store=store,
        default_limit=getattr(app.state, "quota_default_limit", 0),
        overrides=getattr(app.state, "quota_overrides", {}) or {},
    )


# ---------------- streaming helpers ----------------


def _sse_chat_stream(
    handle: ModelHandle,
    cid: str,
    req: ChatCompletionRequest,
    prompt: str,
    stop_list: list[str] | None,
):
    model = req.model or handle.name

    async def _gen() -> AsyncIterator[dict]:
        first = ChatCompletionStreamChunk(
            id=cid,
            model=model,
            choices=[
                ChatCompletionStreamChoice(
                    index=0,
                    delta=ChatCompletionDelta(role="assistant", content=""),
                    finish_reason=None,
                )
            ],
        )
        yield {"data": first.model_dump_json()}
        for piece in handle.stream(
            prompt,
            max_tokens=min(req.max_tokens, get_settings().max_tokens),
            temperature=req.temperature,
            stop=stop_list,
        ):
            chunk = ChatCompletionStreamChunk(
                id=cid,
                model=model,
                choices=[
                    ChatCompletionStreamChoice(
                        index=0,
                        delta=ChatCompletionDelta(content=piece),
                        finish_reason=None,
                    )
                ],
            )
            yield {"data": chunk.model_dump_json()}
        last = ChatCompletionStreamChunk(
            id=cid,
            model=model,
            choices=[
                ChatCompletionStreamChoice(
                    index=0, delta=ChatCompletionDelta(), finish_reason="stop"
                )
            ],
        )
        yield {"data": last.model_dump_json()}
        yield {"data": "[DONE]"}

    return EventSourceResponse(_gen())


def _sse_text_stream(
    handle: ModelHandle,
    cid: str,
    req: CompletionRequest,
    prompt: str,
    stop_list: list[str] | None,
):
    model = req.model or handle.name

    async def _gen() -> AsyncIterator[dict]:
        for piece in handle.stream(
            prompt,
            max_tokens=min(req.max_tokens, get_settings().max_tokens),
            temperature=req.temperature,
            stop=stop_list,
        ):
            payload = {
                "id": cid,
                "object": "text_completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"text": piece, "index": 0, "finish_reason": None}],
            }
            yield {"data": json.dumps(payload)}
        payload = {
            "id": cid,
            "object": "text_completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"text": "", "index": 0, "finish_reason": "stop"}],
        }
        yield {"data": json.dumps(payload)}
        yield {"data": "[DONE]"}

    return EventSourceResponse(_gen())
