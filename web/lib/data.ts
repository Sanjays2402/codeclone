/**
 * Filesystem-backed data layer.
 *
 * codeclone keeps everything on disk:
 *   data/processed/{train,val,test}.jsonl     pairs (prefix/completion + provenance)
 *   data/processed/preprocess_report.json     dataset stats
 *   runs/<id>/params.json + metrics.jsonl     training runs
 *   runs/eval/eval_report.json                eval summary
 *   adapters/index.json                       registered adapters
 *
 * Everything here returns null/[] for missing files. Loaders are cached at the
 * module level per process for the lifetime of a request batch.
 */
import fs from "node:fs/promises";
import path from "node:path";

const CWD = process.cwd();

function resolveDir(envVar: string, fallback: string) {
  const v = process.env[envVar];
  if (v) return path.resolve(CWD, v);
  return path.resolve(CWD, "..", fallback);
}

export const PATHS = {
  data: resolveDir("CODECLONE_DATA_DIR", "data"),
  runs: resolveDir("CODECLONE_RUNS_DIR", "runs"),
  adapters: resolveDir("CODECLONE_ADAPTERS_DIR", "adapters"),
};

export interface Pair {
  id: string;
  kind: "completion" | "fill_in_middle" | "instruction";
  language: string;
  prefix: string;
  completion: string;
  repo: string;
  commit_sha: string;
  path: string;
  author_email_hash: string;
  n_prefix_chars: number;
  n_completion_chars: number;
  license: string | null;
}

export interface PairSummary {
  id: string;
  language: string;
  repo: string;
  path: string;
  commit_sha: string;
  similarity: number;
  n_prefix_chars: number;
  n_completion_chars: number;
  split: "train" | "val" | "test";
  kind: Pair["kind"];
  ts: number;
}

export interface DatasetSplitStats {
  total: number;
  by_language?: Record<string, number>;
}

export interface DatasetReport {
  train?: DatasetSplitStats;
  val?: DatasetSplitStats;
  test?: DatasetSplitStats;
  final_total?: number;
  dedupe_dropped?: number;
  filter_report?: unknown;
}

export interface RunSummary {
  id: string;
  recipeHash: string;
  steps: number;
  lastLoss: number | null;
  backend: string | null;
  model: string | null;
  startedAt: number | null;
  status: "queued" | "running" | "passed" | "failed";
}

export interface RunMetricPoint {
  step: number;
  loss?: number;
  lr?: number;
  grad_norm?: number;
  tokens_per_s?: number;
  [k: string]: number | undefined;
}

export interface RunDetail extends RunSummary {
  params: Record<string, unknown> | null;
  metrics: RunMetricPoint[];
  evalReport: EvalReport | null;
}

export interface EvalCase {
  name: string;
  passed: boolean;
  error: string;
}

export interface EvalReport {
  model: string;
  perplexity?: { perplexity: number; proxy: boolean };
  mini_pass_rate: number;
  mini_scores?: EvalCase[];
  pass_at_1?: number;
  exact_match?: number;
  ts?: number;
}

export interface AdapterMeta {
  name: string;
  base_model: string;
  backend: string;
  recipe_hash: string;
  created_at: string;
  final_train_loss: number | null;
}

async function safeReadJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function safeListDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p); } catch { return []; }
}

async function safeStat(p: string) {
  try { return await fs.stat(p); } catch { return null; }
}

/* ---------- pair similarity (shingled token overlap) ---------- */

function tokenize(s: string): string[] {
  return s.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\sA-Za-z0-9]/g) ?? [];
}

export function pairSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchedTokenSet(a: string, b: string): Set<string> {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const matched = new Set<string>();
  for (const t of ta) {
    if (t.length < 3) continue;            // skip punctuation/short
    if (/^[0-9]+$/.test(t)) continue;
    if (tb.has(t)) matched.add(t);
  }
  return matched;
}

/* ---------- pairs ---------- */

async function readJsonlPairs(p: string, split: PairSummary["split"], cap = 5000): Promise<Pair[]> {
  try {
    const buf = await fs.readFile(p, "utf-8");
    const out: Pair[] = [];
    let i = 0;
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Pair); } catch {}
      if (++i >= cap) break;
    }
    return out;
  } catch {
    return [];
  }
}

const SPLIT_FILES: Array<{ split: PairSummary["split"]; file: string }> = [
  { split: "train", file: "train.jsonl" },
  { split: "val",   file: "val.jsonl" },
  { split: "test",  file: "test.jsonl" },
];

let _pairsCache: { ts: number; pairs: PairSummary[]; raw: Map<string, { pair: Pair; split: PairSummary["split"] }> } | null = null;

export async function loadAllPairs(): Promise<{ pairs: PairSummary[]; raw: Map<string, { pair: Pair; split: PairSummary["split"] }> }> {
  if (_pairsCache && Date.now() - _pairsCache.ts < 5_000) {
    return { pairs: _pairsCache.pairs, raw: _pairsCache.raw };
  }
  const processed = path.join(PATHS.data, "processed");
  const pairs: PairSummary[] = [];
  const raw = new Map<string, { pair: Pair; split: PairSummary["split"] }>();
  for (const { split, file } of SPLIT_FILES) {
    const full = path.join(processed, file);
    const stat = await safeStat(full);
    if (!stat) continue;
    const ts = stat.mtimeMs;
    const items = await readJsonlPairs(full, split);
    for (const pair of items) {
      const sim = pairSimilarity(pair.prefix, pair.completion);
      pairs.push({
        id: pair.id,
        language: pair.language,
        repo: pair.repo,
        path: pair.path,
        commit_sha: pair.commit_sha,
        similarity: sim,
        n_prefix_chars: pair.n_prefix_chars,
        n_completion_chars: pair.n_completion_chars,
        split,
        kind: pair.kind,
        ts,
      });
      raw.set(pair.id, { pair, split });
    }
  }
  _pairsCache = { ts: Date.now(), pairs, raw };
  return { pairs, raw };
}

export async function loadPairsList(opts: { limit?: number; offset?: number; q?: string; lang?: string; minSim?: number } = {}): Promise<{ items: PairSummary[]; total: number }> {
  const { pairs } = await loadAllPairs();
  let filtered = pairs;
  if (opts.lang) filtered = filtered.filter(p => p.language === opts.lang);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    filtered = filtered.filter(p =>
      p.id.toLowerCase().includes(q) ||
      p.repo.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q),
    );
  }
  if (opts.minSim !== undefined && Number.isFinite(opts.minSim) && opts.minSim > 0) {
    const min = opts.minSim;
    filtered = filtered.filter(p => p.similarity >= min);
  }
  const total = filtered.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return { items: filtered.slice(offset, offset + limit), total };
}

export async function loadPair(id: string): Promise<{ pair: Pair; split: PairSummary["split"]; similarity: number } | null> {
  const { raw } = await loadAllPairs();
  const hit = raw.get(id);
  if (!hit) return null;
  return { pair: hit.pair, split: hit.split, similarity: pairSimilarity(hit.pair.prefix, hit.pair.completion) };
}

/* ---------- dataset stats ---------- */

export async function loadDatasetStats(): Promise<DatasetReport | null> {
  const j = await safeReadJson<any>(
    path.join(PATHS.data, "processed", "preprocess_report.json"),
  );
  if (!j) return null;
  return {
    train: j.stats_train,
    val: j.stats_val,
    test: j.stats_test,
    final_total: j.final_total,
    dedupe_dropped: j.dedupe_dropped,
    filter_report: j.filter_report,
  };
}

/* ---------- training runs ---------- */

async function readMetricsJsonl(p: string): Promise<RunMetricPoint[]> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const out: RunMetricPoint[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

export async function loadRuns(): Promise<RunSummary[]> {
  const names = (await safeListDir(PATHS.runs)).filter(n => !n.startsWith("."));
  const out: RunSummary[] = [];
  for (const n of names.sort().reverse()) {
    const dir = path.join(PATHS.runs, n);
    const stat = await safeStat(dir);
    if (!stat?.isDirectory()) continue;
    if (n === "eval") continue;
    const params = await safeReadJson<any>(path.join(dir, "params.json"));
    const metrics = await readMetricsJsonl(path.join(dir, "metrics.jsonl"));
    let lastLoss: number | null = null;
    let steps = 0;
    for (const m of metrics) {
      if (typeof m.loss === "number") lastLoss = m.loss;
      if (typeof m.step === "number") steps = Math.max(steps, m.step);
    }
    const evalReport = await safeReadJson<EvalReport>(path.join(dir, "eval_report.json"));
    let status: RunSummary["status"] = "queued";
    if (steps > 0) status = "running";
    if (evalReport) status = evalReport.mini_pass_rate >= 0.5 ? "passed" : "failed";
    if (await safeStat(path.join(dir, "DONE"))) {
      status = evalReport && evalReport.mini_pass_rate < 0.5 ? "failed" : "passed";
    }
    out.push({
      id: n,
      recipeHash: params?.recipe_hash ?? "-",
      steps,
      lastLoss,
      backend: params?.backend ?? null,
      model: params?.model ?? params?.base_model ?? null,
      startedAt: stat.birthtimeMs || stat.mtimeMs,
      status,
    });
  }
  return out;
}

export async function loadRun(id: string): Promise<RunDetail | null> {
  const dir = path.join(PATHS.runs, id);
  const stat = await safeStat(dir);
  if (!stat?.isDirectory()) return null;
  const params = await safeReadJson<Record<string, unknown>>(path.join(dir, "params.json"));
  const metrics = await readMetricsJsonl(path.join(dir, "metrics.jsonl"));
  const evalReport = await safeReadJson<EvalReport>(path.join(dir, "eval_report.json"));
  let lastLoss: number | null = null;
  let steps = 0;
  for (const m of metrics) {
    if (typeof m.loss === "number") lastLoss = m.loss;
    if (typeof m.step === "number") steps = Math.max(steps, m.step);
  }
  let status: RunSummary["status"] = steps > 0 ? "running" : "queued";
  if (evalReport) status = evalReport.mini_pass_rate >= 0.5 ? "passed" : "failed";
  return {
    id,
    params: params ?? null,
    metrics,
    recipeHash: (params?.recipe_hash as string) ?? "-",
    steps,
    lastLoss,
    backend: (params?.backend as string) ?? null,
    model: (params?.model as string) ?? (params?.base_model as string) ?? null,
    startedAt: stat.birthtimeMs || stat.mtimeMs,
    status,
    evalReport,
  };
}

export async function loadLatestRun(): Promise<RunSummary | null> {
  const all = await loadRuns();
  return all[0] ?? null;
}

/* ---------- eval reports (legacy aggregate) ---------- */

export async function loadEvalReports(): Promise<Array<EvalReport & { runId?: string }>> {
  const out: Array<EvalReport & { runId?: string }> = [];
  const evalDir = path.join(PATHS.runs, "eval");
  const top = await safeReadJson<EvalReport>(path.join(evalDir, "eval_report.json"));
  if (top) out.push(top);
  const runs = await loadRuns();
  for (const r of runs) {
    if (r.id === "eval") continue;
    const ev = await safeReadJson<EvalReport>(path.join(PATHS.runs, r.id, "eval_report.json"));
    if (ev) out.push({ ...ev, runId: r.id });
  }
  return out;
}

/* ---------- adapters ---------- */

export async function loadAdapters(): Promise<AdapterMeta[]> {
  const idx = await safeReadJson<Record<string, AdapterMeta>>(
    path.join(PATHS.adapters, "index.json"),
  );
  if (!idx) return [];
  return Object.values(idx).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/* ---------- aggregated health for the top strip ---------- */

export interface EvalHealth {
  queued: number;
  running: number;
  passing: number;
  failing: number;
  totalPairs: number;
  totalRuns: number;
}

export async function loadEvalHealth(): Promise<EvalHealth> {
  const runs = await loadRuns();
  const stats = await loadDatasetStats();
  const totalPairs =
    (stats?.train?.total ?? 0) + (stats?.val?.total ?? 0) + (stats?.test?.total ?? 0);
  return {
    queued: runs.filter(r => r.status === "queued").length,
    running: runs.filter(r => r.status === "running").length,
    passing: runs.filter(r => r.status === "passed").length,
    failing: runs.filter(r => r.status === "failed").length,
    totalPairs,
    totalRuns: runs.length,
  };
}
