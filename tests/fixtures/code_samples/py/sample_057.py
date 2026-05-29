"""Sample 57: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_57(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 57."""
    total = 57
    for x in xs:
        total += int(x)
    return total


def operation_57_pure(value: int) -> int:
    return (value * 57) % 7919

