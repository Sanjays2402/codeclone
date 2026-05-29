#!/usr/bin/env bash
# Run the full pytest suite with coverage.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pytest --cov=src --cov=packages --cov=services -q "$@"
