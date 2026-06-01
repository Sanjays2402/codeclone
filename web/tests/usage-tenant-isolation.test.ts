/**
 * Run with: node --test --experimental-strip-types web/tests/usage-tenant-isolation.test.ts
 *
 * Proves that lib/usage's workspace scope filter (the engine behind the
 * /api/usage tenant gate) does not leak rows across tenants.
 *
 * Before this change, summarize() and recentEvents() folded every row in
 * USAGE_DIR into one global view, and /api/usage was unauthenticated.
 * The route now resolves the caller's workspaces and forwards them as a
 * Set<string> scope. Here we verify the library half: events tagged with
 * workspace "ws_a" must never be visible when only "ws_b" is allowed,
 * and untagged legacy rows must be excluded from any scoped view.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-usage-iso-"));
process.env.CODECLONE_KEYS_DIR = tmp;
process.env.CODECLONE_FREE_TIER_MONTHLY = "100";

const { logUsage, summarize, recentEvents } = await import("../lib/usage.ts");

const now = Date.UTC(2026, 4, 20, 12, 0, 0);

await logUsage({ ts: now - 3000, keyId: "k_a1", endpoint: "/v1/compare", workspaceId: "ws_a" });
await logUsage({ ts: now - 2000, keyId: "k_a1", endpoint: "/v1/compare", workspaceId: "ws_a" });
await logUsage({ ts: now - 1000, keyId: "k_b1", endpoint: "/v1/batch", workspaceId: "ws_b" });
await logUsage({ ts: now - 500, keyId: "k_legacy", endpoint: "/v1/compare" }); // unscoped legacy

test("summarize scoped to ws_a hides ws_b and legacy rows", async () => {
  const s = await summarize(30, now, new Set(["ws_a"]));
  assert.equal(s.totalCalls, 2);
  const keys = s.byKey.map((k) => k.keyId).sort();
  assert.deepEqual(keys, ["k_a1"]);
  assert.ok(!keys.includes("k_b1"), "must not leak ws_b keyId");
  assert.ok(!keys.includes("k_legacy"), "scoped view must drop legacy unscoped rows");
});

test("summarize scoped to ws_b hides ws_a", async () => {
  const s = await summarize(30, now, new Set(["ws_b"]));
  assert.equal(s.totalCalls, 1);
  assert.deepEqual(s.byKey.map((k) => k.keyId), ["k_b1"]);
});

test("summarize scoped to empty set returns nothing", async () => {
  const s = await summarize(30, now, new Set<string>());
  assert.equal(s.totalCalls, 0);
  assert.equal(s.byKey.length, 0);
});

test("summarize with null scope (server-side admin) returns everything", async () => {
  const s = await summarize(30, now, null);
  assert.equal(s.totalCalls, 4);
});

test("recentEvents scoped to ws_a only returns ws_a rows", async () => {
  const evs = await recentEvents(50, 30, now, new Set(["ws_a"]));
  assert.equal(evs.length, 2);
  for (const ev of evs) {
    assert.equal(ev.workspaceId, "ws_a", "recentEvents must not leak other tenants");
    assert.notEqual(ev.keyId, "k_b1");
    assert.notEqual(ev.keyId, "k_legacy");
  }
});

test("recentEvents scoped to multi-tenant allowlist merges only allowed tenants", async () => {
  const evs = await recentEvents(50, 30, now, new Set(["ws_a", "ws_b"]));
  assert.equal(evs.length, 3);
  const wsIds = new Set(evs.map((e) => e.workspaceId));
  assert.ok(wsIds.has("ws_a"));
  assert.ok(wsIds.has("ws_b"));
  assert.ok(!evs.some((e) => !e.workspaceId), "legacy rows still excluded");
});
