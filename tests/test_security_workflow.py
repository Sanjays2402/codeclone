"""Sanity tests for the supply-chain security workflow.

These tests do not actually run pip-audit or trivy (CI does that).
They guard against accidental regressions in the workflow YAML, the
gitleaks config, and the local scan script: every job is wired up,
the gitleaks allowlist still excludes documented placeholders, and
the local script is executable and references the expected tools.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "security.yml"
GITLEAKS_CFG = REPO_ROOT / ".gitleaks.toml"
SCAN_SCRIPT = REPO_ROOT / "scripts" / "security_scan.sh"


def _load_workflow() -> dict:
    assert WORKFLOW.exists(), f"missing workflow: {WORKFLOW}"
    return yaml.safe_load(WORKFLOW.read_text())


def test_workflow_defines_expected_jobs() -> None:
    wf = _load_workflow()
    jobs = wf.get("jobs", {})
    expected = {"python-deps", "sbom", "trivy-fs", "trivy-config", "gitleaks"}
    missing = expected - set(jobs)
    assert not missing, f"security workflow missing jobs: {sorted(missing)}"


def test_workflow_runs_on_push_pr_and_schedule() -> None:
    wf = _load_workflow()
    # PyYAML parses bare `on:` as the boolean True, hence the fallback.
    triggers = wf.get("on") or wf.get(True)
    assert triggers, "workflow has no triggers"
    assert "push" in triggers
    assert "pull_request" in triggers
    assert "schedule" in triggers, "weekly schedule keeps CVE surface fresh"


def test_pip_audit_job_is_strict() -> None:
    wf = _load_workflow()
    steps = wf["jobs"]["python-deps"]["steps"]
    run_lines = "\n".join(s.get("run", "") for s in steps)
    assert "pip-audit" in run_lines
    assert "--strict" in run_lines, "pip-audit must fail on fixable vulns"


def test_trivy_fs_uploads_sarif() -> None:
    wf = _load_workflow()
    steps = wf["jobs"]["trivy-fs"]["steps"]
    actions = [s.get("uses", "") for s in steps]
    assert any("aquasecurity/trivy-action" in a for a in actions)
    assert any("codeql-action/upload-sarif" in a for a in actions), (
        "SARIF upload feeds the GitHub Security tab"
    )


def test_gitleaks_config_allowlists_documented_placeholders() -> None:
    assert GITLEAKS_CFG.exists(), "gitleaks config missing"
    text = GITLEAKS_CFG.read_text()
    # Hard-coded placeholders that live in .env.example / docs / README.
    for needle in ("ghp_replace_me", "sk-codeclone-local", ".env.example"):
        assert needle in text, f"gitleaks config no longer covers {needle!r}"


def test_local_scan_script_is_executable_and_runs_expected_tools() -> None:
    assert SCAN_SCRIPT.exists(), "scripts/security_scan.sh missing"
    mode = SCAN_SCRIPT.stat().st_mode
    assert mode & stat.S_IXUSR, "scripts/security_scan.sh must be executable"
    text = SCAN_SCRIPT.read_text()
    for tool in ("pip-audit", "cyclonedx-py", "trivy", "gitleaks"):
        assert tool in text, f"local scan no longer references {tool}"


def test_makefile_exposes_security_target() -> None:
    makefile = (REPO_ROOT / "Makefile").read_text()
    assert "security:" in makefile, "Make target `security` keeps the local entrypoint discoverable"
    assert "scripts/security_scan.sh" in makefile


def test_repo_root_resolved_correctly() -> None:
    # Guard against accidental layout changes that would silently no-op the suite.
    assert (REPO_ROOT / "pyproject.toml").exists()
    assert os.path.basename(REPO_ROOT) == "codeclone" or (REPO_ROOT / ".git").exists()
