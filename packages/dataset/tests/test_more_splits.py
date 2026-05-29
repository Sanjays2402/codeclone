"""More dataset tests: pair stream stats correctness, splits edge cases."""

from pathlib import Path

from codeclone_dataset.pairs import Pair, write_pairs, stats_for
from codeclone_dataset.splits import deterministic_split, SplitSpec


def _mk(idx: int, lang: str = "py", completion_lines: int = 5) -> Pair:
    completion = "\n".join(f"line {i}" for i in range(completion_lines)) + "\n"
    return Pair(
        id=f"x-{idx:05d}",
        kind="completion",
        language=lang,
        prefix="# context\n",
        completion=completion,
        repo="me/r",
        commit_sha="0" * 40,
        path=f"a/{idx}.{lang}",
        author_email_hash="deadbeefdeadbeef",
    )


def test_stats_reflect_distribution(tmp_path: Path):
    pairs = [_mk(i, lang=("py" if i % 3 == 0 else "ts" if i % 3 == 1 else "go")) for i in range(30)]
    p = tmp_path / "p.jsonl"
    write_pairs(p, pairs)
    s = stats_for(p)
    assert s.total == 30
    assert sum(s.by_language.values()) == 30
    assert set(s.by_language.keys()) == {"py", "ts", "go"}
    # Each lang should have 10 (30 / 3).
    for v in s.by_language.values():
        assert v == 10
    assert s.p95_completion_chars >= s.p50_completion_chars


def test_split_with_zero_val(tmp_path: Path):
    pairs = [_mk(i) for i in range(20)]
    out = tmp_path / "split"
    counts = deterministic_split(pairs, out, SplitSpec(train=0.8, val=0.0, test=0.2, seed=42))
    assert counts["val"] == 0
    assert counts["train"] + counts["test"] == 20


def test_split_with_full_train(tmp_path: Path):
    pairs = [_mk(i) for i in range(10)]
    out = tmp_path / "split"
    counts = deterministic_split(pairs, out, SplitSpec(train=1.0, val=0.0, test=0.0, seed=42))
    assert counts["train"] == 10
    assert counts["val"] == 0
    assert counts["test"] == 0


def test_split_empty_input_safe(tmp_path: Path):
    out = tmp_path / "split"
    counts = deterministic_split([], out, SplitSpec(train=0.8, val=0.1, test=0.1))
    assert counts == {"train": 0, "val": 0, "test": 0}
