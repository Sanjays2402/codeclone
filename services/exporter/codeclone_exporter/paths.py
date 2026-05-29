"""Path filters for source files (generated, vendored, lockfiles)."""

from __future__ import annotations

import re
from pathlib import Path


GENERATED_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(^|/)(dist|build|out|node_modules|vendor|third_party|target)/"),
    re.compile(r"\.min\.(js|css)$"),
    re.compile(r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$"),
    re.compile(r"\.(map|snap|lock|bundle\.js|d\.ts\.map)$"),
    re.compile(r"(^|/)__generated__/"),
    re.compile(r"(^|/)\.next/"),
    re.compile(r"(^|/)\.cache/"),
]


def is_generated(path: str) -> bool:
    return any(p.search(path) for p in GENERATED_PATTERNS)


def filename_only(path: str) -> str:
    return Path(path).name
