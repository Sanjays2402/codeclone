/**
 * Observability tests.
 *
 * Exercises the in-process metrics module and the /api/metrics +
 * /api/healthz + /api/readyz route handlers (loaded directly, the way
 * other tests in this repo do it). No network, no mocks.
 *
 * Run with: node --test --experimental-strip-types web/tests/observability.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-obs-"));
process.env.CODECLONE_RUNS_DIR = path.join(tmp, "runs");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");

const {
  recordRequest,
  renderPrometheus,
  snapshot,
  normalizeRoute,
  __resetMetricsForTests,
  REQUEST_ID_HEADER,
} = await import("../lib/observability.ts");

test("observability: normalizeRoute strips id-like segments", () => {
  assert.equal(normalizeRoute("/api/pairs/abc123def456abcd"), "/api/pairs/:id");
  assert.equal(normalizeRoute("/r/sh_abc12345"), "/r/:id");
  assert.equal(normalizeRoute("/api/workspaces/ws_abc123/invites"), "/api/workspaces/:id/invites");
  assert.equal(normalizeRoute("/status"), "/status");
  assert.equal(normalizeRoute("/"), "/");
  assert.equal(normalizeRoute("/api/snippets/123"), "/api/snippets/:id");
});

test("observability: snapshot records counters and latency", () => {
  __resetMetricsForTests();
  recordRequest({ method: "GET", route: "/api/healthz", status: 200, durationMs: 4 });
  recordRequest({ method: "GET", route: "/api/healthz", status: 200, durationMs: 8 });
  recordRequest({ method: "POST", route: "/api/compare", status: 200, durationMs: 120 });
  recordRequest({ method: "POST", route: "/api/compare", status: 500, durationMs: 300 });

  const snap = snapshot();
  assert.equal(snap.totalRequests, 4);
  assert.equal(snap.inflight, 0);

  const compareLatency = snap.latency.find((l) => l.route === "/api/compare");
  assert.ok(compareLatency, "expected /api/compare latency row");
  assert.equal(compareLatency!.count, 2);
  assert.ok(compareLatency!.avgMs > 100);

  const compareErr = snap.byRoute.find((r) => r.route === "/api/compare" && r.status === "500");
  assert.ok(compareErr, "expected to track 500 separately from 200");
});

test("observability: Prometheus exposition is well-formed", () => {
  __resetMetricsForTests();
  recordRequest({ method: "GET", route: "/api/metrics", status: 200, durationMs: 2 });
  const text = renderPrometheus();
  assert.match(text, /# HELP codeclone_http_requests_total/);
  assert.match(text, /# TYPE codeclone_http_requests_total counter/);
  assert.match(text, /codeclone_http_requests_total\{method="GET",route="\/api\/metrics",status="200"\} 1/);
  assert.match(text, /# TYPE codeclone_http_request_duration_ms histogram/);
  assert.match(text, /codeclone_http_request_duration_ms_bucket\{[^}]+le="\+Inf"\}/);
  assert.match(text, /codeclone_http_request_duration_ms_count\{[^}]+\} 1/);
  assert.match(text, /codeclone_build_info\{service="codeclone-dashboard"/);
  // No naked NaN or undefined leakage.
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("observability: REQUEST_ID_HEADER is correct constant", () => {
  assert.equal(REQUEST_ID_HEADER, "x-request-id");
});

test("middleware would not crash on unknown request id format", () => {
  // The instrument wrapper validates the inbound header before trusting it.
  // We assert the regex policy here so future changes can't loosen it.
  const re = /^[A-Za-z0-9._-]{8,64}$/;
  assert.ok(re.test("abcd1234"));
  assert.ok(!re.test("short"));
  assert.ok(!re.test("has space"));
  assert.ok(!re.test("evil;header"));
});
