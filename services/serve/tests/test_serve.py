from fastapi.testclient import TestClient

from codeclone_serve.app import create_app
from codeclone_serve.schemas import ChatCompletionRequest


def _client() -> TestClient:
    app = create_app(model_dir=None, model_name="codeclone-test")
    return TestClient(app)


def _h(extra: dict | None = None) -> dict:
    h = {"Authorization": "Bearer sk-test-key"}
    if extra:
        h.update(extra)
    return h


def test_healthz_open():
    c = _client()
    r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_unauth_blocks_v1():
    c = _client()
    r = c.get("/v1/models")
    assert r.status_code == 401


def test_models_list_authed():
    c = _client()
    r = c.get("/v1/models", headers=_h())
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()["data"]]
    assert any("codeclone" in i for i in ids)


def test_chat_completion_basic():
    c = _client()
    body = {
        "model": "codeclone",
        "messages": [
            {"role": "system", "content": "you are a helpful coding assistant"},
            {"role": "user", "content": "def add(a, b):\n    return"},
        ],
        "max_tokens": 32,
    }
    r = c.post("/v1/chat/completions", json=body, headers=_h())
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["object"] == "chat.completion"
    assert j["choices"][0]["message"]["role"] == "assistant"
    assert j["usage"]["total_tokens"] >= 0


def test_text_completion_basic():
    c = _client()
    body = {"model": "codeclone", "prompt": "def add(a, b):\n    ", "max_tokens": 16}
    r = c.post("/v1/completions", json=body, headers=_h())
    assert r.status_code == 200
    j = r.json()
    assert j["object"] == "text_completion"
    assert "text" in j["choices"][0]


def test_completion_with_fim():
    c = _client()
    body = {
        "model": "codeclone",
        "prompt": "",
        "fim_prefix": "def add(a, b):\n    ",
        "fim_suffix": "\n    return result\n",
        "max_tokens": 8,
    }
    r = c.post("/v1/completions", json=body, headers=_h())
    assert r.status_code == 200


def test_metrics_endpoint():
    c = _client()
    c.get("/healthz")
    r = c.get("/metrics")
    assert r.status_code == 200
    assert b"codeclone_requests_total" in r.content
