"""Pytest cases covering the streaming SSE shape end-to-end with JSON parsing."""

import json

from fastapi.testclient import TestClient

from codeclone_serve.app import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def _hdr():
    return {"Authorization": "Bearer sk-test-key"}


def test_chat_stream_chunks_parse_correctly():
    c = _client()
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "def reverse(s):"}],
        "max_tokens": 12,
        "stream": True,
    }
    chunks = []
    with c.stream("POST", "/v1/chat/completions", json=body, headers=_hdr()) as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if payload == "[DONE]":
                break
            chunks.append(json.loads(payload))
    assert chunks
    # First chunk carries the role.
    assert chunks[0]["choices"][0]["delta"].get("role") == "assistant"
    # Some intermediate chunk has content.
    contents = [c_["choices"][0]["delta"].get("content") for c_ in chunks]
    assert any(c is not None for c in contents)
    # Final chunk has a finish_reason of "stop".
    assert chunks[-1]["choices"][0].get("finish_reason") == "stop"


def test_text_stream_yields_text_completion_object():
    c = _client()
    body = {"model": "codeclone", "prompt": "def add(a, b):\n    ", "max_tokens": 8, "stream": True}
    objs = []
    with c.stream("POST", "/v1/completions", json=body, headers=_hdr()) as r:
        for line in r.iter_lines():
            if line.startswith("data:") and "[DONE]" not in line:
                objs.append(json.loads(line[len("data:") :].strip()))
    assert objs
    assert all(o["object"] == "text_completion" for o in objs)
    assert objs[-1]["choices"][0]["finish_reason"] == "stop"
