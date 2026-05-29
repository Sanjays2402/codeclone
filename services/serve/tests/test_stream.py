"""Streaming/SSE tests for the serve adapters."""

import json

from fastapi.testclient import TestClient

from codeclone_serve.app import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def _h():
    return {"Authorization": "Bearer sk-test-key"}


def test_chat_stream_emits_sse():
    c = _client()
    body = {
        "model": "codeclone",
        "messages": [{"role": "user", "content": "hello"}],
        "max_tokens": 8,
        "stream": True,
    }
    with c.stream("POST", "/v1/chat/completions", json=body, headers=_h()) as resp:
        assert resp.status_code == 200
        events = list(resp.iter_lines())
    payloads = [e for e in events if e.startswith("data:")]
    assert any("[DONE]" in p for p in payloads)
    # At least one parseable chunk before DONE.
    parsed = []
    for p in payloads:
        if "[DONE]" in p:
            continue
        try:
            parsed.append(json.loads(p[len("data:") :].strip()))
        except Exception:
            continue
    assert parsed
    assert parsed[0]["object"] == "chat.completion.chunk"


def test_text_stream_emits_sse():
    c = _client()
    body = {
        "model": "codeclone",
        "prompt": "def x():",
        "max_tokens": 8,
        "stream": True,
    }
    with c.stream("POST", "/v1/completions", json=body, headers=_h()) as resp:
        assert resp.status_code == 200
        lines = list(resp.iter_lines())
    assert any("[DONE]" in l for l in lines)
