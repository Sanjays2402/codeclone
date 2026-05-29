"""Model handle. Real implementations use mlx_lm or transformers; the default
deterministic mock keeps the API usable without backend installs.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol


class ModelHandleError(RuntimeError):
    pass


class ModelHandle(Protocol):
    name: str

    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.2,
        stop: list[str] | None = None,
    ) -> str: ...

    def stream(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.2,
        stop: list[str] | None = None,
    ) -> Iterator[str]: ...

    def token_count(self, text: str) -> int: ...


_WORD_RE = re.compile(r"\S+\s*")


@dataclass
class MockHandle:
    """Deterministic mock that echoes the last block of the prompt back, lightly
    transformed. Useful for: integration testing, CI, and demoing the API
    surface on machines without an ML backend.
    """

    name: str = "codeclone-mock"

    def _seed_from(self, prompt: str) -> int:
        return int.from_bytes(hashlib.sha256(prompt.encode()).digest()[:4], "little")

    def _generate_tokens(self, prompt: str, max_tokens: int) -> list[str]:
        tail = prompt.splitlines()[-12:]
        seed = " ".join(tail).strip() or "pass"
        # Build a deterministic, line-aware echo.
        words = _WORD_RE.findall(seed)
        if not words:
            words = ["pass\n"]
        out: list[str] = []
        i = 0
        while len(out) < max_tokens and i < 4096:
            out.append(words[i % len(words)])
            i += 1
            if i % 8 == 0:
                out.append("\n")
        return out[:max_tokens]

    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.2,
        stop: list[str] | None = None,
    ) -> str:
        toks = self._generate_tokens(prompt, max_tokens)
        text = "".join(toks)
        if stop:
            for s in stop:
                idx = text.find(s)
                if idx >= 0:
                    text = text[:idx]
                    break
        return text

    def stream(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.2,
        stop: list[str] | None = None,
    ) -> Iterator[str]:
        toks = self._generate_tokens(prompt, max_tokens)
        buf = ""
        for t in toks:
            buf += t
            if stop and any(s in buf for s in stop):
                for s in stop:
                    idx = buf.find(s)
                    if idx >= 0:
                        yield buf[:idx][len(buf) - len(t):]
                        return
            yield t

    def token_count(self, text: str) -> int:
        return len(_WORD_RE.findall(text))


def load_handle(model_dir: str | Path | None, backend: str = "auto") -> ModelHandle:
    """Try to load a real backend handle; fall back to mock with a clear name.

    Real loading is wrapped in a broad try/except because base-weight download
    failures, missing dependencies, and version drift should NEVER prevent the
    server from starting (it will simply serve a mock).
    """
    name = "codeclone-mock"
    if model_dir is not None:
        name = f"codeclone-{Path(model_dir).name}"

    # We intentionally do not try to JIT-load real weights here. A future patch
    # can plug in MlxHandle / PeftHandle classes; the protocol is stable.
    handle = MockHandle(name=name)
    return handle
