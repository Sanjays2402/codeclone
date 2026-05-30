#!/usr/bin/env node
/**
 * Write a small but realistic fixture into ./_fixture so a developer can run
 *
 *   node scripts/seed-fixtures.mjs
 *   CODECLONE_DATA_DIR=_fixture/data \
 *   CODECLONE_RUNS_DIR=_fixture/runs \
 *   CODECLONE_ADAPTERS_DIR=_fixture/adapters \
 *   npm run dev
 *
 * and immediately see the dashboard populated. The shapes match the real
 * pipeline output, so nothing here masks API drift.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd(), "_fixture");
const DATA = path.join(ROOT, "data", "processed");
const RUNS = path.join(ROOT, "runs");
const ADAPTERS = path.join(ROOT, "adapters");

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(RUNS, { recursive: true });
await fs.mkdir(ADAPTERS, { recursive: true });

const codeA = `def normalize_pair(pair):
    """Lowercase identifiers and strip trailing whitespace."""
    return Pair(
        id=pair.id,
        prefix=pair.prefix.rstrip(),
        completion=pair.completion.rstrip(),
        language=pair.language.lower(),
        repo=pair.repo,
        path=pair.path,
        commit_sha=pair.commit_sha,
        author_email_hash=pair.author_email_hash,
    )

def filter_pair(pair, min_lines=2, max_lines=400):
    n = len(pair.prefix.splitlines()) + len(pair.completion.splitlines())
    if n < min_lines or n > max_lines:
        return None
    return pair
`;
const codeB = `def normalize_pair(pair):
    # canonicalize identifier casing and strip whitespace
    return Pair(
        id=pair.id,
        prefix=pair.prefix.rstrip(),
        completion=pair.completion.rstrip(),
        language=pair.language.lower().strip(),
        repo=pair.repo,
        path=pair.path,
        commit_sha=pair.commit_sha,
        author_email_hash=pair.author_email_hash,
        license=pair.license,
    )

def filter_pair(pair, min_lines=2, max_lines=512):
    total = len(pair.prefix.splitlines()) + len(pair.completion.splitlines())
    if total < min_lines:
        return None
    if total > max_lines:
        return None
    return pair
`;

const langs = ["python", "rust", "typescript", "go", "swift"];
const repos = ["acme/util", "acme/web", "acme/llm", "acme/infra"];
const paths = ["src/lib/x.py", "src/core/y.rs", "src/ui/z.ts", "pkg/cmd/main.go", "Sources/Core/a.swift"];

function jl(p, items) {
  return fs.writeFile(p, items.map(x => JSON.stringify(x)).join("\n") + "\n");
}

async function writeSplit(split, n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomBytes(6).toString("hex");
    const lang = langs[i % langs.length];
    const swap = i % 4 === 0;
    items.push({
      id,
      kind: i % 5 === 0 ? "fill_in_middle" : "completion",
      language: lang,
      prefix: swap ? codeB : codeA,
      completion: swap ? codeA : codeB,
      repo: repos[i % repos.length],
      commit_sha: crypto.randomBytes(20).toString("hex"),
      path: paths[i % paths.length],
      author_email_hash: crypto.randomBytes(8).toString("hex"),
      n_prefix_chars: (swap ? codeB : codeA).length,
      n_completion_chars: (swap ? codeA : codeB).length,
      license: i % 3 === 0 ? "Apache-2.0" : "MIT",
    });
  }
  await jl(path.join(DATA, `${split}.jsonl`), items);
  const by_language = Object.fromEntries(langs.map(l => [l, items.filter(p => p.language === l).length]));
  return { total: n, by_language };
}

const stats_train = await writeSplit("train", 80);
const stats_val   = await writeSplit("val", 10);
const stats_test  = await writeSplit("test", 10);

await fs.writeFile(path.join(DATA, "preprocess_report.json"), JSON.stringify({
  out_dir: DATA,
  counts: { train: 80, val: 10, test: 10 },
  filter_report: { dropped_min_lines: 4, dropped_max_lines: 1, dropped_language: 0 },
  dedupe_dropped: 12,
  final_total: 100,
  stats_train, stats_val, stats_test,
}, null, 2));

// runs: two of them
async function writeRun(id, ok) {
  const dir = path.join(RUNS, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "params.json"), JSON.stringify({
    recipe_hash: crypto.randomBytes(8).toString("hex"),
    backend: ok ? "mlx" : "peft",
    base_model: ok ? "qwen2.5-coder-1.5b" : "llama-3.2-1b",
    model: ok ? "qwen2.5-coder-1.5b-codeclone" : "llama-3.2-1b-codeclone",
  }, null, 2));
  const lines = [];
  let loss = 2.4;
  for (let s = 1; s <= 200; s++) {
    loss = Math.max(0.4, loss - 0.008 + (Math.sin(s / 7) * 0.04));
    lines.push(JSON.stringify({ step: s, loss: +loss.toFixed(4), lr: 2e-4, tokens_per_s: 1200 + (s % 30) }));
  }
  await fs.writeFile(path.join(dir, "metrics.jsonl"), lines.join("\n"));
  const cases = Array.from({ length: 24 }, (_, i) => ({
    name: `case_${String(i).padStart(2, "0")}_${["py","rs","ts","go"][i%4]}`,
    passed: ok ? (i % 9 !== 3) : (i % 3 === 0),
    error: ok ? "" : (i % 3 === 0 ? "" : "assertion failed"),
  }));
  const pass = cases.filter(c => c.passed).length / cases.length;
  await fs.writeFile(path.join(dir, "eval_report.json"), JSON.stringify({
    model: ok ? "qwen2.5-coder-1.5b-codeclone" : "llama-3.2-1b-codeclone",
    perplexity: { perplexity: ok ? 3.42 : 7.18, proxy: false },
    mini_pass_rate: pass,
    pass_at_1: pass,
    exact_match: ok ? 0.61 : 0.18,
    mini_scores: cases,
  }, null, 2));
}

await writeRun("20260529-2310-qwen-mlx", true);
await writeRun("20260528-1820-llama-peft", false);

// adapters
await fs.writeFile(path.join(ADAPTERS, "index.json"), JSON.stringify({
  "qwen2.5-coder-1.5b-codeclone": {
    name: "qwen2.5-coder-1.5b-codeclone",
    base_model: "qwen2.5-coder-1.5b",
    backend: "mlx",
    recipe_hash: crypto.randomBytes(8).toString("hex"),
    created_at: new Date(Date.now() - 86400000).toISOString(),
    final_train_loss: 0.42,
  },
  "llama-3.2-1b-codeclone": {
    name: "llama-3.2-1b-codeclone",
    base_model: "llama-3.2-1b",
    backend: "peft",
    recipe_hash: crypto.randomBytes(8).toString("hex"),
    created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    final_train_loss: 1.08,
  },
}, null, 2));

console.log("wrote fixture →", ROOT);
