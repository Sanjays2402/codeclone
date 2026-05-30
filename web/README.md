codeclone web

A research-paper-grade eval surface for the codeclone toolchain. Reads from
the on-disk artifacts that the CLI writes:

  data/processed/{train,val,test}.jsonl     pairs
  data/processed/preprocess_report.json     dataset stats
  runs/<id>/{params.json,metrics.jsonl}     training runs
  runs/<id>/eval_report.json                per-run eval
  runs/eval/eval_report.json                aggregate eval
  adapters/index.json                       adapter registry

The serve health strip pings CODECLONE_SERVE_URL/healthz on an 8-second SWR.

Run

  CODECLONE_DATA_DIR=../data \
  CODECLONE_RUNS_DIR=../runs \
  CODECLONE_ADAPTERS_DIR=../adapters \
  npm run dev

Routes

  /                overview + hero pair preview + eval summary
  /pairs           dense clone-pair index (id, sim, lang, split, path, repo)
  /pairs/[id]      synced side-by-side diff with token-level match overlay
  /eval            training runs list
  /eval/[runId]    metrics, loss curve, per-case heatmap + table
  /datasets        splits and language mix
  /models          adapter registry joined with eval

REST surface

  GET /api/health           top-strip totals + serve status
  GET /api/pairs            ?q=&lang=&limit=&offset=
  GET /api/pairs/[id]       full pair + computed similarity
  GET /api/runs             run summaries
  GET /api/eval             aggregate + per-run reports
  GET /api/eval/[runId]     run detail + metrics + eval
  GET /api/datasets         preprocess_report.json
  GET /api/adapters         adapters/index.json

Design

  Inter Tight for chrome, JetBrains Mono everywhere code/numerics touch.
  Warm-paper light surface by default. Dark via the toggle in the navbar.
  Single muted-indigo accent. Diff colors stay close to the paper.
