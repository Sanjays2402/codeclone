from pathlib import Path

from codeclone_dataset.pairs import Pair, write_pairs
from codeclone_eval import EvalRunner, compute_perplexity
from codeclone_eval.mini_humaneval import MINI_PROBLEMS, run_mini_suite, score_problem


def _mk(idx, comp):
    return Pair(
        id=str(idx), language="py", prefix="# h\n", completion=comp,
        repo="me/r", commit_sha="0" * 40, path="a.py",
        author_email_hash="deadbeefdeadbeef",
    )


def test_perplexity_proxy_runs(tmp_path: Path):
    p = tmp_path / "t.jsonl"
    write_pairs(p, [_mk(i, "def f():\n    return 1\n") for i in range(5)])
    res = compute_perplexity(p)
    assert res.proxy
    assert res.perplexity > 0
    assert res.n_examples == 5


def test_mini_problem_canonical_passes():
    p = MINI_PROBLEMS[0]
    score = score_problem(p, completer=lambda _: p.canonical_solution)
    assert score.passed, score.error


def test_mini_problem_empty_fails():
    p = MINI_PROBLEMS[0]
    score = score_problem(p, completer=lambda _: "")
    assert not score.passed


def test_run_mini_suite_records_results():
    scores = run_mini_suite(lambda _: "", max_problems=3)
    assert len(scores) == 3
    assert all(s.error or not s.passed for s in scores)


def test_eval_runner_writes_report(tmp_path: Path):
    p = tmp_path / "t.jsonl"
    write_pairs(p, [_mk(i, "def f():\n    return 1\n") for i in range(5)])
    runner = EvalRunner(model_name="test-model", completer=lambda _: "")
    res = runner.run(p, tmp_path / "report", n_samples=2, max_problems=2)
    assert (tmp_path / "report" / "eval_report.json").exists()
    assert res.perplexity is not None
    assert 0.0 <= res.mini_pass_rate <= 1.0
