"""Adapter merge driver.

Two paths:

* MLX: shells out to `mlx_lm.fuse` (if installed).
* PEFT: uses `peft.PeftModel.merge_and_unload` + `model.save_pretrained`.

Both paths are lazy-imported so this module is cheap to load.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Literal


Backend = Literal["mlx", "peft"]


class MergeError(RuntimeError):
    pass


def merge_adapter(
    base_model: str,
    adapter_dir: str | Path,
    out_dir: str | Path,
    backend: Backend = "peft",
) -> Path:
    """Merge a LoRA adapter into the base weights, write a standalone checkpoint.

    Returns the output path.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    adapter_dir = Path(adapter_dir)
    if not adapter_dir.exists():
        raise MergeError(f"adapter dir does not exist: {adapter_dir}")

    if backend == "mlx":
        return _merge_mlx(base_model, adapter_dir, out)
    if backend == "peft":
        return _merge_peft(base_model, adapter_dir, out)
    raise MergeError(f"unknown backend: {backend}")


def _merge_mlx(base_model: str, adapter_dir: Path, out: Path) -> Path:
    if shutil.which("mlx_lm.fuse") is None:
        raise MergeError(
            "mlx_lm.fuse not found on PATH. Install with: pip install mlx-lm"
        )
    cmd = [
        "mlx_lm.fuse",
        "--model",
        base_model,
        "--adapter-path",
        str(adapter_dir),
        "--save-path",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise MergeError(f"mlx_lm.fuse failed: {proc.stderr.strip()}")
    return out


def _merge_peft(base_model: str, adapter_dir: Path, out: Path) -> Path:
    try:
        from peft import PeftModel  # type: ignore
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    except ImportError as e:
        raise MergeError(
            "peft + transformers required for peft merge backend"
        ) from e

    model = AutoModelForCausalLM.from_pretrained(base_model)
    tok = AutoTokenizer.from_pretrained(base_model)
    merged = PeftModel.from_pretrained(model, str(adapter_dir)).merge_and_unload()
    merged.save_pretrained(str(out))
    tok.save_pretrained(str(out))
    return out
