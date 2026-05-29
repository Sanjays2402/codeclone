from pathlib import Path

from codeclone_config.recipes import load_recipe
from codeclone_dataset.pairs import Pair, write_pairs, iter_pairs
from codeclone_preprocess import Preprocessor
from codeclone_preprocess.normalize import normalize_text, normalize_pair
from codeclone_preprocess.filters import apply_filters
from codeclone_preprocess.tokenize import build_tokenizer


def _mk(idx, completion="def f():\n    return 1\n", lang="py"):
    return Pair(
        id=str(idx),
        kind="completion",
        language=lang,
        prefix="# repo: me/r\n",
        completion=completion,
        repo="me/r",
        commit_sha="0" * 40,
        path="a.py",
        author_email_hash="deadbeefdeadbeef",
    )


def test_normalize_text_collapses_blanklines_and_tabs():
    t = "a\r\n\tb\n\n\n\n\nc \n"
    n = normalize_text(t)
    assert "\r" not in n
    assert "\t" not in n
    assert "\n\n\n\n" not in n
    assert not any(line.endswith(" ") for line in n.split("\n"))


def test_apply_filters_drops_short_and_long():
    pairs = [
        _mk(1, completion="x\n"),
        _mk(2, completion="a\nb\nc\nd\n"),
        _mk(3, completion="\n" * 2000),
    ]
    it, report = apply_filters(pairs, languages={"py"}, min_lines=3, max_lines=100)
    list(it)
    assert report.kept == 1
    assert report.dropped_short >= 1
    assert report.dropped_long >= 1


def test_preprocess_end_to_end(tmp_path: Path, recipes_dir):
    recipe = load_recipe(recipes_dir / "small.yaml")
    pairs = [_mk(i, completion=f"def f{i}():\n    return {i}\n    pass\n") for i in range(60)]
    raw = tmp_path / "raw.jsonl"
    write_pairs(raw, pairs)
    pp = Preprocessor(recipe=recipe)
    res = pp.run(raw, tmp_path / "out")
    assert res.final_total > 0
    assert (tmp_path / "out" / "train.jsonl").exists()
    assert (tmp_path / "out" / "preprocess_report.json").exists()


def test_tokenizer_roundtrip_or_count():
    tok = build_tokenizer("Qwen/Qwen2.5-Coder-1.5B")
    # We don't require HF to be present; either way `count` must be > 0.
    n = tok.count("def f():\n    return 1\n")
    assert n > 0
