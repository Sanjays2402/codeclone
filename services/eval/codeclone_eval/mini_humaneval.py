"""A tiny HumanEval-style suite, runnable in-process with a subprocess sandbox
for the generated code. Problems are intentionally small so the harness can
run anywhere; the point is to test the scoring infrastructure, not to ship a
new benchmark.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class MiniProblem:
    name: str
    prompt: str
    canonical_solution: str
    tests: str


MINI_PROBLEMS: list[MiniProblem] = [
    MiniProblem(
        name="add",
        prompt="def add(a, b):\n    \"\"\"Return a + b.\"\"\"\n",
        canonical_solution="    return a + b\n",
        tests="assert add(1, 2) == 3\nassert add(-1, 1) == 0\nassert add(0, 0) == 0\n",
    ),
    MiniProblem(
        name="is_even",
        prompt="def is_even(n):\n    \"\"\"True if n is even.\"\"\"\n",
        canonical_solution="    return n % 2 == 0\n",
        tests="assert is_even(0)\nassert not is_even(1)\nassert is_even(-4)\n",
    ),
    MiniProblem(
        name="reverse",
        prompt="def reverse(s):\n    \"\"\"Return s reversed.\"\"\"\n",
        canonical_solution="    return s[::-1]\n",
        tests="assert reverse('abc') == 'cba'\nassert reverse('') == ''\nassert reverse('a') == 'a'\n",
    ),
    MiniProblem(
        name="count_vowels",
        prompt="def count_vowels(s):\n    \"\"\"Count vowels (aeiouAEIOU) in s.\"\"\"\n",
        canonical_solution="    return sum(1 for c in s if c in 'aeiouAEIOU')\n",
        tests="assert count_vowels('hello') == 2\nassert count_vowels('') == 0\nassert count_vowels('AEIOU') == 5\n",
    ),
    MiniProblem(
        name="fib",
        prompt="def fib(n):\n    \"\"\"Return the n-th Fibonacci number (fib(0)=0).\"\"\"\n",
        canonical_solution=(
            "    a, b = 0, 1\n"
            "    for _ in range(n):\n"
            "        a, b = b, a + b\n"
            "    return a\n"
        ),
        tests="assert fib(0) == 0\nassert fib(1) == 1\nassert fib(10) == 55\n",
    ),
    MiniProblem(
        name="flatten",
        prompt="def flatten(xs):\n    \"\"\"Flatten one level of a list of lists.\"\"\"\n",
        canonical_solution="    return [x for sub in xs for x in sub]\n",
        tests="assert flatten([[1,2],[3]]) == [1,2,3]\nassert flatten([]) == []\n",
    ),
    MiniProblem(
        name="dedupe_keep_order",
        prompt="def dedupe(xs):\n    \"\"\"Dedupe a list, preserving order of first occurrence.\"\"\"\n",
        canonical_solution=(
            "    seen = set()\n"
            "    out = []\n"
            "    for x in xs:\n"
            "        if x not in seen:\n"
            "            out.append(x)\n"
            "            seen.add(x)\n"
            "    return out\n"
        ),
        tests="assert dedupe([1,1,2,3,2]) == [1,2,3]\nassert dedupe([]) == []\n",
    ),
    MiniProblem(
        name="max_subarray",
        prompt="def max_subarray(xs):\n    \"\"\"Kadane: max contiguous subarray sum.\"\"\"\n",
        canonical_solution=(
            "    best = cur = xs[0]\n"
            "    for x in xs[1:]:\n"
            "        cur = max(x, cur + x)\n"
            "        best = max(best, cur)\n"
            "    return best\n"
        ),
        tests=(
            "assert max_subarray([1, -2, 3, 4, -1, 2, 1, -5, 4]) == 9\n"
            "assert max_subarray([-1, -2, -3]) == -1\n"
        ),
    ),
]


@dataclass
class MiniScore:
    name: str
    passed: bool
    error: str = ""


def _run_python(source: str, timeout: float = 5.0) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "candidate.py"
        f.write_text(source, encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, str(f)],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return False, "timeout"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout)[:500]
    return True, ""


def score_problem(
    problem: MiniProblem,
    completer: Callable[[str], str],
    *,
    use_canonical_on_failure: bool = False,
) -> MiniScore:
    """Ask `completer(prompt)` for the body, splice it under the signature, run tests."""
    body = completer(problem.prompt) or ""
    body = textwrap.indent(textwrap.dedent(body.strip("\n")), "    ") + "\n"
    source = problem.prompt + (body if body.strip() else problem.canonical_solution if use_canonical_on_failure else "") + "\n" + problem.tests
    ok, err = _run_python(source)
    return MiniScore(name=problem.name, passed=ok, error=err)


def run_mini_suite(
    completer: Callable[[str], str],
    *,
    max_problems: int | None = None,
) -> list[MiniScore]:
    problems = MINI_PROBLEMS if max_problems is None else MINI_PROBLEMS[:max_problems]
    return [score_problem(p, completer) for p in problems]
