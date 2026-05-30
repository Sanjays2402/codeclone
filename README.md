# codeclone

Fine-tune a small code model on your own GitHub commit history, eval it on a mini suite, and serve it behind an OpenAI-compatible API. Ships a Next.js dashboard for browsing clone pairs, datasets, adapters, and eval runs.

![landing](docs/screenshots/landing.png)

## What it does

Walks your authored git history, extracts (prefix, completion) pairs from real commits, normalizes and dedupes them, and trains a LoRA adapter on top of a small code base model (Qwen2.5-Coder-1.5B by default). Trains via MLX on Apple Silicon or PEFT/transformers everywhere else, with a deterministic mock fallback when neither is installed so the pipeline stays testable. Adapters land in a local registry with recipe hash and metrics. Eval computes perplexity plus a mini HumanEval-style pass/fail grid. Serve exposes `/v1/chat/completions` and `/v1/completions` (streaming). The web dashboard browses pairs with a diff viewer, lists datasets and adapters, shows eval runs with charts, and streams chat against the local serve.

## Features

- Commit exporter with author-email filtering, license mode (`strict | permissive_only | off`), and per-language tagging
- Preprocess pipeline: normalize, length/lang filter, exact + MinHash dedupe, train/val/test split, JSON report
- Two LoRA backends behind one `TrainBackend` protocol: `mlx` (mlx-lm) and `peft` (transformers + peft), plus mock fallback
- Streaming step metrics to `runs/<id>/metrics.jsonl`, written incrementally
- Adapter registry under `adapters/<name>/meta.json` with base, backend, recipe hash, final loss
- Eval runner: perplexity (real or proxy), mini suite pass rate, qualitative samples
- OpenAI-compatible serve: `/v1/models`, `/v1/chat/completions`, `/v1/completions`, SSE streaming, API key auth, `/healthz`, `/readyz`, `/metrics`
- Recipe YAMLs (`quick`, `small`, `standard`, `full`, `python_only`, `ts_js_only`, `cuda_overnight`)
- Next.js 15 dashboard: pairs list with search + lang filter, pair detail with shiki diff viewer, datasets browse, models/adapters registry, eval grid with Recharts sparklines, serve health probe
- Prometheus metrics, OTEL hooks, structlog JSON logs

## Stack

- Python 3.10-3.12, Typer CLI, Pydantic v2, FastAPI + uvicorn + sse-starlette
- MLX / mlx-lm (Apple Silicon) or PyTorch + transformers + peft + accelerate (+ bitsandbytes off-darwin)
- datasets, huggingface-hub, GitPython, unidiff, PyGithub, tiktoken, tokenizers
- structlog, prometheus-client, opentelemetry-sdk
- Web: Next.js 15.1 (App Router), React 19, Tailwind v4 (`@tailwindcss/postcss`), SWR 2, Recharts 2, shiki, Phosphor icons
- Hatchling build, ruff, mypy, pytest

## Architecture

Monorepo of small Python packages plus a Next.js app. The CLI orchestrates; services do one thing each; shared schemas and the registry live in `packages/`. Data flows in one direction.

```
GitHub repos
    │  (exporter: GitPython + PyGithub, author-email filter)
    ▼
data/raw/pairs.jsonl
    │  (preprocess: normalize, filter, dedupe, split)
    ▼
data/processed/{train,val,test}.jsonl
    │  (trainer: MLX or PEFT backend, streams metrics)
    ▼
adapters/<name>/  ──►  packages/models registry  ──►  eval runs/<id>/
    │
    ▼
codeclone serve (FastAPI, OpenAI-compatible)
    ▲
    │  REST + SSE
web/ (Next.js dashboard: pairs, datasets, models, eval)
```

See `docs/architecture.md` for the long version.

## Quick start

Python 3.10-3.12 required.

```bash
# Clone + venv
git clone https://github.com/Sanjays2402/codeclone && cd codeclone
uv venv && source .venv/bin/activate

# Pick a backend
uv pip install -e ".[mlx]"     # Apple Silicon
uv pip install -e ".[cuda]"    # Linux + CUDA (also works CPU-only)
uv pip install -e ".[dev]"     # tests + lint

cp .env.example .env           # set GITHUB_TOKEN, AUTHOR_EMAIL

# End-to-end
codeclone export    --user yourname --out data/raw/pairs.jsonl
codeclone preprocess --in data/raw/pairs.jsonl --out data/processed --recipe recipes/small.yaml
codeclone train      --recipe recipes/small.yaml --data data/processed --out adapters/adapter-v1
codeclone eval       --model adapters/adapter-v1 --data data/processed/test.jsonl
codeclone serve      --model adapters/adapter-v1 --port 7461
```

Backend choice (mlx vs peft) is covered in `docs/backends.md`. Default is `auto`: mlx on darwin/arm64, peft otherwise.

Web dashboard:

```bash
cd web
npm install
npm run dev          # http://localhost:3000, expects serve on :7461
```

Set `CODECLONE_SERVE_URL` if serve is elsewhere.

## Configuration

From `.env.example`:

| Var | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | - | GitHub PAT for exporter (public repo scope is enough) |
| `GITHUB_USER` | - | Username to walk |
| `AUTHOR_EMAIL` | - | Required; commits matching this email are kept |
| `AUTHOR_EMAILS_EXTRA` | - | Comma-separated additional emails |
| `CODECLONE_DATA_DIR` | `./data` | Raw + processed data |
| `CODECLONE_ADAPTERS_DIR` | `./adapters` | Adapter registry root |
| `CODECLONE_RUNS_DIR` | `./runs` | Per-run metrics + eval reports |
| `CODECLONE_CACHE_DIR` | `./data/cache` | Tokenizer / dataset cache |
| `CODECLONE_BASE_MODEL` | `Qwen/Qwen2.5-Coder-1.5B` | HF base model id |
| `CODECLONE_TOKENIZER` | same | Tokenizer id |
| `CODECLONE_BACKEND` | `auto` | `auto | mlx | peft` |
| `CODECLONE_API_KEY` | `sk-codeclone-local` | Bearer for `/v1/*` |
| `CODECLONE_SERVE_HOST` | `127.0.0.1` | |
| `CODECLONE_SERVE_PORT` | `7461` | |
| `CODECLONE_MAX_TOKENS` | `2048` | Serve cap |
| `CODECLONE_DEFAULT_TEMPERATURE` | `0.2` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTEL collector |
| `OTEL_SERVICE_NAME` | `codeclone` | |
| `MLFLOW_TRACKING_URI` | - | Optional MLflow |
| `HF_HOME` | `./hf_cache` | HF cache |
| `HUGGING_FACE_HUB_TOKEN` | - | For gated models |
| `LOG_LEVEL` | `INFO` | |
| `LOG_JSON` | `1` | structlog JSON output |

Web also reads `CODECLONE_SERVE_URL` (default `http://127.0.0.1:7461`).

## Scripts

CLI (`codeclone ...`, defined in `src/codeclone_cli/main.py`):

| Command | Description |
|---|---|
| `export` | Walk authored commits, write `pairs.jsonl` |
| `preprocess` | Normalize, filter, dedupe, split |
| `train` | LoRA fine-tune end-to-end |
| `eval` | Perplexity + mini suite + samples |
| `serve` | Start OpenAI-compatible API |
| `models list` | List adapters in registry |
| `models show <name>` | Print adapter `meta.json` |
| `models hash-recipe <recipe.yaml>` | Compute recipe hash |

Makefile wrappers: `make install | dev | test | lint | typecheck | fmt | run-serve | docker-cpu | docker-cuda | compose-up | helm-lint`.

Repo scripts: `scripts/smoke_e2e.sh`, `scripts/docker_smoke.sh`, `scripts/test.sh`, `scripts/daily_retrain.py`, `scripts/run_sparkline.py`.

Web (`web/package.json`): `dev`, `build`, `start`, `lint`, `typecheck`, `seed` (`node scripts/seed-fixtures.mjs`).

## API

### Serve (FastAPI, `services/serve/codeclone_serve/app.py`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` | no | liveness |
| GET | `/readyz` | no | readiness (model loaded) |
| GET | `/metrics` | no | Prometheus |
| GET | `/v1/models` | bearer | OpenAI-style model list |
| POST | `/v1/chat/completions` | bearer | chat, supports `stream: true` (SSE) |
| POST | `/v1/completions` | bearer | text completion, supports `stream: true` |

Auth header: `Authorization: Bearer $CODECLONE_API_KEY`.

### Dashboard BFF (`web/app/api/*`)

| Method | Path | Source |
|---|---|---|
| GET | `/api/pairs?limit&offset&q&lang` | reads pairs JSONL via `loadPairsList` |
| GET | `/api/pairs/[id]` | single pair with diff |
| GET | `/api/datasets` | dataset manifest |
| GET | `/api/adapters` | adapter registry |
| GET | `/api/runs` | training runs |
| GET | `/api/eval` | eval index |
| GET | `/api/eval/[runId]` | single eval report |
| GET | `/api/health` | serve `/healthz` probe + eval health |
| GET | `/api/serve-health` | raw serve probe |

OpenAPI for the serve layer: `docs/openapi.yaml`.

## Backends

Selection precedence (from `docs/backends.md`):

```
recipe.train.backend (yaml) > CLI --backend > CODECLONE_BACKEND env > auto
```

`auto` resolves to `mlx` on Darwin/arm64, `peft` elsewhere.

**MLX (Apple Silicon).** `uv pip install -e ".[mlx]"`. Uses `mlx_lm.lora`. From the docs: "drop `model.context_length` to 1024 if you OOM on a 16 GB machine".

**PEFT (CUDA / CPU).** `uv pip install -e ".[cuda]"`. Uses `peft.get_peft_model(...)` with a hand-rolled AdamW step loop (not `transformers.Trainer`) to keep the streaming metrics contract. `bitsandbytes` is in the extras for 4/8-bit but off by default.

If neither backend imports, the trainer falls back to a deterministic mock (decreasing-loss curve) so the rest of the pipeline still runs in CI and on bare laptops. Both backends implement the same `TrainBackend` protocol in `services/trainer/codeclone_trainer/backends/base.py`: `prepare`, `train` (yields `StepMetrics`), `save_adapter`.

## Eval

Run:

```bash
codeclone eval --model adapters/adapter-v1 \
               --data data/processed/test.jsonl \
               --out runs/eval \
               --n-samples 4 --max-problems 8
```

Three components (`services/eval/codeclone_eval/`):

- **Perplexity** (`perplexity.py`): real PPL when the backend exposes logprobs, otherwise a proxy. The report flags `proxy: true` so you don't mix them.
- **Mini suite** (`mini_humaneval.py`): a small set of canonical problems; each is generated, executed, and recorded as pass/fail with truncated error string. `mini_pass_rate = passed / total`.
- **Samples** (`samples.py`): `n_samples` qualitative completions for the report UI.

Outputs land in `runs/eval/` (or the `--out` you pass): `report.json` plus per-sample artifacts. The dashboard pulls these via `/api/eval` and `/api/eval/[runId]`.

## Project structure

```
.
├── src/codeclone_cli/            # Typer entrypoint
├── services/
│   ├── exporter/                 # GitHub + git walker
│   ├── preprocess/               # normalize, filter, dedupe, split
│   ├── trainer/                  # backends/{mlx,peft,base}, driver, run_log
│   ├── eval/                     # perplexity, mini suite, samples
│   └── serve/                    # FastAPI app, auth, model handle
├── packages/
│   ├── config/                   # settings, recipes, logging
│   ├── dataset/                  # pair schema, jsonl io
│   └── models/                   # checkpoint registry
├── recipes/                      # quick|small|standard|full|...
├── web/                          # Next.js 15 dashboard
├── examples/                     # curl, python, node, continue.dev configs
├── scripts/                      # smoke_e2e, daily_retrain, sparkline
├── infra/                        # docker, helm
├── docs/                         # architecture, backends, recipes, ops, openapi
└── tests/
```

## Operations

Notes for running CodeClone as a long-lived service rather than a one-off.

**Deploy.** Container images are built from `infra/docker/Dockerfile` (CPU) or `infra/docker/Dockerfile.cuda` (GPU). A Helm chart lives at `infra/helm/codeclone` with values for replica count, resource requests, and probes. Both health probes (`/healthz` liveness, `/readyz` readiness) and Prometheus scraping (`/metrics`) are exposed by the serve process and are exempt from rate limiting so probes never starve under load.

**Scale.** The serve API is stateless modulo the loaded adapter, so horizontal scaling is by replica count. The in-process rate limiter is per replica. When running more than one replica behind a shared ingress, set tighter per-replica budgets or front the service with a shared limiter (NGINX `limit_req`, Envoy local or global rate limit, or a Redis token bucket) and treat the in-process limiter as defense in depth.

**Rate limiting.** Two independent token buckets run per request, one keyed on client IP and one on the bearer API key. A request is allowed only if both buckets have a token. Health and metrics paths are always exempt. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODECLONE_RATELIMIT_ENABLED` | `true` | Master switch. |
| `CODECLONE_RATELIMIT_PER_IP_RPM` | `120` | Steady state requests per minute per client IP. |
| `CODECLONE_RATELIMIT_PER_KEY_RPM` | `600` | Steady state requests per minute per API key. |
| `CODECLONE_RATELIMIT_BURST` | `20` | Bucket capacity, i.e. the largest short term spike a single identity may emit. |
| `CODECLONE_RATELIMIT_TRUST_FORWARDED` | `false` | When the service sits behind a trusted proxy, set true so `X-Forwarded-For` / `X-Real-IP` is used for the IP key. Do not enable when the socket is reachable directly. |

Throttled requests get HTTP `429` with a `Retry-After` header in seconds and a JSON body that names which bucket (`ip` or `api_key`) tripped.

**Secrets.** All runtime config is loaded via pydantic-settings from environment then `.env`. The `CODECLONE_API_KEY` is the bearer token enforced by `Authorization: Bearer ...`. Rotate by redeploying with a new value. Never bake secrets into images.

**Observability.** Structured JSON logs are emitted by `structlog` (`LOG_JSON=1`, `LOG_LEVEL=INFO`). Per-route latency histograms and request counters are exposed at `/metrics` in Prometheus text format. If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, FastAPI is auto-instrumented and spans are shipped via OTLP HTTP.

**Error tracking.** The serve process wires the Sentry SDK at app startup whenever `SENTRY_DSN` is set; if the DSN is empty the SDK is a no-op so local runs and CI never phone home. `/healthz` reports a `sentry` boolean so deployment smoke tests can confirm the integration is live. The `Authorization`, `X-Api-Key`, and `Cookie` request headers are redacted in the `before_send` hook before any event leaves the process, so bearer tokens never end up in Sentry breadcrumbs. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | empty | Project DSN. Empty disables the SDK. |
| `SENTRY_ENVIRONMENT` | `development` | Tag attached to every event (`production`, `staging`, etc.). |
| `SENTRY_RELEASE` | unset | Release identifier, typically the git SHA or image tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0` | Performance trace sampling rate, `0.0` to `1.0`. Start at `0.05` in production. |
| `SENTRY_SEND_DEFAULT_PII` | `false` | Leave off; auth headers are already scrubbed regardless. |

**Audit log.** Every request handled by the serve API (other than `/healthz`, `/readyz`, `/metrics`, `/favicon.ico`) is appended as one JSON line to `CODECLONE_AUDIT_LOG_PATH` (default `./runs/audit.log`). The middleware is implemented at the ASGI layer so it does not buffer streaming responses (SSE). Each record carries:

| Field | Meaning |
| --- | --- |
| `ts` | UTC ISO 8601 timestamp. |
| `request_id` | 16-char correlation id. Honors an inbound `X-Request-ID` and is echoed back as a response header. |
| `actor` | `key:<sha256[:12]>` of the bearer token, or `anonymous` for unauthenticated calls. The raw key is never written. |
| `remote_ip` | Client IP. Uses the first `X-Forwarded-For` entry only when `CODECLONE_RATELIMIT_TRUST_FORWARDED=true`. |
| `user_agent` | Client UA, truncated to 200 chars. |
| `method`, `path`, `status`, `latency_ms` | HTTP method, route, response status, wall time in ms. |
| `model` | Best-effort JSON body peek for `/v1/*` POSTs (skipped for bodies over 256 KiB). |
| `error` | Present only when the handler raised an unhandled exception. |

Writes are buffered through a background thread (`queue.SimpleQueue`) so request latency is not bound by disk fsync. Auth failures are logged with `actor="anonymous"`, so brute-force probes show up in the audit trail and not only in rate-limit metrics. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODECLONE_AUDIT_LOG_ENABLED` | `true` | Master switch. Set false to disable the middleware entirely. |
| `CODECLONE_AUDIT_LOG_PATH` | `./runs/audit.log` | Output file. Parent directory is created if missing. Ship to a SIEM via Filebeat, Vector, or Promtail tailing this file. |

The file is append-only JSONL, so log rotation should use `copytruncate` (logrotate) or any tail-friendly rotator. Lines are well under 4 KiB and rely on POSIX append atomicity, so concurrent rotators do not interleave bytes within a record.

**Backup.** Persistent state is on disk: trained adapters in `CODECLONE_ADAPTERS_DIR`, run logs in `CODECLONE_RUNS_DIR`, and the dataset cache in `CODECLONE_CACHE_DIR`. Back these directories up with the usual volume snapshot or `restic` workflow. The serve process itself is stateless beyond the adapter it loads at boot.

**On-call playbook.**

1. Spike in `429` from `/metrics`: check whether one IP or one API key is the source (the response body names the scope). Raise the relevant `*_RPM` budget or revoke the key.
2. `/readyz` failing but `/healthz` ok: the model handle did not load. Check container logs for `load_handle` errors and confirm the mounted adapter path.
3. Latency regression in `codeclone_request_seconds`: confirm GPU or MLX backend is the one selected by `resolve_backend()` and that no other process is contending for the device.
4. Auth failures: confirm the deployed `CODECLONE_API_KEY` matches what the caller is sending. The serve process logs do not include the key itself.
5. Sudden Sentry quiet on a known-broken deploy: hit `/healthz` and confirm `sentry: true`. If it reports false, the pod is missing `SENTRY_DSN` or the `sentry-sdk` import failed at boot (check logs for `sentry.sdk_missing` or `sentry.init_failed`).
6. Incident forensics: grep `runs/audit.log` by `actor` or `remote_ip` to reconstruct a timeline; the `request_id` ties each row to the matching response header and (when present) the Sentry event tag.

**Kubernetes hardening.** The Helm chart ships four optional production objects, all off by default so a fresh `helm install` stays minimal. Flip them on once the workload graduates past a single-pod hobby deploy:

| Values flag | Object | When to enable |
| --- | --- | --- |
| `autoscaling.enabled=true` | `HorizontalPodAutoscaler` | More than one replica and variable QPS. Tune `targetCPUUtilizationPercentage`; remember the in-process rate limiter is per pod. |
| `podDisruptionBudget.enabled=true` | `PodDisruptionBudget` | Any time `replicaCount > 1`. Default `minAvailable: 1` keeps one pod up during node drains and rolling upgrades. |
| `networkPolicy.enabled=true` | `NetworkPolicy` | Cluster has a CNI that enforces policies (Cilium, Calico, etc.). Default egress allows DNS plus public HTTPS so Hugging Face model pulls still work, and blocks RFC1918 ranges; override `networkPolicy.ingress.from` to scope callers to a specific namespace or pod selector. |
| `serviceMonitor.enabled=true` | `ServiceMonitor` (prometheus-operator CRD) | Cluster runs the Prometheus Operator (kube-prometheus-stack). Set `serviceMonitor.additionalLabels.release=<your-prom-release>` so the operator picks it up. Scrapes `/metrics` on the `http` port every 30s. |

The chart-lint CI job renders the chart twice on every push, once with defaults and once with all four flags on, so a template typo fails CI before it ships. The same matrix is covered by `tests/test_helm_chart.py` which shells out to `helm template` and parses the resulting YAML.

## License

Apache-2.0. See `LICENSE`.
