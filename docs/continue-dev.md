# Continue.dev integration

The serve endpoint speaks the OpenAI v1 dialect on port 7461. Continue.dev
already supports any OpenAI-compatible base URL.

## Minimal config

Append to `~/.continue/config.json`:

```jsonc
{
  "models": [
    {
      "title": "CodeClone",
      "provider": "openai",
      "model": "codeclone",
      "apiBase": "http://localhost:7461/v1",
      "apiKey": "sk-codeclone-local",
      "contextLength": 2048
    }
  ],
  "tabAutocompleteModel": {
    "title": "CodeClone autocomplete",
    "provider": "openai",
    "model": "codeclone",
    "apiBase": "http://localhost:7461/v1",
    "apiKey": "sk-codeclone-local"
  }
}
```

The default `apiKey` (`sk-codeclone-local`) is for development only. In any
shared environment, set `CODECLONE_API_KEY` in `.env` and use that value in
both places.

## What works

- `/v1/models` listing (Continue uses this to populate model menus)
- Non-streaming `/v1/chat/completions`
- Streaming `/v1/chat/completions` (SSE, `data: ...\n\ndata: [DONE]\n`)
- Non-streaming `/v1/completions`
- Streaming `/v1/completions`
- FIM hints via the optional `fim_prefix` / `fim_suffix` fields on
  `/v1/completions`. Continue.dev's tab-autocomplete uses these for context.

## What is unsupported on purpose

- `n > 1` (we only return a single choice; multiple completions would
  multiply latency for no benefit on a personal endpoint)
- Tool calls / function calling (out of scope for a code completion adapter)
- Logprobs (the mock handle does not have a meaningful distribution; a real
  backend can add this without changing the schema)

## Sanity check from a shell

```bash
curl http://localhost:7461/v1/models \
  -H "Authorization: Bearer sk-codeclone-local"

curl http://localhost:7461/v1/chat/completions \
  -H "Authorization: Bearer sk-codeclone-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codeclone",
    "messages": [{"role": "user", "content": "def add(a, b):\n    return"}],
    "max_tokens": 16
  }'
```

If `/healthz` returns 200 and the chat call returns a JSON envelope, the
server is good. Continue.dev problems past that point are config issues on
the IDE side, not on the model side.
