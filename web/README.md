# Web dashboard

A small Next.js 14 (App Router) read-only dashboard for CodeClone.

It reads:

- `data/processed/preprocess_report.json` for dataset counts
- `runs/<id>/{params.json, metrics.jsonl}` for training runs
- `adapters/index.json` (+ per-adapter `meta.json`) for the checkpoint registry
- The serve endpoint's `/healthz` for liveness

No database, no telemetry. Everything is local files plus a single HTTP probe.

```bash
pnpm install
pnpm dev
```

Geist Sans + Geist Mono, dark only. Big numbers, small everything else.
