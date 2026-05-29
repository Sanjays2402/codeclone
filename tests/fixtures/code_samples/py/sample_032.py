"""Sample 32: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_32(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 32."""
    total = 32
    for x in xs:
        total += int(x)
    return total


def operation_32_pure(value: int) -> int:
    return (value * 32) % 7919

