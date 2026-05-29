"""Eval runner: orchestrates perplexity, mini suite, samples; writes report."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from codeclone_config.logging import get_logger

from .mini_humaneval import MiniScore, run_mini_suite
from .perplexity import PerplexityResult, compute_perplexity
from .samples import SampleRow, sample_completions


log = get_logger(__name__)


class EvalError(RuntimeError):
    pass


@dataclass
class EvalResult:
    model: str
    perplexity: PerplexityResult | None
    mini_scores: list[MiniScore] = field(default_factory=list)
    mini_pass_rate: float = 0.0
    samples: list[SampleRow] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "perplexity": self.perplexity.to_dict() if self.perplexity else None,
            "mini_pass_rate": round(self.mini_pass_rate, 3),
            "mini_scores": [
                {"name": s.name, "passed": s.passed, "error": s.error[:200]}
                for s in self.mini_scores
            ],
            "samples": [s.to_dict() for s in self.samples],
        }


@dataclass
class EvalRunner:
    model_name: str
    completer: Callable[[str], str] | None = None
    model_callable: Callable[[str, str], tuple[float, int]] | None = None

    def run(
        self,
        test_jsonl: str | Path,
        out_dir: str | Path,
        *,
        run_perplexity: bool = True,
        run_mini: bool = True,
        n_samples: int = 4,
        max_problems: int | None = None,
        max_perplexity_examples: int | None = 128,
    ) -> EvalResult:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)

        ppl = None
        if run_perplexity:
            ppl = compute_perplexity(
                test_jsonl,
                model_callable=self.model_callable,
                max_examples=max_perplexity_examples,
            )

        mini_scores: list[MiniScore] = []
        if run_mini and self.completer is not None:
            mini_scores = run_mini_suite(self.completer, max_problems=max_problems)
        elif run_mini:
            mini_scores = run_mini_suite(lambda _: "", max_problems=max_problems)

        n_pass = sum(1 for s in mini_scores if s.passed)
        pass_rate = (n_pass / len(mini_scores)) if mini_scores else 0.0

        samples = sample_completions(test_jsonl, completer=self.completer, n=n_samples)

        result = EvalResult(
            model=self.model_name,
            perplexity=ppl,
            mini_scores=mini_scores,
            mini_pass_rate=pass_rate,
            samples=samples,
        )
        (out / "eval_report.json").write_text(
            json.dumps(result.to_dict(), indent=2), encoding="utf-8"
        )
        log.info(
            "eval.done",
            model=self.model_name,
            ppl=(ppl.perplexity if ppl else None),
            pass_rate=pass_rate,
        )
        return result
