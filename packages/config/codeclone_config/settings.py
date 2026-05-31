"""Runtime settings, sourced from environment then .env."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BackendName = Literal["auto", "mlx", "peft"]


class Settings(BaseSettings):
    """Process-wide settings.

    Resolution order: explicit kwarg > environment variable > .env > default.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- GitHub access ----
    github_token: str | None = Field(default=None, alias="GITHUB_TOKEN")
    github_user: str | None = Field(default=None, alias="GITHUB_USER")
    author_email: str | None = Field(default=None, alias="AUTHOR_EMAIL")
    author_emails_extra: str = Field(default="", alias="AUTHOR_EMAILS_EXTRA")

    # ---- Paths ----
    data_dir: Path = Field(default=Path("./data"), alias="CODECLONE_DATA_DIR")
    adapters_dir: Path = Field(default=Path("./adapters"), alias="CODECLONE_ADAPTERS_DIR")
    runs_dir: Path = Field(default=Path("./runs"), alias="CODECLONE_RUNS_DIR")
    cache_dir: Path = Field(default=Path("./data/cache"), alias="CODECLONE_CACHE_DIR")
    hf_home: Path = Field(default=Path("./hf_cache"), alias="HF_HOME")

    # ---- Model defaults ----
    base_model: str = Field(default="Qwen/Qwen2.5-Coder-1.5B", alias="CODECLONE_BASE_MODEL")
    tokenizer: str = Field(default="Qwen/Qwen2.5-Coder-1.5B", alias="CODECLONE_TOKENIZER")
    backend: BackendName = Field(default="auto", alias="CODECLONE_BACKEND")

    # ---- Serve ----
    api_key: str = Field(default="sk-codeclone-local", alias="CODECLONE_API_KEY")
    # Multi-key keyring with per-key scopes. CSV of `key:scope+scope` entries,
    # e.g. `sk-ci:models:read+infer,sk-admin:*`. Parsed at request time by
    # services.serve.codeclone_serve.auth. Empty by default; the legacy
    # `CODECLONE_API_KEY` above continues to work and is granted wildcard scope.
    api_keys: str = Field(default="", alias="CODECLONE_API_KEYS")
    serve_host: str = Field(default="127.0.0.1", alias="CODECLONE_SERVE_HOST")
    serve_port: int = Field(default=7461, alias="CODECLONE_SERVE_PORT")
    max_tokens: int = Field(default=2048, alias="CODECLONE_MAX_TOKENS")
    default_temperature: float = Field(default=0.2, alias="CODECLONE_DEFAULT_TEMPERATURE")

    # ---- Observability ----
    otel_endpoint: str | None = Field(default=None, alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    otel_service: str = Field(default="codeclone", alias="OTEL_SERVICE_NAME")
    mlflow_uri: str | None = Field(default=None, alias="MLFLOW_TRACKING_URI")

    # ---- Error tracking (Sentry) ----
    sentry_dsn: str | None = Field(default=None, alias="SENTRY_DSN")
    sentry_environment: str = Field(default="development", alias="SENTRY_ENVIRONMENT")
    sentry_release: str | None = Field(default=None, alias="SENTRY_RELEASE")
    sentry_traces_sample_rate: float = Field(
        default=0.0, alias="SENTRY_TRACES_SAMPLE_RATE"
    )
    sentry_send_default_pii: bool = Field(
        default=False, alias="SENTRY_SEND_DEFAULT_PII"
    )

    @field_validator("sentry_traces_sample_rate")
    @classmethod
    def _traces_rate_range(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError(
                f"sentry_traces_sample_rate must be within [0.0, 1.0], got {v}"
            )
        return v

    # ---- Logging ----
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_json: bool = Field(default=True, alias="LOG_JSON")

    # ---- HF ----
    hf_token: str | None = Field(default=None, alias="HUGGING_FACE_HUB_TOKEN")

    # ---- Rate limiting (token bucket on the serve API) ----
    ratelimit_enabled: bool = Field(default=True, alias="CODECLONE_RATELIMIT_ENABLED")
    ratelimit_per_ip_rpm: int = Field(default=120, alias="CODECLONE_RATELIMIT_PER_IP_RPM")
    ratelimit_per_key_rpm: int = Field(default=600, alias="CODECLONE_RATELIMIT_PER_KEY_RPM")
    # Per-tenant ceiling. Independent of the per-key bucket so a tenant that
    # issues many keys still has a single aggregate ceiling. Defaults a bit
    # above per_key so a single-key tenant is not effectively double-limited.
    ratelimit_per_tenant_rpm: int = Field(
        default=1200, alias="CODECLONE_RATELIMIT_PER_TENANT_RPM"
    )
    ratelimit_burst: int = Field(default=20, alias="CODECLONE_RATELIMIT_BURST")
    ratelimit_trust_forwarded: bool = Field(
        default=False, alias="CODECLONE_RATELIMIT_TRUST_FORWARDED"
    )

    # ---- CORS (browser cross-origin policy on the serve API) ----
    # By default CORS is locked down: no cross-origin browser callers are
    # allowed. Set CODECLONE_CORS_ALLOW_ORIGINS to a CSV of exact origins
    # (scheme + host [+ port], no trailing slash), e.g.
    #   CODECLONE_CORS_ALLOW_ORIGINS=https://app.example.com,https://admin.example.com
    # The literal value ``*`` opts in to a wildcard and is rejected when
    # ``CODECLONE_CORS_ALLOW_CREDENTIALS=true`` because browsers will refuse
    # to send credentials to a wildcard origin (CORS spec).
    cors_allow_origins: str = Field(default="", alias="CODECLONE_CORS_ALLOW_ORIGINS")
    cors_allow_credentials: bool = Field(
        default=False, alias="CODECLONE_CORS_ALLOW_CREDENTIALS"
    )
    cors_allow_methods: str = Field(
        default="GET,POST,OPTIONS", alias="CODECLONE_CORS_ALLOW_METHODS"
    )
    cors_allow_headers: str = Field(
        default="authorization,content-type,x-request-id",
        alias="CODECLONE_CORS_ALLOW_HEADERS",
    )
    cors_max_age: int = Field(default=600, alias="CODECLONE_CORS_MAX_AGE")

    def cors_origins_list(self) -> list[str]:
        """Parsed, de-duplicated origin list. ``[]`` means CORS is off."""
        raw = (self.cors_allow_origins or "").strip()
        if not raw:
            return []
        out: list[str] = []
        seen: set[str] = set()
        for piece in raw.split(","):
            origin = piece.strip().rstrip("/")
            if not origin or origin in seen:
                continue
            seen.add(origin)
            out.append(origin)
        return out

    def cors_methods_list(self) -> list[str]:
        return [m.strip().upper() for m in self.cors_allow_methods.split(",") if m.strip()]

    def cors_headers_list(self) -> list[str]:
        return [h.strip() for h in self.cors_allow_headers.split(",") if h.strip()]

    @field_validator("cors_max_age")
    @classmethod
    def _cors_max_age_nonneg(cls, v: int) -> int:
        if v < 0:
            raise ValueError(f"cors_max_age must be >= 0, got {v}")
        return v

    # ---- Audit log ----
    audit_log_enabled: bool = Field(default=True, alias="CODECLONE_AUDIT_LOG_ENABLED")
    audit_log_path: Path = Field(
        default=Path("./runs/audit.log"), alias="CODECLONE_AUDIT_LOG_PATH"
    )
    # Rotation/retention. ``max_bytes=0`` disables rotation (legacy). The
    # AuditSink itself reads these env vars directly via ``build_sink_from_env``
    # so they are also validated here for fail-fast startup.
    audit_log_max_bytes: int = Field(
        default=50 * 1024 * 1024, alias="CODECLONE_AUDIT_LOG_MAX_BYTES"
    )
    audit_log_backup_count: int = Field(
        default=14, alias="CODECLONE_AUDIT_LOG_BACKUP_COUNT"
    )

    @field_validator("audit_log_max_bytes")
    @classmethod
    def _audit_max_bytes_nonneg(cls, v: int) -> int:
        if v < 0:
            raise ValueError(f"audit_log_max_bytes must be >= 0, got {v}")
        return v

    @field_validator("audit_log_backup_count")
    @classmethod
    def _audit_backup_count_nonneg(cls, v: int) -> int:
        if v < 0:
            raise ValueError(f"audit_log_backup_count must be >= 0, got {v}")
        return v

    # ---- Per-tenant IP allowlist ----
    # CSV of ``tenant=cidr1+cidr2`` entries. When a tenant has at least one
    # CIDR configured, requests authenticated as that tenant whose client IP
    # falls outside every listed network are rejected with HTTP 403. Tenants
    # with no entry are unrestricted (backward compatible). The literal value
    # ``tenant=*`` is also accepted as an explicit "allow any source" entry,
    # useful when an operator wants to declare the policy is intentionally open.
    # Example: ``acme=10.0.0.0/8+192.0.2.5/32,beta=*``.
    ip_allowlist_enabled: bool = Field(
        default=True, alias="CODECLONE_IP_ALLOWLIST_ENABLED"
    )
    ip_allowlist: str = Field(default="", alias="CODECLONE_IP_ALLOWLIST")

    @field_validator("ip_allowlist")
    @classmethod
    def _ip_allowlist_shape(cls, v: str) -> str:
        # Defer full CIDR parsing to the middleware (which already imports
        # ipaddress) so we only do cheap structural checks here. Goal: fail
        # fast on obviously malformed env without duplicating the parser.
        for entry in (v or "").split(","):
            entry = entry.strip()
            if not entry:
                continue
            if "=" not in entry:
                raise ValueError(
                    f"ip_allowlist entry missing '=': {entry!r}; "
                    "use 'tenant=cidr+cidr' or 'tenant=*'"
                )
            tenant, _, rhs = entry.partition("=")
            tenant = tenant.strip()
            rhs = rhs.strip()
            if not tenant or not rhs:
                raise ValueError(
                    f"ip_allowlist entry has empty tenant or cidr: {entry!r}"
                )
        return v

    @field_validator("cors_allow_origins")
    @classmethod
    def _cors_origins_shape(cls, v: str) -> str:
        # Only enforce per-entry shape; emptiness is a valid "off" signal.
        for piece in (v or "").split(","):
            origin = piece.strip()
            if not origin:
                continue
            if origin == "*":
                continue
            if not (origin.startswith("http://") or origin.startswith("https://")):
                raise ValueError(
                    f"cors_allow_origins entries must be http(s):// origins or '*', got {origin!r}"
                )
            if origin.endswith("/"):
                raise ValueError(
                    f"cors_allow_origins entries must not end with '/', got {origin!r}"
                )
        return v

    @field_validator("backend", mode="before")
    @classmethod
    def _normalize_backend(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.lower().strip()
        if v not in ("auto", "mlx", "peft"):
            raise ValueError(f"backend must be auto|mlx|peft, got {v!r}")
        return v

    @field_validator("serve_port")
    @classmethod
    def _port_range(cls, v: int) -> int:
        if not (1 <= v <= 65535):
            raise ValueError(f"serve_port out of range: {v}")
        return v

    def author_email_set(self) -> set[str]:
        """All emails that should be treated as belonging to the user."""
        out: set[str] = set()
        if self.author_email:
            out.add(self.author_email.lower())
        if self.author_emails_extra:
            for piece in self.author_emails_extra.split(","):
                piece = piece.strip().lower()
                if piece:
                    out.add(piece)
        return out

    def resolve_backend(self) -> Literal["mlx", "peft"]:
        """Pick a concrete backend if 'auto' was requested."""
        if self.backend in ("mlx", "peft"):
            return self.backend  # type: ignore[return-value]
        import platform

        if platform.system() == "Darwin" and platform.machine() == "arm64":
            return "mlx"
        return "peft"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.adapters_dir, self.runs_dir, self.cache_dir, self.hf_home):
            p.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Test helper: drop cached settings (used after monkeypatching env)."""
    get_settings.cache_clear()
    # Allow env_file to be re-read on next access.
    if "PYDANTIC_SETTINGS_CACHE" in os.environ:
        del os.environ["PYDANTIC_SETTINGS_CACHE"]
