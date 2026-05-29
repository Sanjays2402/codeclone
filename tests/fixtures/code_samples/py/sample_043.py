"""Sample 43: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_43(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 43."""
    total = 43
    for x in xs:
        total += int(x)
    return total


def operation_43_pure(value: int) -> int:
    return (value * 43) % 7919

