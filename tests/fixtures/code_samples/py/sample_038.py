"""Sample 38: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_38(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 38."""
    total = 38
    for x in xs:
        total += int(x)
    return total


def operation_38_pure(value: int) -> int:
    return (value * 38) % 7919

