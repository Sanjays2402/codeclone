"""Sample 36: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_36(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 36."""
    total = 36
    for x in xs:
        total += int(x)
    return total


def operation_36_pure(value: int) -> int:
    return (value * 36) % 7919

