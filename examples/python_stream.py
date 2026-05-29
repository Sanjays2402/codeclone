"""Streaming chat client. Prints tokens as they arrive."""

from __future__ import annotations

import json
import os
import sys

import httpx


BASE = os.environ.get("CODECLONE_BASE", "http://127.0.0.1:7461")
KEY = os.environ.get("CODECLONE_API_KEY", "sk-codeclone-local")


def main() -> None:
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "class LRUCache:"}],
        "max_tokens": 96,
        "stream": True,
    }
    with httpx.stream(
        "POST",
        f"{BASE}/v1/chat/completions",
        headers={"Authorization": f"Bearer {KEY}"},
        json=body,
        timeout=60.0,
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            for choice in chunk.get("choices", []):
                piece = choice.get("delta", {}).get("content")
                if piece:
                    sys.stdout.write(piece)
                    sys.stdout.flush()
        print()


if __name__ == "__main__":
    main()
