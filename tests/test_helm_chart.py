"""Helm chart rendering tests.

These exercise the codeclone Helm chart end-to-end with `helm template` so we
catch regressions in templates, values wiring, and the optional hardening
objects (NetworkPolicy, PodDisruptionBudget, ServiceMonitor, HPA).

Skipped automatically if the `helm` binary is not on PATH.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[1] / "infra" / "helm" / "codeclone"

pytestmark = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm binary not available"
)


def _render(*set_args: str) -> list[dict]:
    cmd = ["helm", "template", "codeclone", str(CHART_DIR)]
    for s in set_args:
        cmd.extend(["--set", s])
    out = subprocess.check_output(cmd, text=True)
    return [doc for doc in yaml.safe_load_all(out) if doc]


def _kinds(docs: list[dict]) -> set[str]:
    return {d.get("kind") for d in docs}


def test_default_render_has_core_objects() -> None:
    docs = _render()
    kinds = _kinds(docs)
    assert "Deployment" in kinds
    assert "Service" in kinds
    # Optional hardening objects are off by default.
    assert "NetworkPolicy" not in kinds
    assert "PodDisruptionBudget" not in kinds
    assert "ServiceMonitor" not in kinds
    assert "HorizontalPodAutoscaler" not in kinds


def test_networkpolicy_renders_when_enabled() -> None:
    docs = _render("networkPolicy.enabled=true")
    np = next(d for d in docs if d["kind"] == "NetworkPolicy")
    assert "Ingress" in np["spec"]["policyTypes"]
    assert "Egress" in np["spec"]["policyTypes"]
    # Default egress allows DNS + public HTTPS (model pulls) but blocks RFC1918.
    egress = np["spec"]["egress"]
    assert any(
        any(p.get("port") == 53 for p in rule.get("ports", []))
        for rule in egress
    ), "expected DNS egress rule"
    assert any(
        any(p.get("port") == 443 for p in rule.get("ports", []))
        for rule in egress
    ), "expected HTTPS egress rule"


def test_pdb_renders_when_enabled() -> None:
    docs = _render("podDisruptionBudget.enabled=true")
    pdb = next(d for d in docs if d["kind"] == "PodDisruptionBudget")
    assert pdb["spec"]["minAvailable"] == 1
    assert pdb["spec"]["selector"]["matchLabels"]["app.kubernetes.io/name"] == "codeclone"


def test_servicemonitor_renders_when_enabled() -> None:
    docs = _render(
        "serviceMonitor.enabled=true",
        "serviceMonitor.additionalLabels.release=kube-prometheus-stack",
    )
    sm = next(d for d in docs if d["kind"] == "ServiceMonitor")
    assert sm["spec"]["endpoints"][0]["path"] == "/metrics"
    assert sm["spec"]["endpoints"][0]["port"] == "http"
    assert sm["metadata"]["labels"]["release"] == "kube-prometheus-stack"


def test_hpa_renders_when_enabled() -> None:
    docs = _render("autoscaling.enabled=true")
    hpa = next(d for d in docs if d["kind"] == "HorizontalPodAutoscaler")
    assert hpa["spec"]["minReplicas"] == 1
    assert hpa["spec"]["maxReplicas"] == 3


def test_helm_test_hook_renders_by_default() -> None:
    """The `helm test` smoke-test pod should ship enabled by default."""
    docs = _render()
    test_pods = [
        d
        for d in docs
        if d.get("kind") == "Pod"
        and d.get("metadata", {}).get("annotations", {}).get("helm.sh/hook") == "test"
    ]
    assert len(test_pods) == 1, "expected exactly one helm test hook pod"
    pod = test_pods[0]

    # Hook lifecycle: pod is recreated on each `helm test` invocation and
    # auto-removed after success, kept after failure for log access.
    delete_policy = pod["metadata"]["annotations"]["helm.sh/hook-delete-policy"]
    assert "before-hook-creation" in delete_policy
    assert "hook-succeeded" in delete_policy

    spec = pod["spec"]
    assert spec["restartPolicy"] == "Never"
    container = spec["containers"][0]
    assert container["image"].startswith("busybox:")
    # The probe script must hit all three operator endpoints + the auth gate.
    script = " ".join(container["args"])
    assert "/healthz" in script
    assert "/readyz" in script
    assert "/metrics" in script
    assert "/v1/models" in script
    assert "codeclone_requests_total" in script
    # Resource ceiling stays tiny so the smoke test cannot starve the release.
    assert container["resources"]["limits"]["memory"] == "64Mi"


def test_helm_test_hook_can_be_disabled() -> None:
    docs = _render("tests.enabled=false")
    assert not [
        d
        for d in docs
        if d.get("kind") == "Pod"
        and d.get("metadata", {}).get("annotations", {}).get("helm.sh/hook") == "test"
    ], "tests.enabled=false should omit the helm test pod"
