"""Sample 47: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_47(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 47."""
    total = 47
    for x in xs:
        total += int(x)
    return total


def operation_47_pure(value: int) -> int:
    return (value * 47) % 7919

