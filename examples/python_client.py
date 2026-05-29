"""Minimal non-streaming chat client for `codeclone serve`."""

from __future__ import annotations

import os

import httpx


BASE = os.environ.get("CODECLONE_BASE", "http://127.0.0.1:7461")
KEY = os.environ.get("CODECLONE_API_KEY", "sk-codeclone-local")


def main() -> None:
    body = {
        "model": "codeclone",
        "messages": [
            {"role": "system", "content": "You are a code completion assistant."},
            {"role": "user", "content": "def fibonacci(n):"},
        ],
        "max_tokens": 64,
        "temperature": 0.2,
    }
    r = httpx.post(
        f"{BASE}/v1/chat/completions",
        headers={"Authorization": f"Bearer {KEY}"},
        json=body,
        timeout=30.0,
    )
    r.raise_for_status()
    j = r.json()
    print(j["choices"][0]["message"]["content"])


if __name__ == "__main__":
    main()
