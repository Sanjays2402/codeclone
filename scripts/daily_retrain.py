"""Cron-friendly retraining: re-export, re-preprocess, retrain, eval, smoke-call.

Intended use: a daily systemd timer or launchd job.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> int:
    print("$", " ".join(cmd), flush=True)
    return subprocess.call(cmd)


def main() -> int:
    ap = argparse.ArgumentParser(description="Daily retrain pipeline.")
    ap.add_argument("--user", required=True)
    ap.add_argument("--recipe", default="recipes/small.yaml")
    ap.add_argument("--name", default="daily")
    ap.add_argument("--data", default="data/processed")
    ap.add_argument("--adapters", default="adapters")
    ap.add_argument("--max-repos", type=int, default=None)
    args = ap.parse_args()

    raw = Path("data/raw/pairs.jsonl")
    raw.parent.mkdir(parents=True, exist_ok=True)
    if run([
        "codeclone", "export",
        "--user", args.user,
        "--out", str(raw),
        *( ["--max-repos", str(args.max_repos)] if args.max_repos else [] ),
    ]) != 0:
        return 1
    if run(["codeclone", "preprocess", "--in", str(raw), "--recipe", args.recipe, "--out", args.data]) != 0:
        return 2
    if run(["codeclone", "train", "--recipe", args.recipe, "--data", args.data, "--out", f"{args.adapters}/{args.name}"]) != 0:
        return 3
    if run(["codeclone", "eval", "--model", f"{args.adapters}/{args.name}", "--data", f"{args.data}/test.jsonl"]) != 0:
        return 4
    print(json.dumps({"status": "ok", "adapter": f"{args.adapters}/{args.name}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
