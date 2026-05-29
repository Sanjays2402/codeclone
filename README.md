# CodeClone

> Fine-tune a small code model on **your own** GitHub commit history, then serve it as an OpenAI-compatible endpoint that Continue.dev can use inside VS Code.

CodeClone clones your repos, walks history, keeps only the diffs that **you** authored, turns those into `(prefix, completion)` pairs, runs a LoRA fine-tune on a small open base model (Qwen2.5-Coder by default), evaluates the adapter, and serves it on `:7461` behind an OpenAI-shaped API.

Apple Silicon is the default training surface (MLX). A `transformers + peft` path is provided for CUDA boxes.

## Why

Generic code assistants are trained on the average of the internet. The result is plausibly good code that often does not look like *yours*. CodeClone takes a different route. It builds a tiny, personal LoRA adapter from a signal you already own (your commits), and exposes it locally so your IDE can ask it for completions without anything leaving the machine.

## Architecture

```
+----------------------+      +----------------------+      +----------------------+
|  services/exporter   |----->|  services/preprocess |----->|  services/trainer    |
|  walk authored diffs |      |  tokenize, dedupe,   |      |  LoRA (mlx | peft)   |
|  -> pairs.jsonl      |      |  license-filter,     |      |  -> adapters/*       |
+----------------------+      |  splits              |      +----------+-----------+
                              +----------+-----------+                 |
                                         |                             v
                                         |                  +----------------------+
                                         |                  |  services/eval       |
                                         |                  |  ppl + mini-exec     |
                                         |                  +----------+-----------+
                                         v                             |
                              +----------------------+                 v
                              |  packages/dataset    |      +----------------------+
                              |  HF datasets compat  |      |  services/serve      |
                              +----------------------+      |  OpenAI /v1 on 7461  |
                                                            +----------+-----------+
                                                                       |
                                                                       v
                                                              Continue.dev / curl
```

The CLI (`codeclone`) is a thin Typer front-end over the services.

## Install

```bash
git clone https://github.com/Sanjays2402/codeclone
cd codeclone
uv venv && source .venv/bin/activate
uv pip install -e ".[mlx,dev]"     # Apple Silicon
# or
uv pip install -e ".[cuda,dev]"    # NVIDIA
```

Set up credentials (read-only `repo` scope is enough for public repos):

```bash
cp .env.example .env
# edit GITHUB_TOKEN, GITHUB_USER, AUTHOR_EMAIL
```

## End-to-end run

```bash
# 1. Build your personal dataset (filters by author email)
codeclone export --user Sanjays2402 --out data/raw

# 2. Clean, tokenize, dedupe, split
codeclone preprocess --in data/raw --out data/processed

# 3. LoRA fine-tune with a recipe
codeclone train --recipe recipes/small.yaml --data data/processed --out adapters/sanjay-v1

# 4. Evaluate the adapter
codeclone eval --model adapters/sanjay-v1 --data data/processed/test.jsonl

# 5. Serve OpenAI-compatible API
codeclone serve --model adapters/sanjay-v1 --port 7461
```

## Recipe presets

| Recipe              | Target hardware       | Wall clock | Steps | LoRA rank |
|---------------------|-----------------------|------------|-------|-----------|
| `recipes/quick.yaml`    | M-series, 16GB    | ~10 min    | 200   | 8         |
| `recipes/small.yaml`    | M-series, 16-32GB | ~1 h       | 1000  | 16        |
| `recipes/standard.yaml` | M-series, 32GB+   | ~3 h       | 3000  | 32        |
| `recipes/full.yaml`     | overnight / CUDA  | 8-12 h     | 8000  | 64        |

Every recipe is hashed into the checkpoint metadata for reproducibility.

## Continue.dev (VS Code)

Drop this into `~/.continue/config.json`:

```jsonc
{
  "models": [
    {
      "title": "CodeClone (me)",
      "provider": "openai",
      "model": "codeclone",
      "apiBase": "http://localhost:7461/v1",
      "apiKey": "sk-codeclone-local"
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

The default API key on `serve` is read from `CODECLONE_API_KEY` (defaults to `sk-codeclone-local` in dev only).

## Safety and licensing

CodeClone is built to fine-tune on commits **you wrote**. It enforces this with a stack of filters:

1. **Author filter.** Only commits whose author email matches `AUTHOR_EMAIL` (or the verified emails on your GitHub account) are kept. Pull request merges and reverts are skipped.
2. **Time floor.** Commits older than the creation date of your `AUTHOR_EMAIL` are dropped. This blocks "ancient noreply" mismatches.
3. **License filter.** Source files whose header declares a non-permissive license (GPL family, AGPL, SSPL, Commons Clause) are skipped. Permissive licenses (MIT, BSD, Apache, ISC, MPL) are allowed. Files with no detectable license fall back to repo `LICENSE`.
4. **Path filter.** Generated files (`*.min.js`, `dist/`, `build/`, lockfiles, vendored dirs) are skipped.
5. **Secret scrub.** Lines matching common secret regexes (`ghp_`, `sk-`, JWTs, AWS keys) are dropped before they hit disk.

These are defaults, not opinions. You can tighten or relax any of them in `recipes/*.yaml` under the `safety:` block.

This project deliberately does **not** bundle base model weights. You fetch them at first run from Hugging Face; that fetch is the user's act, under the base model's own license.

## Configuration

All runtime config is `pydantic-settings` driven and reads from environment first, then `.env`. See `packages/config/codeclone_config/settings.py` for the full surface.

## Observability

* Structured JSON logs (`structlog`) on every service.
* OpenTelemetry traces are emitted when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
* `serve` exposes `/metrics` (Prometheus) and `/healthz`.
* Training writes to a JSONL run log under `runs/<run_id>/metrics.jsonl`, and (optionally) MLflow when `MLFLOW_TRACKING_URI` is set.

## Testing

```bash
pytest -q
```

Unit tests cover author filters, license detection, secret scrub, tokenization roundtrip, dataset splits, eval scorer, and the OpenAI-shape serve adapters.

## CI billing note

GitHub Actions are gated by `ENABLE_CI=1` (workflow `if:` guards). They are off by default because training-adjacent CI burns minutes fast. Flip the repo variable when you want green checks.

## Status dashboard (optional)

A small Next.js dashboard lives in `web/`. It is read-only and reads the local `runs/` directory plus the `serve` health endpoint.

```bash
cd web && pnpm install && pnpm dev
```

## License

Apache-2.0. Base model weights are governed by their respective licenses (Qwen2.5-Coder is Apache-2.0 at time of writing; verify before redistribution).
