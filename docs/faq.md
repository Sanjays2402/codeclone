# FAQ

### Why fine-tune at all? Why not just RAG over my repos?

Both are valid. RAG injects your code as context at inference; fine-tuning
shifts the next-token distribution to look more like yours. The two are
complementary: a personal LoRA + a small in-IDE RAG over the current file is
the strongest combination. CodeClone covers the fine-tune half.

### Why a 1.5B model and not 7B+?

This is meant to run on a laptop. A 1.5B LoRA on M-series with 16-32GB RAM
finishes in an hour and serves with low latency. You can point any recipe at
`Qwen/Qwen2.5-Coder-7B` if you have the headroom.

### Will this leak my code to GitHub / Hugging Face?

No. The exporter only reads from your local clones (after you cloned them
via standard git). Training is local. Serving is local. The only network
calls are: (a) the initial GitHub repo listing during `export`, and (b) the
optional base-model download from Hugging Face the first time. Both are
inbound; nothing of yours leaves the machine through CodeClone.

### Does the adapter remember secrets from my history?

Possibly. The line-level secret scrub catches common token shapes, but it
is not exhaustive. If your history contains hard-coded credentials, rotate
them before exporting and keep them rotated. Treat the adapter as a sensitive
artifact regardless.

### Why ship a mock backend?

So the system is testable without a 1-2 GB model download. CI, fresh
clones, and the dashboard all work end-to-end against the mock.

### Why Apache 2.0 and not MIT?

Patent protection clause. Same posture most ML libraries take.

### Can I use this commercially?

The CodeClone tool: yes (Apache 2.0). Your fine-tuned adapter: governed by
the base model's license and any restrictions on the data you trained on.
For Qwen2.5-Coder Apache 2.0 base, fine-tune adapters are typically OK to
use commercially, but confirm against the current model card.

### How do I delete an adapter?

```bash
codeclone models list
rm -rf adapters/<name>
# update index:
jq 'del(.["<name>"])' adapters/index.json > adapters/index.json.new \
  && mv adapters/index.json.new adapters/index.json
```

### Where are the run logs?

`runs/<utc-timestamp>-<recipe-hash>/{params.json, metrics.jsonl}`. The web
dashboard reads these directly.
