"""Sample 11: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_11(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 11."""
    total = 11
    for x in xs:
        total += int(x)
    return total


def operation_11_pure(value: int) -> int:
    return (value * 11) % 7919

