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
    serve_host: str = Field(default="127.0.0.1", alias="CODECLONE_SERVE_HOST")
    serve_port: int = Field(default=7461, alias="CODECLONE_SERVE_PORT")
    max_tokens: int = Field(default=2048, alias="CODECLONE_MAX_TOKENS")
    default_temperature: float = Field(default=0.2, alias="CODECLONE_DEFAULT_TEMPERATURE")

    # ---- Observability ----
    otel_endpoint: str | None = Field(default=None, alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    otel_service: str = Field(default="codeclone", alias="OTEL_SERVICE_NAME")
    mlflow_uri: str | None = Field(default=None, alias="MLFLOW_TRACKING_URI")

    # ---- Logging ----
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_json: bool = Field(default=True, alias="LOG_JSON")

    # ---- HF ----
    hf_token: str | None = Field(default=None, alias="HUGGING_FACE_HUB_TOKEN")

    # ---- Rate limiting (token bucket on the serve API) ----
    ratelimit_enabled: bool = Field(default=True, alias="CODECLONE_RATELIMIT_ENABLED")
    ratelimit_per_ip_rpm: int = Field(default=120, alias="CODECLONE_RATELIMIT_PER_IP_RPM")
    ratelimit_per_key_rpm: int = Field(default=600, alias="CODECLONE_RATELIMIT_PER_KEY_RPM")
    ratelimit_burst: int = Field(default=20, alias="CODECLONE_RATELIMIT_BURST")
    ratelimit_trust_forwarded: bool = Field(
        default=False, alias="CODECLONE_RATELIMIT_TRUST_FORWARDED"
    )

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
