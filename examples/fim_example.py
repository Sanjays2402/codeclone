"""Demonstrate FIM (Fill-in-the-Middle) request shape, like a tab-autocomplete."""

from __future__ import annotations

import os

import httpx


BASE = os.environ.get("CODECLONE_BASE", "http://127.0.0.1:7461")
KEY = os.environ.get("CODECLONE_API_KEY", "sk-codeclone-local")


def main() -> None:
    body = {
        "model": "codeclone",
        "prompt": "",
        "fim_prefix": "def add(a: int, b: int) -> int:\n    ",
        "fim_suffix": "\n    return result\n",
        "max_tokens": 24,
        "temperature": 0.0,
    }
    r = httpx.post(
        f"{BASE}/v1/completions",
        headers={"Authorization": f"Bearer {KEY}"},
        json=body,
        timeout=30.0,
    )
    r.raise_for_status()
    j = r.json()
    print(j["choices"][0]["text"])


if __name__ == "__main__":
    main()
