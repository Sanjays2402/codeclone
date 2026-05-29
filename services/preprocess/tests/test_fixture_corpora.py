"""Run the preprocess pipeline against the fixture pair files."""

from pathlib import Path

import pytest

from codeclone_config.recipes import load_recipe
from codeclone_preprocess import Preprocessor


FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "pairs"
RECIPES = Path(__file__).resolve().parents[3] / "recipes"


@pytest.mark.parametrize(
    "fixture_name,recipe_name",
    [
        ("small_py_only.jsonl", "quick.yaml"),
        ("mixed_lang.jsonl", "small.yaml"),
        ("medium_corpus.jsonl", "small.yaml"),
        ("only_ts.jsonl", "quick.yaml"),
    ],
)
def test_pipeline_runs_on_fixture(tmp_path, fixture_name, recipe_name):
    recipe = load_recipe(RECIPES / recipe_name)
    pp = Preprocessor(recipe=recipe)
    res = pp.run(FIXTURES / fixture_name, tmp_path / "out")
    assert res.counts["train"] >= 0
    assert (tmp_path / "out" / "preprocess_report.json").exists()
