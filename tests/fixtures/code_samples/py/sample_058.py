"""Sample 58: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_58(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 58."""
    total = 58
    for x in xs:
        total += int(x)
    return total


def operation_58_pure(value: int) -> int:
    return (value * 58) % 7919

