"""End-to-end preprocess pipeline: normalize -> filter -> dedupe -> split."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from codeclone_config.logging import get_logger
from codeclone_config.recipes import Recipe
from codeclone_dataset.dedupe import exact_dedupe, minhash_dedupe
from codeclone_dataset.pairs import iter_pairs, write_pairs, stats_for
from codeclone_dataset.splits import SplitSpec, deterministic_split

from .filters import apply_filters, FilterReport
from .normalize import normalize_pair


log = get_logger(__name__)


@dataclass
class PreprocessResult:
    out_dir: Path
    counts: dict[str, int]
    filter_report: FilterReport
    dedupe_dropped: int
    final_total: int
    stats_train: dict = field(default_factory=dict)
    stats_val: dict = field(default_factory=dict)
    stats_test: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "out_dir": str(self.out_dir),
            "counts": self.counts,
            "filter_report": self.filter_report.to_dict(),
            "dedupe_dropped": self.dedupe_dropped,
            "final_total": self.final_total,
            "stats_train": self.stats_train,
            "stats_val": self.stats_val,
            "stats_test": self.stats_test,
        }


@dataclass
class Preprocessor:
    recipe: Recipe

    def run(self, raw_path: str | Path, out_dir: str | Path) -> PreprocessResult:
        raw_path = Path(raw_path)
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        if not raw_path.exists():
            raise FileNotFoundError(f"raw pairs file not found: {raw_path}")

        # 1. normalize + filter (stream)
        languages = set(self.recipe.data.languages)
        normalized = (normalize_pair(p) for p in iter_pairs(raw_path))
        filtered_iter, report = apply_filters(
            normalized,
            languages=languages,
            min_lines=self.recipe.data.min_lines,
            max_lines=self.recipe.data.max_lines,
        )

        # Materialize filtered to an intermediate (needed for dedupe stage).
        interim = out / "_interim.jsonl"
        n_filtered = write_pairs(interim, filtered_iter)

        # 2. dedupe
        if self.recipe.data.dedupe == "exact":
            deduped = list(exact_dedupe(iter_pairs(interim)))
        elif self.recipe.data.dedupe == "minhash":
            deduped = list(minhash_dedupe(iter_pairs(interim)))
        else:
            deduped = list(iter_pairs(interim))
        dedupe_dropped = n_filtered - len(deduped)

        # 3. split
        spec = SplitSpec(
            train=self.recipe.data.train_split,
            val=self.recipe.data.val_split,
            test=self.recipe.data.test_split,
            seed=self.recipe.data.shuffle_seed,
        )
        counts = deterministic_split(deduped, out, spec)

        # 4. stats per split
        stats = {}
        for split in ("train", "val", "test"):
            p = out / f"{split}.jsonl"
            stats[split] = stats_for(p).to_dict() if p.exists() else {}

        # 5. cleanup
        try:
            interim.unlink()
        except OSError:
            pass

        result = PreprocessResult(
            out_dir=out,
            counts=counts,
            filter_report=report,
            dedupe_dropped=dedupe_dropped,
            final_total=sum(counts.values()),
            stats_train=stats["train"],
            stats_val=stats["val"],
            stats_test=stats["test"],
        )
        (out / "preprocess_report.json").write_text(
            json.dumps(result.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )
        log.info("preprocess.done", **{k: v for k, v in result.to_dict().items() if k != "filter_report"})
        return result
