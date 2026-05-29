"""Pretty-print a JSONL metrics run as ASCII sparkline + final loss."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


_BLOCKS = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float]) -> str:
    if not values:
        return ""
    lo, hi = min(values), max(values)
    if hi == lo:
        return _BLOCKS[0] * len(values)
    span = hi - lo
    return "".join(_BLOCKS[min(7, int((v - lo) / span * 7))] for v in values)


def main() -> int:
    ap = argparse.ArgumentParser(description="Sparkline a run's loss curve")
    ap.add_argument("metrics", type=Path)
    ap.add_argument("--metric", default="loss")
    args = ap.parse_args()

    if not args.metrics.exists():
        print(f"missing: {args.metrics}")
        return 2
    values: list[float] = []
    for line in args.metrics.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        v = row.get(args.metric)
        if isinstance(v, (int, float)):
            values.append(float(v))
    if not values:
        print(f"no '{args.metric}' values found")
        return 1
    print(sparkline(values), f" first={values[0]:.3f}  last={values[-1]:.3f}  n={len(values)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
