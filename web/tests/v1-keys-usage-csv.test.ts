/**
 * Run with: node --test --experimental-strip-types web/tests/v1-keys-usage-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/keys/{id}/usage. The route handler
 * imports next/server and cannot be loaded under raw `node --test`,
 * so this follows the existing pattern in
 * v1-keys-usage-tenant-isolation.test.ts and asserts the route file
 * actually wires the format param, the CSV branch (content-type and
 * a per-key filename), and audits the format choice.
 *
 * It also re-exercises the underlying summarize() to make sure the
 * (workspaceScope + keyId) view that backs the CSV stays narrow:
 * a CSV download for key A in workspace alpha must never include
 * key B's rows, and must never include workspace bravo's rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-usage-csv-"));
process.env.CODECLONE_KEYS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "keys", "[id]", "usage", "route.ts"),
  "utf8",
);

const { logUsage, summarize } = await import("../lib/usage.ts");

test("v1/keys/{id}/usage: route wires format=csv, rejects unknown formats, audits format choice", () => {
  // format param parsed and validated.
  assert.match(routeSrc, /searchParams\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // CSV branch must emit a spreadsheet content-type and a per-key
  // filename so curl -OJ saves it under a name a FinOps reviewer can
  // tell apart from the workspace-wide /v1/usage CSV.
  assert.match(routeSrc, /text\/csv/);
  assert.match(routeSrc, /codeclone-key-\$\{target\.id\}-usage\.csv/);
  // Audit row records the format so a JSON poll and a CSV chargeback
  // export are distinguishable in the audit trail.
  assert.match(routeSrc, /format,?\s*\n\s*\}/);
  // RFC 4180 double-quote escaping must be in the local CSV helper.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
});

test("v1/keys/{id}/usage: route keeps the rate-limit enforce and per-key audit action", () => {
  // CSV must not bypass billing: still enforce the per-key rate-limit
  // window, not peek it. An exporter cron pulling CSV is a real call.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "csv path must enforce, not peek");
  // Audit action id stays stable so finance/SOC2 queries keep working.
  assert.match(routeSrc, /"v1\.keys\.usage\.read"/);
});

test("v1/keys/{id}/usage: CSV-backing summarize stays narrow to (workspace, key)", async () => {
  const WS_A = "ws_csv_alpha";
  const WS_B = "ws_csv_bravo";
  // Two keys in workspace A, one key in workspace B, mixed traffic.
  for (let i = 0; i < 4; i++) {
    await logUsage({
      ts: Date.now() - i * 60_000,
      keyId: "k_csv_a1",
      endpoint: "/v1/compare",
      bytes: 100,
      latencyMs: 11,
      workspaceId: WS_A,
    });
  }
  for (let i = 0; i < 7; i++) {
    await logUsage({
      ts: Date.now() - i * 60_000,
      keyId: "k_csv_a2",
      endpoint: "/v1/compare",
      bytes: 50,
      latencyMs: 8,
      workspaceId: WS_A,
    });
  }
  for (let i = 0; i < 3; i++) {
    await logUsage({
      ts: Date.now() - i * 60_000,
      keyId: "k_csv_b1",
      endpoint: "/v1/compare",
      bytes: 25,
      latencyMs: 5,
      workspaceId: WS_B,
    });
  }

  const scopeA = new Set<string>([WS_A]);
  // Per-key view for k_csv_a1 only.
  const v1 = await summarize(7, Date.now(), scopeA, "k_csv_a1");
  assert.equal(v1.totalCalls, 4, "k_csv_a1 sees its own 4 calls");
  // by_day rows that feed the CSV must sum to totalCalls.
  const summed = v1.byDay.reduce((acc, r) => acc + r.count, 0);
  assert.equal(summed, 4, "by_day rows back the CSV one-to-one");

  // The other key in the same workspace must not leak into k_csv_a1's CSV.
  const v2 = await summarize(7, Date.now(), scopeA, "k_csv_a2");
  assert.equal(v2.totalCalls, 7);

  // Workspace B's key id is invisible from a workspace A scope even if
  // an attacker guessed the id and asked for its CSV.
  const vCross = await summarize(7, Date.now(), scopeA, "k_csv_b1");
  assert.equal(vCross.totalCalls, 0, "cross-tenant key id must read as empty");
});
