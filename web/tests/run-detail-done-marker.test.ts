/**
 * Run with: node --test --experimental-strip-types web/tests/run-detail-done-marker.test.ts
 *
 * Pins that loadRun() honours the DONE marker file the same way loadRuns()
 * already does. Before this fix the /eval list page and the /eval/[runId]
 * detail page could disagree about the status of a finished run that hadn't
 * produced an eval_report.json yet: the list showed "passed" (because
 * loadRuns checked the DONE marker) while the detail page kept showing
 * "running" (because loadRun did not). That was confusing for anyone
 * reviewing a run from the index, and broke the run-status badge in the
 * page header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("loadRun marks a DONE run with no eval report as passed, matching loadRuns", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-run-done-"));
  const runsDir = path.join(tmp, "runs");
  const runId = "run_done_no_eval";
  const runDir = path.join(runsDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "params.json"), JSON.stringify({ recipe_hash: "abc", backend: "mlx", model: "qwen" }));
  await fs.writeFile(path.join(runDir, "metrics.jsonl"), JSON.stringify({ step: 10, loss: 1.23 }) + "\n");
  await fs.writeFile(path.join(runDir, "DONE"), "");

  // PATHS resolves env vars at import time, so the env has to be set before
  // the module is loaded. Use a fresh dynamic import per test run with a
  // cache-busting query string so this test doesn't poison other suites.
  process.env.CODECLONE_RUNS_DIR = runsDir;
  process.env.CODECLONE_DATA_DIR = path.join(tmp, "data");
  process.env.CODECLONE_ADAPTERS_DIR = path.join(tmp, "adapters");
  const mod = await import(`../lib/data.ts?run-done-marker=${Date.now()}`);

  const listed = await mod.loadRuns();
  const detail = await mod.loadRun(runId);
  assert.ok(detail, "loadRun must find the run we just wrote");
  const summary = listed.find((r: { id: string }) => r.id === runId);
  assert.ok(summary, "loadRuns must list the run we just wrote");

  assert.equal(summary.status, "passed", "loadRuns reads the DONE marker as passed when no eval report exists");
  assert.equal(detail.status, summary.status, "loadRun must agree with loadRuns about the run status");

  await fs.rm(tmp, { recursive: true, force: true });
});

test("loadRun keeps a failed eval as failed even with a DONE marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-run-done-"));
  const runsDir = path.join(tmp, "runs");
  const runId = "run_done_failed";
  const runDir = path.join(runsDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "params.json"), JSON.stringify({ recipe_hash: "abc" }));
  await fs.writeFile(path.join(runDir, "metrics.jsonl"), JSON.stringify({ step: 10, loss: 1.23 }) + "\n");
  await fs.writeFile(path.join(runDir, "eval_report.json"), JSON.stringify({ mini_pass_rate: 0.1, mini_scores: [] }));
  await fs.writeFile(path.join(runDir, "DONE"), "");

  process.env.CODECLONE_RUNS_DIR = runsDir;
  process.env.CODECLONE_DATA_DIR = path.join(tmp, "data");
  process.env.CODECLONE_ADAPTERS_DIR = path.join(tmp, "adapters");
  const mod = await import(`../lib/data.ts?run-done-marker=${Date.now()}`);

  const detail = await mod.loadRun(runId);
  assert.ok(detail);
  assert.equal(detail.status, "failed", "a low pass rate must stay failed even when DONE is present");

  await fs.rm(tmp, { recursive: true, force: true });
});
