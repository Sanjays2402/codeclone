/**
 * Run with: node --test --experimental-strip-types web/tests/v1-keys-usage-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping and per-key-filter guarantees of the
 * new programmatic GET /v1/keys/{id}/usage endpoint.
 *
 * The route handler imports next/server and cannot be loaded under
 * raw `node --test`, so this follows the existing pattern (see
 * v1-keys-update-tenant-isolation.test.ts) and covers the contract
 * in two layers:
 *
 *   1) Black-box assertions on `summarize` / `recentEvents` proving
 *      the new optional keyId filter actually narrows results and
 *      composes correctly with the workspace scope filter.
 *   2) Source-level assertions that the route file actually wires
 *      `usage:read`, the workspace gate, `loadKeyForWorkspace`,
 *      tenant_required, 404-not-403, the rate-limit enforce step,
 *      and the per-key audit row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-usage-"));
process.env.CODECLONE_KEYS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const { logUsage, summarize, recentEvents } = await import("../lib/usage.ts");
const { createKey } = await import("../lib/api-keys.ts");

const WS_A = "ws_alpha1";
const WS_B = "ws_bravo2";

test("summarize+recentEvents: keyId filter narrows to one key, composes with workspace scope", async () => {
  const a1 = await createKey("a-one", { workspaceId: WS_A, scopes: ["compare:write"] });
  const a2 = await createKey("a-two", { workspaceId: WS_A, scopes: ["compare:write"] });
  const b1 = await createKey("b-one", { workspaceId: WS_B, scopes: ["compare:write"] });

  const now = Date.now();
  // Three events for a1, two for a2, one for b1.
  for (let i = 0; i < 3; i++) {
    await logUsage({
      ts: now - i * 1000,
      keyId: a1.record.id,
      endpoint: "/v1/compare",
      bytes: 100,
      latencyMs: 12,
      workspaceId: WS_A,
    });
  }
  for (let i = 0; i < 2; i++) {
    await logUsage({
      ts: now - i * 1000,
      keyId: a2.record.id,
      endpoint: "/v1/shares",
      bytes: 50,
      latencyMs: 8,
      workspaceId: WS_A,
    });
  }
  await logUsage({
    ts: now,
    keyId: b1.record.id,
    endpoint: "/v1/compare",
    bytes: 100,
    latencyMs: 9,
    workspaceId: WS_B,
  });

  // Workspace A, filter to a1: totalCalls should be 3, byKey exactly [a1].
  const sumA1 = await summarize(7, now, new Set([WS_A]), a1.record.id);
  assert.equal(sumA1.totalCalls, 3, "a1 should have 3 events in workspace A");
  assert.equal(sumA1.byKey.length, 1);
  assert.equal(sumA1.byKey[0].keyId, a1.record.id);
  assert.equal(sumA1.byEndpoint.length, 1);
  assert.equal(sumA1.byEndpoint[0].endpoint, "/v1/compare");

  // Workspace A, filter to a2: totalCalls should be 2.
  const sumA2 = await summarize(7, now, new Set([WS_A]), a2.record.id);
  assert.equal(sumA2.totalCalls, 2);
  assert.equal(sumA2.byEndpoint[0].endpoint, "/v1/shares");

  // Cross-tenant: workspace A scope + b1 keyId filter must return zero.
  // This proves the keyId filter never bypasses the workspace gate.
  const sumCross = await summarize(7, now, new Set([WS_A]), b1.record.id);
  assert.equal(
    sumCross.totalCalls,
    0,
    "filtering to a cross-tenant keyId under workspace A scope must yield zero",
  );

  // Without a keyId filter, the workspace A summary should see 5 events
  // (3 from a1 + 2 from a2) and exclude b1's row.
  const sumAll = await summarize(7, now, new Set([WS_A]));
  assert.equal(sumAll.totalCalls, 5);
  assert.ok(!sumAll.byKey.some((k) => k.keyId === b1.record.id));

  // recentEvents filtered to a1 should return exactly 3 entries, all a1.
  const recA1 = await recentEvents(50, 7, now, new Set([WS_A]), a1.record.id);
  assert.equal(recA1.length, 3);
  for (const r of recA1) {
    assert.equal(r.keyId, a1.record.id);
    assert.equal(r.endpoint, "/v1/compare");
  }
});

test("route source: GET /v1/keys/{id}/usage wires required guards", () => {
  const src = fs.readFileSync(
    path.join(webRoot, "app/api/v1/keys/[id]/usage/route.ts"),
    "utf-8",
  );
  // Scope is usage:read.
  assert.match(src, /usage:read/, "must enforce usage:read");
  // Tenant scope is structural via loadKeyForWorkspace.
  assert.match(src, /loadKeyForWorkspace\(/, "must resolve target via loadKeyForWorkspace");
  // Cross-tenant must return 404, not 403, to avoid id probing.
  assert.match(src, /not_found/);
  assert.match(src, /Key not found in this workspace/);
  // Keys with no workspace are refused.
  assert.match(src, /tenant_required/);
  // Rate limit is enforced (not peeked).
  assert.match(src, /enforceRateLimit\(key\)/);
  // Full enforcement chain runs.
  assert.match(src, /enforceWorkspaceLockdownForKey/);
  assert.match(src, /enforceWorkspaceAllowlistForKey/);
  assert.match(src, /enforceKeyAllowlist/);
  assert.match(src, /enforceWorkspaceResidencyForKey/);
  assert.match(src, /enforceWorkspaceApiKeyPolicyForKey/);
  // Per-key usage reads are themselves audited.
  assert.match(src, /v1\.keys\.usage\.read/);
  // Workspace scope is passed to summarize, not null.
  assert.match(src, /new Set<string>\(\[key\.workspaceId\]\)/);
  // keyId filter is the target's id, not the caller's id.
  assert.match(src, /summarize\([^)]*target\.id\)/);
});

test("spec: keys-id-usage is declared and points at the real route file", async () => {
  const { ENDPOINTS } = await import("../lib/api-spec.ts");
  const ep = ENDPOINTS.find((e: { id: string }) => e.id === "keys-id-usage");
  assert.ok(ep, "spec must declare the keys-id-usage endpoint");
  assert.equal(ep!.method, "GET");
  assert.equal(ep!.path, "/v1/keys/{id}/usage");
  assert.equal(ep!.scope, "usage:read");
  assert.ok(
    fs.existsSync(path.join(webRoot, ep!.routeFile)),
    "spec routeFile must exist on disk",
  );
});
