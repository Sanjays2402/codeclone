"""JSONL run log + optional MLflow forwarding."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class RunLog:
    run_dir: Path
    use_mlflow: bool = False
    _mlflow_run: Any = None

    def __post_init__(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._metrics_path = self.run_dir / "metrics.jsonl"
        if self.use_mlflow and os.environ.get("MLFLOW_TRACKING_URI"):
            try:
                import mlflow  # type: ignore

                mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
                self._mlflow_run = mlflow.start_run(run_name=self.run_dir.name)
            except Exception:
                self._mlflow_run = None

    def log_params(self, params: dict) -> None:
        (self.run_dir / "params.json").write_text(
            json.dumps(params, indent=2, sort_keys=True, default=str), encoding="utf-8"
        )
        if self._mlflow_run is not None:
            try:
                import mlflow  # type: ignore

                mlflow.log_params({k: str(v)[:250] for k, v in params.items()})
            except Exception:
                pass

    def log_metrics(self, step: int, metrics: dict) -> None:
        row = {"step": step, **metrics}
        with self._metrics_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, default=float))
            f.write("\n")
        if self._mlflow_run is not None:
            try:
                import mlflow  # type: ignore

                mlflow.log_metrics({k: v for k, v in metrics.items() if isinstance(v, (int, float))}, step=step)
            except Exception:
                pass

    def close(self) -> None:
        if self._mlflow_run is not None:
            try:
                import mlflow  # type: ignore

                mlflow.end_run()
            except Exception:
                pass
