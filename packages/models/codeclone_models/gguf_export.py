"""GGUF export wrapper around llama.cpp's `convert-hf-to-gguf.py`.

This only orchestrates; the conversion script must be present on the system.
We look for it in (a) `LLAMA_CPP_DIR` env, (b) `~/llama.cpp`, (c) PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Literal


class GgufExportError(RuntimeError):
    pass


Quant = Literal["f16", "q8_0", "q5_k_m", "q4_k_m", "q3_k_m"]


def _find_convert_script() -> Path:
    env = os.environ.get("LLAMA_CPP_DIR")
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env) / "convert-hf-to-gguf.py")
        candidates.append(Path(env) / "convert_hf_to_gguf.py")
    home = Path.home()
    candidates += [
        home / "llama.cpp" / "convert-hf-to-gguf.py",
        home / "llama.cpp" / "convert_hf_to_gguf.py",
    ]
    for c in candidates:
        if c.exists():
            return c
    raise GgufExportError(
        "could not locate llama.cpp convert-hf-to-gguf.py; "
        "set LLAMA_CPP_DIR or clone llama.cpp into ~/llama.cpp"
    )


def export_gguf(
    merged_model_dir: str | Path,
    out_path: str | Path,
    quant: Quant = "q4_k_m",
) -> Path:
    """Convert a merged HF checkpoint to a GGUF file (quantized)."""
    src = Path(merged_model_dir)
    dst = Path(out_path)
    if not src.exists():
        raise GgufExportError(f"merged model dir not found: {src}")

    convert = _find_convert_script()
    f16_path = dst.with_suffix(".f16.gguf")
    cmd = [
        "python",
        str(convert),
        str(src),
        "--outfile",
        str(f16_path),
        "--outtype",
        "f16",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise GgufExportError(f"convert failed: {proc.stderr.strip()}")

    if quant == "f16":
        if f16_path != dst:
            shutil.move(str(f16_path), str(dst))
        return dst

    quantize = shutil.which("llama-quantize") or shutil.which("quantize")
    if quantize is None:
        raise GgufExportError(
            "llama-quantize (or quantize) not found on PATH; "
            "build llama.cpp tools to quantize"
        )
    qproc = subprocess.run(
        [quantize, str(f16_path), str(dst), quant], capture_output=True, text=True
    )
    if qproc.returncode != 0:
        raise GgufExportError(f"quantize failed: {qproc.stderr.strip()}")
    try:
        f16_path.unlink()
    except OSError:
        pass
    return dst
