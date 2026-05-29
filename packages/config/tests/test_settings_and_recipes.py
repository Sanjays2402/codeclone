from codeclone_config.settings import Settings, get_settings
from codeclone_config.recipes import load_recipe, recipe_hash, Recipe
from pathlib import Path


def test_settings_defaults(monkeypatch):
    monkeypatch.setenv("CODECLONE_API_KEY", "x")
    s = Settings(_env_file=None)
    assert s.serve_port == 7461
    assert s.backend == "auto"
    assert s.api_key == "x"


def test_resolve_backend_auto(monkeypatch):
    import platform

    s = Settings(_env_file=None, CODECLONE_BACKEND="auto")
    chosen = s.resolve_backend()
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        assert chosen == "mlx"
    else:
        assert chosen == "peft"


def test_author_email_set(monkeypatch):
    s = Settings(_env_file=None, AUTHOR_EMAIL="A@B.com", AUTHOR_EMAILS_EXTRA="x@y.com,Z@W.com")
    got = s.author_email_set()
    assert "a@b.com" in got
    assert "x@y.com" in got
    assert "z@w.com" in got


def test_recipe_load_and_hash():
    r = load_recipe(Path(__file__).resolve().parents[1] / "recipes" / "small.yaml")
    assert isinstance(r, Recipe)
    h = recipe_hash(r)
    assert len(h) == 16
    # Stable across calls.
    assert recipe_hash(r) == h


def test_invalid_backend_rejected():
    import pytest

    with pytest.raises(ValueError):
        Settings(_env_file=None, CODECLONE_BACKEND="nonsense")
