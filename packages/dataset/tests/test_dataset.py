from pathlib import Path

import pytest

from codeclone_dataset.pairs import Pair, write_pairs, read_pairs, stats_for
from codeclone_dataset.splits import deterministic_split, SplitSpec
from codeclone_dataset.dedupe import exact_dedupe, minhash_dedupe


def _mk(idx: int, prefix: str = "p", completion: str = "c", lang: str = "py") -> Pair:
    return Pair(
        id=f"x-{idx}",
        kind="completion",
        language=lang,
        prefix=prefix,
        completion=completion,
        repo="me/repo",
        commit_sha="0" * 40,
        path="a.py",
        author_email_hash="deadbeefdeadbeef",
    )


def test_pair_roundtrip(tmp_path: Path):
    pairs = [_mk(i, completion=f"def f{i}():\n    return {i}\n") for i in range(5)]
    out = tmp_path / "p.jsonl"
    n = write_pairs(out, pairs)
    assert n == 5
    back = read_pairs(out)
    assert [p.id for p in back] == [p.id for p in pairs]
    assert back[0].n_completion_chars == len(pairs[0].completion)


def test_stats_for_basic(tmp_path: Path):
    pairs = [_mk(i, completion="aaaa\nbbbb\n", lang="py" if i % 2 else "ts") for i in range(10)]
    p = tmp_path / "p.jsonl"
    write_pairs(p, pairs)
    s = stats_for(p)
    assert s.total == 10
    assert s.by_language.get("py", 0) + s.by_language.get("ts", 0) == 10


def test_deterministic_split(tmp_path: Path):
    pairs = [_mk(i) for i in range(20)]
    out = tmp_path / "split"
    counts = deterministic_split(pairs, out, SplitSpec(train=0.7, val=0.2, test=0.1, seed=7))
    assert counts["train"] + counts["val"] + counts["test"] == 20
    # Reproducible.
    counts2 = deterministic_split(pairs, tmp_path / "split2", SplitSpec(train=0.7, val=0.2, test=0.1, seed=7))
    assert counts == counts2


def test_split_invalid_sums():
    with pytest.raises(ValueError):
        SplitSpec(train=0.5, val=0.6, test=0.1).validate()


def test_exact_dedupe_drops_dups():
    pairs = [_mk(0, completion="x"), _mk(1, completion="x"), _mk(2, completion="y")]
    got = list(exact_dedupe(pairs))
    assert len(got) == 2


def test_minhash_dedupe_keeps_distinct():
    pairs = [
        _mk(0, completion="def foo():\n    return 1\n"),
        _mk(1, completion="def foo():\n    return 1\n"),  # exact dup
        _mk(2, completion="class Bar:\n    pass\n"),
    ]
    got = list(minhash_dedupe(pairs))
    assert len(got) == 2
