"""Readiness + liveness probe tests.

Covers the gap that was previously stubbed: `/readyz` always returned 200
regardless of model state, which defeats the purpose of a k8s readiness
probe (kube-proxy would route traffic to a broken pod).
"""

from __future__ import annotations

from codeclone_serve.app import create_app
from codeclone_serve.readiness import ReadinessProbe
from fastapi.testclient import TestClient


def _client() -> TestClient:
    return TestClient(create_app(model_dir=None, model_name="codeclone-test"))


def test_health_and_healthz_both_serve_liveness():
    c = _client()
    for path in ("/health", "/healthz"):
        r = c.get(path)
        assert r.status_code == 200, path
        body = r.json()
        assert body["status"] == "ok"
        assert body["model"] == "codeclone-test"
        assert body["shutting_down"] is False


def test_ready_and_readyz_return_200_when_handle_works():
    c = _client()
    for path in ("/ready", "/readyz"):
        r = c.get(path)
        assert r.status_code == 200, path
        body = r.json()
        assert body["status"] == "ready"
        assert body["reason"] == "ready"
        # Handle probe timing was actually measured.
        assert "model_ms" in body


def test_ready_returns_503_after_shutdown_signal():
    app = create_app(model_dir=None, model_name="codeclone-test")
    c = TestClient(app)
    # Liveness must keep returning 200 so kubelet does not restart-loop us.
    assert c.get("/healthz").status_code == 200

    app.state.readiness.begin_shutdown()

    r = c.get("/readyz")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "not_ready"
    assert body["reason"] == "shutting_down"

    # Liveness still ok during drain so the pod is not killed mid-request.
    h = c.get("/healthz")
    assert h.status_code == 200
    assert h.json()["shutting_down"] is True


def test_ready_returns_503_when_handle_probe_raises():
    def bad_probe() -> None:
        raise RuntimeError("tokenizer not loaded")

    probe = ReadinessProbe(bad_probe, install_signal_handler=False)
    result = probe.check()
    assert result.ok is False
    assert "model_probe_failed" in result.reason
    assert "tokenizer not loaded" in result.details.get("model_error", "")


def test_readiness_dependency_check_failure():
    def good_handle() -> None:
        return None

    probe = ReadinessProbe(good_handle, install_signal_handler=False)
    probe.register_dependency("db", lambda: (_ for _ in ()).throw(OSError("conn refused")))
    result = probe.check()
    assert result.ok is False
    assert result.reason == "dependency_failed:db"


def test_readiness_result_cached():
    calls = {"n": 0}

    def counting_probe() -> None:
        calls["n"] += 1

    probe = ReadinessProbe(counting_probe, cache_seconds=60.0, install_signal_handler=False)
    probe.check()
    probe.check()
    probe.check()
    assert calls["n"] == 1
