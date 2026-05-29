"""Smoke test for the Typer CLI surface. Doesn't run any backends."""

from typer.testing import CliRunner

from codeclone_cli.main import app


runner = CliRunner()


def test_top_help_lists_commands():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for cmd in ("export", "preprocess", "train", "eval", "serve", "models"):
        assert cmd in result.output


def test_models_subcommand_help():
    result = runner.invoke(app, ["models", "--help"])
    assert result.exit_code == 0
    assert "list" in result.output
    assert "show" in result.output


def test_models_hash_recipe(tmp_path):
    from codeclone_config.recipes import load_recipe, recipe_hash
    from pathlib import Path

    recipe_path = Path(__file__).resolve().parents[1] / "recipes" / "quick.yaml"
    result = runner.invoke(app, ["models", "hash-recipe", str(recipe_path)])
    assert result.exit_code == 0
    expected = recipe_hash(load_recipe(recipe_path))
    assert expected in result.output


def test_models_list_empty(tmp_path):
    result = runner.invoke(app, ["models", "list", "--adapters-dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "Adapters" in result.output
