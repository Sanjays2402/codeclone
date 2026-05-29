"""LoRA fine-tune driver. MLX (default Darwin/arm64) and PEFT (CUDA) backends."""

from .driver import Trainer, TrainResult, TrainError
from .backends.base import TrainBackend, BackendError, TrainBatch, StepMetrics
from .data_loader import JsonlPairLoader, format_for_training
from .run_log import RunLog

__all__ = [
    "Trainer",
    "TrainResult",
    "TrainError",
    "TrainBackend",
    "BackendError",
    "TrainBatch",
    "StepMetrics",
    "JsonlPairLoader",
    "format_for_training",
    "RunLog",
]
