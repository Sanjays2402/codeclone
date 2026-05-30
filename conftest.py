"""Pytest fixtures shared across test packages."""

import os
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent
RECIPES_DIR = ROOT / "recipes"

# Make all in-repo packages importable without `pip install -e .`.
for sub in (
    ROOT / "src",
    ROOT / "packages" / "config",
    ROOT / "packages" / "dataset",
    ROOT / "packages" / "models",
    ROOT / "services" / "exporter",
    ROOT / "services" / "preprocess",
    ROOT / "services" / "trainer",
    ROOT / "services" / "eval",
    ROOT / "services" / "serve",
):
    s = str(sub)
    if s not in sys.path:
        sys.path.insert(0, s)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # Keep tests from picking up the user's real .env / GITHUB_TOKEN.
    for k in (
        "GITHUB_TOKEN",
        "GITHUB_USER",
        "AUTHOR_EMAIL",
        "AUTHOR_EMAILS_EXTRA",
        "CODECLONE_API_KEY",
        "CODECLONE_API_KEYS",
        "MLFLOW_TRACKING_URI",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
    ):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CODECLONE_API_KEY", "sk-test-key")
    monkeypatch.setenv("AUTHOR_EMAIL", "test@example.com")
    # Drop the LRU cache on Settings so changes take effect.
    from codeclone_config.settings import reset_settings_cache

    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    (tmp_path / "data").mkdir()
    (tmp_path / "adapters").mkdir()
    (tmp_path / "runs").mkdir()
    return tmp_path


@pytest.fixture
def fixtures_dir() -> Path:
    return ROOT / "tests" / "fixtures"


@pytest.fixture
def recipes_dir() -> Path:
    return RECIPES_DIR
