"""Length and content filters for pairs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Iterator

from codeclone_dataset.pairs import Pair


@dataclass
class FilterReport:
    kept: int = 0
    dropped_short: int = 0
    dropped_long: int = 0
    dropped_lang: int = 0
    dropped_other: int = 0
    by_language: dict[str, int] = field(default_factory=dict)

    def total_dropped(self) -> int:
        return self.dropped_short + self.dropped_long + self.dropped_lang + self.dropped_other

    def to_dict(self) -> dict:
        return {
            "kept": self.kept,
            "dropped_short": self.dropped_short,
            "dropped_long": self.dropped_long,
            "dropped_lang": self.dropped_lang,
            "dropped_other": self.dropped_other,
            "by_language": dict(sorted(self.by_language.items())),
        }


def drop_too_short(pair: Pair, min_lines: int) -> bool:
    return (pair.completion.count("\n") + 1) < min_lines


def drop_too_long(pair: Pair, max_lines: int) -> bool:
    return (pair.completion.count("\n") + 1) > max_lines


def apply_filters(
    pairs: Iterable[Pair],
    *,
    languages: set[str],
    min_lines: int,
    max_lines: int,
) -> tuple[Iterator[Pair], FilterReport]:
    """Apply the standard filter stack. Returns an iterator and a mutable report.

    The report is updated as the iterator is consumed.
    """
    report = FilterReport()

    def _gen() -> Iterator[Pair]:
        for p in pairs:
            if p.language not in languages:
                report.dropped_lang += 1
                continue
            if drop_too_short(p, min_lines):
                report.dropped_short += 1
                continue
            if drop_too_long(p, max_lines):
                report.dropped_long += 1
                continue
            if not p.completion.strip():
                report.dropped_other += 1
                continue
            report.kept += 1
            report.by_language[p.language] = report.by_language.get(p.language, 0) + 1
            yield p

    return _gen(), report
