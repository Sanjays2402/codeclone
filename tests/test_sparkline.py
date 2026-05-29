"""Tests for the sparkline helper."""

import importlib.util
import json
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "run_sparkline",
    Path(__file__).resolve().parents[1] / "scripts" / "run_sparkline.py",
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)  # type: ignore[union-attr]


def test_sparkline_flat():
    s = mod.sparkline([1.0, 1.0, 1.0])
    assert len(s) == 3


def test_sparkline_decreasing():
    s = mod.sparkline([5.0, 4.0, 3.0, 2.0, 1.0])
    assert len(s) == 5
    # First char tallest, last char shortest.
    assert s[0] > s[-1]


def test_main_reads_jsonl(tmp_path: Path, capsys):
    p = tmp_path / "m.jsonl"
    p.write_text("\n".join(json.dumps({"step": i, "loss": 10.0 - i}) for i in range(5)) + "\n")
    import sys

    sys.argv = ["x", str(p)]
    rc = mod.main()
    out = capsys.readouterr().out
    assert rc == 0
    assert "first=" in out and "last=" in out
