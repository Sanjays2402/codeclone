"""Common training backend abstractions."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Protocol


class BackendError(RuntimeError):
    pass


@dataclass
class TrainBatch:
    inputs: list[str]
    targets: list[str]


@dataclass
class StepMetrics:
    step: int
    loss: float
    learning_rate: float
    tokens_seen: int = 0
    extra: dict | None = None


class TrainBackend(Protocol):
    name: str

    def prepare(self, base_model: str, lora_config: dict, train_config: dict) -> None: ...

    def train(
        self,
        batches: Iterable[TrainBatch],
        max_steps: int,
        eval_batches: Iterable[TrainBatch] | None = None,
        eval_every: int = 100,
    ) -> Iterable[StepMetrics]: ...

    def save_adapter(self, out_dir: Path) -> None: ...
