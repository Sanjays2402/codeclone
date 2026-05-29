#!/usr/bin/env bash
# Fresh end-to-end run with the bundled `quick` recipe.
# Useful for smoke-testing a clone of the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$ROOT"

USER_NAME="${1:-Sanjays2402}"
ADAPTER_NAME="${2:-quick-v1}"

echo "==> export"
codeclone export --user "$USER_NAME" --out data/raw/pairs.jsonl --max-repos 5

echo "==> preprocess"
codeclone preprocess --in data/raw/pairs.jsonl --recipe recipes/quick.yaml --out data/processed

echo "==> train"
codeclone train --recipe recipes/quick.yaml --data data/processed --out "adapters/$ADAPTER_NAME"

echo "==> eval"
codeclone eval --model "adapters/$ADAPTER_NAME" --data data/processed/test.jsonl --out runs/eval

echo "==> registry"
codeclone models list

echo "==> done. start serve:"
echo "   codeclone serve --model adapters/$ADAPTER_NAME --port 7461"
