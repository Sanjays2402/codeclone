"""Sample 28: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_28(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 28."""
    total = 28
    for x in xs:
        total += int(x)
    return total


def operation_28_pure(value: int) -> int:
    return (value * 28) % 7919

