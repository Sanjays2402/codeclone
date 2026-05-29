# Operations

## Local

```bash
cp .env.example .env
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
codeclone --help
```

Run the full pipeline against your own user (real GitHub token, public
repos, default quick recipe):

```bash
codeclone export --user Sanjays2402 --out data/raw/pairs.jsonl
codeclone preprocess --in data/raw/pairs.jsonl --recipe recipes/quick.yaml --out data/processed
codeclone train --recipe recipes/quick.yaml --data data/processed --out adapters/me-v1
codeclone eval  --model adapters/me-v1 --data data/processed/test.jsonl --out runs/eval
codeclone serve --model adapters/me-v1 --port 7461
```

## Docker (dev)

```bash
docker compose -f infra/docker/docker-compose.dev.yml up --build
```

This starts:

- `serve` on `localhost:7461`
- `web` (Next.js) on `localhost:3000`
- `otel-collector` on `localhost:4318` (OTLP HTTP) with Prometheus on `localhost:8889`

## Kubernetes (Helm)

```bash
kubectl create namespace codeclone
kubectl -n codeclone create secret generic codeclone-secrets \
  --from-literal=api-key="sk-prod-please-change"
helm upgrade --install codeclone infra/helm/codeclone -n codeclone
```

`values.yaml` documents every knob. The pod is non-root, drops all
capabilities, mounts adapters read-only, and exposes only port 7461.

## Terraform

`infra/terraform/` deploys the Helm chart onto an existing cluster.

```bash
cd infra/terraform
terraform init
terraform apply -var "api_key=sk-..."
```

The module assumes the cluster exists. Cluster lifecycle is intentionally
out of scope.

## Observability

- Logs: structured JSON to stdout (toggle with `LOG_JSON=0`).
- Metrics: Prometheus at `/metrics` (Counter for requests by route+status,
  Histogram for latency by route).
- Traces: OTel HTTP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Run logs: JSONL at `runs/<id>/metrics.jsonl`; optional MLflow when
  `MLFLOW_TRACKING_URI` is set.

## Backup / data layout

```
data/
  raw/pairs.jsonl
  processed/{train,val,test}.jsonl, preprocess_report.json
  cache/...
adapters/
  index.json
  <name>/meta.json, adapter_config.json, ...
runs/
  <YYYYMMDD-recipehash>/params.json, metrics.jsonl
hf_cache/
  ...
```

Only `data/processed/`, `adapters/`, and `runs/` are worth backing up. The
exporter can always rebuild `data/raw/` from upstream commits.

## Tests

```bash
pytest -q
```

53 tests, ~1s wall clock. CI is gated; see `.github/workflows/ci.yml`.

## Rotating the API key

Update the `CODECLONE_API_KEY` env on the serve container, restart. Clients
that hit the old key will start getting 401 immediately. There is no
multi-key surface by design.
