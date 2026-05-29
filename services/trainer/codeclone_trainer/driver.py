"""Top-level Trainer: pick backend, load data, run loop, save adapter + meta."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from codeclone_config.logging import get_logger
from codeclone_config.recipes import Recipe, recipe_hash
from codeclone_models.registry import CheckpointMeta, CheckpointRegistry

from .backends.base import StepMetrics, TrainBackend, TrainBatch
from .backends.mlx_backend import MlxBackend
from .backends.peft_backend import PeftBackend
from .data_loader import JsonlPairLoader
from .run_log import RunLog


log = get_logger(__name__)


class TrainError(RuntimeError):
    pass


@dataclass
class TrainResult:
    adapter_dir: Path
    run_dir: Path
    final_train_loss: float
    final_val_loss: float | None
    n_steps: int
    recipe_hash: str

    def to_dict(self) -> dict:
        return {
            "adapter_dir": str(self.adapter_dir),
            "run_dir": str(self.run_dir),
            "final_train_loss": self.final_train_loss,
            "final_val_loss": self.final_val_loss,
            "n_steps": self.n_steps,
            "recipe_hash": self.recipe_hash,
        }


def _pick_backend(name: str, seed: int) -> TrainBackend:
    if name == "mlx":
        return MlxBackend(seed=seed)
    if name == "peft":
        return PeftBackend(seed=seed)
    raise TrainError(f"unknown backend: {name}")


@dataclass
class Trainer:
    recipe: Recipe
    adapter_name: str
    adapters_root: Path
    runs_root: Path

    def run(
        self,
        train_jsonl: str | Path,
        val_jsonl: str | Path | None = None,
        backend_name: str = "auto",
    ) -> TrainResult:
        # Resolve backend (recipe overrides argument if argument is "auto").
        chosen = self.recipe.train.backend if backend_name == "auto" else backend_name
        if chosen == "auto":
            import platform

            chosen = "mlx" if (platform.system() == "Darwin" and platform.machine() == "arm64") else "peft"

        backend = _pick_backend(chosen, seed=self.recipe.train.seed)
        rhash = recipe_hash(self.recipe)
        run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{rhash}"
        run_dir = self.runs_root / run_id
        adapter_dir = self.adapters_root / self.adapter_name

        log.info(
            "trainer.start",
            backend=chosen,
            recipe=self.recipe.name,
            recipe_hash=rhash,
            adapter=self.adapter_name,
            max_steps=self.recipe.train.max_steps,
        )

        lora_cfg = {
            "rank": self.recipe.model.lora_rank,
            "alpha": self.recipe.model.lora_alpha,
            "dropout": self.recipe.model.lora_dropout,
            "target_modules": self.recipe.model.lora_target_modules,
        }
        train_cfg = {
            "learning_rate": self.recipe.train.learning_rate,
            "batch_size": self.recipe.train.batch_size,
            "grad_accum": self.recipe.train.grad_accum,
            "context_length": self.recipe.model.context_length,
            "warmup_steps": self.recipe.train.warmup_steps,
            "bf16": self.recipe.train.bf16,
            "seed": self.recipe.train.seed,
        }
        backend.prepare(self.recipe.model.base, lora_cfg, train_cfg)

        train_loader = JsonlPairLoader(
            path=Path(train_jsonl),
            batch_size=self.recipe.train.batch_size,
            seed=self.recipe.train.seed,
            shuffle=True,
        )
        val_loader: Iterable[TrainBatch] | None = None
        if val_jsonl is not None and Path(val_jsonl).exists():
            val_loader = JsonlPairLoader(
                path=Path(val_jsonl),
                batch_size=self.recipe.train.batch_size,
                seed=self.recipe.train.seed,
                shuffle=False,
            )

        run_log = RunLog(run_dir=run_dir, use_mlflow=True)
        run_log.log_params(
            {
                "recipe": self.recipe.to_dict(),
                "recipe_hash": rhash,
                "backend": chosen,
                "adapter_name": self.adapter_name,
            }
        )

        final_loss = float("nan")
        last_step = 0
        try:
            for m in backend.train(
                batches=train_loader.iter_batches(),
                max_steps=self.recipe.train.max_steps,
                eval_batches=(iter(val_loader) if val_loader else None),  # type: ignore[arg-type]
                eval_every=self.recipe.train.eval_every,
            ):
                last_step = m.step
                final_loss = m.loss
                run_log.log_metrics(
                    m.step,
                    {
                        "loss": m.loss,
                        "lr": m.learning_rate,
                        "tokens_seen": m.tokens_seen,
                    },
                )
        finally:
            backend.save_adapter(adapter_dir)
            run_log.close()

        # Register the checkpoint.
        registry = CheckpointRegistry(self.adapters_root)
        meta = CheckpointMeta(
            name=self.adapter_name,
            base_model=self.recipe.model.base,
            backend=chosen,
            recipe_hash=rhash,
            created_at=registry.now_iso(),
            n_train_pairs=0,
            n_val_pairs=0,
            final_train_loss=final_loss,
            final_val_loss=None,
            seed=self.recipe.train.seed,
            tags=[self.recipe.name],
            extra={"run_id": run_id},
        )
        registry.register(meta)

        log.info(
            "trainer.done",
            adapter=str(adapter_dir),
            steps=last_step,
            final_loss=final_loss,
        )
        return TrainResult(
            adapter_dir=adapter_dir,
            run_dir=run_dir,
            final_train_loss=final_loss,
            final_val_loss=None,
            n_steps=last_step,
            recipe_hash=rhash,
        )
