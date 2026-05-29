#!/usr/bin/env bash
# Build the CPU image locally and probe /healthz inside a one-shot container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
TAG="${TAG:-codeclone:local}"

docker build -t "$TAG" -f "$ROOT/infra/docker/Dockerfile" "$ROOT"

CID=$(docker run -d --rm -p 17461:7461 -e CODECLONE_API_KEY=sk-test "$TAG")
trap 'docker kill "$CID" >/dev/null 2>&1 || true' EXIT

# Wait for healthz.
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:17461/healthz >/dev/null; then
    echo "healthz OK"
    break
  fi
  sleep 1
done

curl -sf -H 'Authorization: Bearer sk-test' http://127.0.0.1:17461/v1/models | jq .
