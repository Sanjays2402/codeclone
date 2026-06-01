/**
 * Run with: node --test --experimental-strip-types web/tests/v1-usage.test.ts
 *
 * Covers the GET /v1/usage programmatic FinOps endpoint:
 *
 *   1) The route file actually wires the scope check, the per-key
 *      rate-limit enforce (not peek — billable), the workspace
 *      enforcement chain, the WorkspaceScope filter on summarize(),
 *      and the audit row. A regression that drops any of these
 *      fails this test.
 *
 *   2) Live behavioural test of the underlying summarize() with
 *      a WorkspaceScope set: events logged for workspace A are
 *      invisible to a scope of {workspace B}. This is the
 *      cross-tenant isolation evidence: a customer key minted in
 *      workspace B can never see workspace A's call volumes or
 *      keyIds, even when both tenants share the same usage store.
 *
 *   3) Scope enforcement: hasScope() rejects a key minted with
 *      only compare:write when usage:read is required, and accepts
 *      a key minted with usage:read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-usage-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-usage-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "usage", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES } = await import("../lib/api-keys.ts");
const { logUsage, summarize } = await import("../lib/usage.ts");

test("v1/usage: route source wires scope, rate-limit, scope filter, and audit", () => {
  assert.match(routeSrc, /hasScope\(key, "usage:read"\)/);
  // Must call enforce, not peek — /v1/usage is billable against the per-key
  // window so an attacker can't use it as a free heartbeat.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "v1/usage must enforce, not peek");
  // Standard workspace enforcement chain.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: the summarize call must be scoped to the key's workspace.
  assert.match(routeSrc, /new Set<string>\([\s\S]*?key\.workspaceId/);
  assert.match(routeSrc, /summarize\(daysParsed\.value, Date\.now\(\), scope\)/);
  // Audit row written under a stable action id finance can grep for.
  assert.match(routeSrc, /"v1\.usage\.read"/);
});

test("v1/usage: ALL_SCOPES exposes usage:read so the UI can grant it", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("usage:read"));
});

test("v1/usage: hasScope rejects keys without usage:read and accepts keys with it", async () => {
  const compareOnly = await createKey("compare-only", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
  });
  const usageOk = await createKey("usage-reader", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write", "usage:read"],
  });
  assert.equal(hasScope(compareOnly.record, "usage:read"), false);
  assert.equal(hasScope(usageOk.record, "usage:read"), true);
});

test("v1/usage: WorkspaceScope filter on summarize gives strict cross-tenant isolation", async () => {
  // Log a mix of events for two tenants against the same usage store.
  for (let i = 0; i < 5; i++) {
    await logUsage({
      ts: Date.now() - i * 60_000,
      keyId: "key_in_a",
      endpoint: "/v1/compare",
      bytes: 100,
      latencyMs: 12,
      workspaceId: "ws_tenanta",
    });
  }
  for (let i = 0; i < 3; i++) {
    await logUsage({
      ts: Date.now() - i * 60_000,
      keyId: "key_in_b",
      endpoint: "/v1/compare",
      bytes: 50,
      latencyMs: 8,
      workspaceId: "ws_tenantb",
    });
  }

  const aScope = new Set<string>(["ws_tenanta"]);
  const bScope = new Set<string>(["ws_tenantb"]);
  const emptyScope = new Set<string>();

  const aView = await summarize(7, Date.now(), aScope);
  const bView = await summarize(7, Date.now(), bScope);
  const noView = await summarize(7, Date.now(), emptyScope);

  // Tenant A sees only its own events and its own keyIds.
  assert.equal(aView.totalCalls, 5);
  assert.deepEqual(
    aView.byKey.map((r) => r.keyId).sort(),
    ["key_in_a"],
  );
  assert.ok(!aView.byKey.some((r) => r.keyId === "key_in_b"), "tenant A must not see tenant B keyIds");

  // Tenant B sees only its own events.
  assert.equal(bView.totalCalls, 3);
  assert.deepEqual(
    bView.byKey.map((r) => r.keyId).sort(),
    ["key_in_b"],
  );
  assert.ok(!bView.byKey.some((r) => r.keyId === "key_in_a"), "tenant B must not see tenant A keyIds");

  // A key with no workspace gets an empty scope and sees nothing.
  assert.equal(noView.totalCalls, 0);
  assert.equal(noView.byKey.length, 0);
});
