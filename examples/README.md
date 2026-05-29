# Examples

Tiny client snippets that talk to a running `codeclone serve` (default port
7461). They all assume `CODECLONE_API_KEY=sk-codeclone-local` for local dev.

| File                          | Language   | Notes                          |
|-------------------------------|------------|--------------------------------|
| `python_client.py`            | Python     | non-streaming chat             |
| `python_stream.py`            | Python     | streaming chat via SSE         |
| `curl_chat.sh`                | shell      | one-shot curl                  |
| `node_client.mjs`             | Node.js    | OpenAI SDK shape, native fetch |
| `continue_config.jsonc`       | jsonc      | drop-in for `~/.continue/config.json` |
| `fim_example.py`              | Python     | tab-autocomplete style FIM     |

These are deliberately tiny. The point is to show the surface, not to ship
a client.
