# Architecture

CodeClone is a small monorepo. Each piece is independently importable and
testable. There are six logical layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                              codeclone CLI                              │
│            (src/codeclone_cli, Typer; thin orchestration)               │
├────────────────────────────────────────────────────────────────────────┤
│ exporter   │ preprocess │ trainer    │ eval      │ serve   │ web (UI) │
│ (services) │ (services) │ (services) │ (services)│(services)│ Next.js │
├────────────────────────────────────────────────────────────────────────┤
│              dataset     │      models         │     config           │
│         (packages, HF compat, registry, recipe schema + settings)      │
└────────────────────────────────────────────────────────────────────────┘
```

### Why the split

- **Services do one thing.** The exporter only knows about git + GitHub +
  author filtering; the preprocess service only knows about pairs in and
  cleaned pairs out; the trainer only knows about pairs + a backend.
- **Packages are shared primitives.** Anything that two services touch
  (settings, the pair schema, the checkpoint registry, recipe parsing) lives
  in `packages/` and never reaches up into a service.
- **The CLI never has business logic.** It parses args, instantiates a
  service, calls one method, prints a table. This is the rule, not an aspiration.

### Data flow (default path)

1. `exporter` clones a list of repos for one GitHub user, walks history, keeps
   only commits whose author email is in the configured set, and emits one row
   per (file, hunk) into `data/raw/pairs.jsonl`.
2. `preprocess` normalizes whitespace, drops too-short / too-long / wrong-
   language rows, dedupes (exact or MinHash), and splits into
   `train|val|test.jsonl` plus a `preprocess_report.json`.
3. `trainer` picks a backend (MLX on Apple Silicon, PEFT otherwise), runs
   `recipe.train.max_steps` steps, streams metrics to `runs/<id>/metrics.jsonl`,
   and writes an adapter under `adapters/<name>/` together with `meta.json`.
   `index.json` at the adapters root acts as a flat registry.
4. `eval` runs holdout perplexity (or a deterministic proxy when no real
   backend is loaded), the mini-HumanEval suite (8 problems, in-process Python
   sandbox), and a handful of qualitative sample completions; writes
   `eval_report.json`.
5. `serve` exposes `/v1/chat/completions`, `/v1/completions`, and `/v1/models`
   on port 7461 with API-key auth, optional OTel, and Prometheus metrics.

### Failure surfaces and degradation

This system is designed to *keep working* when optional dependencies are
missing. The three big "if missing, degrade gracefully" surfaces:

- **MLX / PEFT not installed.** Trainer falls back to a deterministic mock
  loop that emits a believable decreasing loss curve. The full pipeline
  (run log, adapter dir, registry, eval, serve) still runs.
- **No model weights on disk.** Serve falls back to a `MockHandle` that
  produces deterministic tab-completion-like output. The OpenAI surface is
  fully exercised; you just don't get a real trained model.
- **No `datasets` / `transformers`.** Dataset HF compat is import-lazy. Tests
  and dataset I/O work fine without them.

These are not nice-to-haves; they are how this repo is testable from a fresh
clone without a 1-2 GB model download.

### Backend selection

`Settings.resolve_backend()` returns:

- `"mlx"` on Darwin/arm64 when `CODECLONE_BACKEND=auto|mlx`
- `"peft"` everywhere else when `CODECLONE_BACKEND=auto|peft`

The trainer respects the recipe override; the recipe respects the CLI
override. Last write wins.
