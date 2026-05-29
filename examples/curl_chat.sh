#!/usr/bin/env bash
set -euo pipefail
BASE="${CODECLONE_BASE:-http://127.0.0.1:7461}"
KEY="${CODECLONE_API_KEY:-sk-codeclone-local}"

curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codeclone",
    "messages": [{"role":"user","content":"def quicksort(xs):"}],
    "max_tokens": 64
  }' | jq -r '.choices[0].message.content'
