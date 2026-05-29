"""Tests for the evaluation runner with the full mini suite."""

from pathlib import Path

from codeclone_dataset.pairs import Pair, write_pairs
from codeclone_eval import EvalRunner
from codeclone_eval.mini_humaneval import MINI_PROBLEMS, score_problem


def _mk(idx, comp):
    return Pair(
        id=str(idx), language="py", prefix="# h\n", completion=comp,
        repo="me/r", commit_sha="0" * 40, path="a.py",
        author_email_hash="deadbeefdeadbeef",
    )


def test_all_canonical_solutions_pass():
    for p in MINI_PROBLEMS:
        score = score_problem(p, completer=lambda _, sol=p.canonical_solution: sol)
        assert score.passed, f"{p.name} failed: {score.error}"


def test_full_runner_with_canonical_completer(tmp_path: Path):
    p = tmp_path / "t.jsonl"
    write_pairs(p, [_mk(i, "def f():\n    return 1\n") for i in range(10)])

    # Map prompt -> canonical solution.
    by_prompt = {prob.prompt: prob.canonical_solution for prob in MINI_PROBLEMS}

    def canonical_completer(prompt: str) -> str:
        return by_prompt.get(prompt, "")

    runner = EvalRunner(model_name="test-canonical", completer=canonical_completer)
    res = runner.run(p, tmp_path / "report", n_samples=2)
    assert res.mini_pass_rate == 1.0
    assert (tmp_path / "report" / "eval_report.json").exists()


def test_runner_records_sample_count(tmp_path: Path):
    p = tmp_path / "t.jsonl"
    write_pairs(p, [_mk(i, "def f():\n    return 1\n") for i in range(20)])
    runner = EvalRunner(model_name="x", completer=lambda _: "")
    res = runner.run(p, tmp_path / "rep", n_samples=5)
    assert len(res.samples) == 5
