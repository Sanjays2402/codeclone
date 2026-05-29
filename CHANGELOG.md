# Changelog

All notable changes to this project will be documented in this file. The
format is loosely based on Keep a Changelog and the project follows
Semantic Versioning.

## [Unreleased]

## [0.1.0] - initial scaffold

### Added
- Monorepo skeleton (services + packages + web + infra + docs).
- `codeclone` Typer CLI: `export`, `preprocess`, `train`, `eval`, `serve`,
  `models list|show|hash-recipe`.
- Exporter service: GitHub repo listing, shallow clone walk, authored-diff
  extraction, SPDX-aware license filter, secret scrubbing, language filter.
- Preprocess service: normalization, length and language filters, exact and
  MinHash dedupe, deterministic train/val/test splits.
- Trainer service: pluggable backend (MLX, PEFT) with mock fallback,
  JSONL run log, optional MLflow forwarding, checkpoint registry write.
- Eval service: holdout perplexity (proxy when backend missing), mini
  HumanEval-style suite (8 problems), qualitative samples.
- Serve service: OpenAI-compatible `/v1/chat/completions`, `/v1/completions`,
  `/v1/models`; API-key auth; Prometheus `/metrics`; OTel optional; SSE
  streaming for both completion shapes.
- Web dashboard (Next.js 14, Geist, dark): dataset stats, training runs,
  eval reports, adapter registry, serve health.
- Infra: CPU and CUDA Dockerfiles, docker-compose dev stack with OTel
  collector, Helm chart, Terraform skeleton for deploying the chart.
- Tests: 60+ unit and integration tests across all packages and services.
- Docs: architecture, safety, recipes, Continue.dev integration, ops,
  reproducibility.
