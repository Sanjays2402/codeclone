"""Sample 53: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_53(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 53."""
    total = 53
    for x in xs:
        total += int(x)
    return total


def operation_53_pure(value: int) -> int:
    return (value * 53) % 7919

