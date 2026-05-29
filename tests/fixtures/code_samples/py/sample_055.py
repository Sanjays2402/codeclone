"""Sample 55: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_55(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 55."""
    total = 55
    for x in xs:
        total += int(x)
    return total


def operation_55_pure(value: int) -> int:
    return (value * 55) % 7919

