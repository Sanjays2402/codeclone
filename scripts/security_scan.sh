#!/usr/bin/env bash
# Local mirror of the `security` GitHub Actions workflow.
#
# Runs:
#   1. pip-audit against the active environment (Python deps).
#   2. CycloneDX SBOM generation to sbom.cdx.json.
#   3. trivy filesystem scan (HIGH,CRITICAL, --ignore-unfixed) when trivy is installed.
#   4. trivy config scan over infra/ (Dockerfile + Helm + k8s) when trivy is installed.
#   5. gitleaks against the working tree when gitleaks is installed.
#
# Tools that are not installed are skipped with a warning instead of failing
# the whole run, so a contributor can get partial signal without installing
# everything. CI installs them all and runs strictly.
#
# Exit codes:
#   0  every tool that ran reported clean
#   1  at least one tool that ran reported a finding (or pip-audit was missing,
#      which we treat as a hard requirement since `uv pip install pip-audit`
#      is one command)

set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rc=0
ran=0
failed=()

note() { printf "\n=== %s ===\n" "$*"; }
warn() { printf "warn: %s\n" "$*" >&2; }
fail() { rc=1; failed+=("$1"); }

# 1. pip-audit (required)
if command -v pip-audit >/dev/null 2>&1; then
  note "pip-audit (python deps)"
  ran=$((ran+1))
  if ! pip-audit --strict --progress-spinner off; then
    fail "pip-audit"
  fi
else
  warn "pip-audit not installed (pip install pip-audit). Treating as failure."
  fail "pip-audit (missing)"
fi

# 2. CycloneDX SBOM (best-effort)
if command -v cyclonedx-py >/dev/null 2>&1; then
  note "SBOM (cyclonedx-py)"
  ran=$((ran+1))
  if cyclonedx-py environment --output-format json --output-file sbom.cdx.json; then
    printf "wrote sbom.cdx.json\n"
  else
    fail "cyclonedx-py"
  fi
else
  warn "cyclonedx-py not installed (pip install cyclonedx-bom). Skipping SBOM."
fi

# 3 + 4. trivy (best-effort)
if command -v trivy >/dev/null 2>&1; then
  note "trivy fs (HIGH,CRITICAL, ignore-unfixed)"
  ran=$((ran+1))
  if ! trivy fs --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 --no-progress .; then
    fail "trivy fs"
  fi

  note "trivy config (infra/) - informational"
  ran=$((ran+1))
  # Informational: do not fail the script on infra findings, just print them.
  trivy config --severity HIGH,CRITICAL --no-progress infra || true
else
  warn "trivy not installed (brew install trivy). Skipping container/IaC scans."
fi

# 5. gitleaks (best-effort)
if command -v gitleaks >/dev/null 2>&1; then
  note "gitleaks (working tree)"
  ran=$((ran+1))
  if ! gitleaks detect --no-banner --redact --config .gitleaks.toml --source .; then
    fail "gitleaks"
  fi
else
  warn "gitleaks not installed (brew install gitleaks). Skipping secret scan."
fi

printf "\n--- summary ---\n"
printf "tools run: %d\n" "$ran"
if [ "${#failed[@]}" -gt 0 ]; then
  printf "failed: %s\n" "${failed[*]}"
else
  printf "failed: none\n"
fi
exit "$rc"
