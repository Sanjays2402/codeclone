/**
 * Run with: node --test --experimental-strip-types web/tests/v1-compare-tenant-isolation.test.ts
 *
 * Covers POST /v1/compare, the central similarity endpoint. The
 * high-value enterprise contract here is per-workspace tenant
 * isolation across every side-effect compare fires:
 *
 *   - audit rows are stamped with the calling key's userId
 *   - usage events are stamped with key.workspaceId
 *   - webhook fan-out is scoped to key.workspaceId
 *   - the workspace fetched for plan/quota is the calling key's
 *     workspaceId, never one selected by the request body or
 *     query string
 *
 * Without these, one customer's /v1/compare call could surface in
 * another customer's usage rollups, webhook stream, or audit log,
 * which is an immediate SOC2 procurement blocker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-compare-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-compare-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-compare-ws-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-compare-audit-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "compare", "route.ts"),
  "utf8",
);

const { createKey, hasScope } = await import("../lib/api-keys.ts");
const usageMod = await import("../lib/usage.ts");

test("v1/compare: route source wires scope, rate-limit, enforcement chain, audit", () => {
  // Scope contract: compare:write only. A read-only key must not be
  // able to call the central similarity endpoint.
  assert.match(routeSrc, /hasScope\(key, "compare:write"\)/);

  // Must enforce (billable), not peek. Compare is the metered call
  // every plan rolls up against.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "v1/compare must enforce, not peek",
  );

  // Standard workspace enforcement chain. If any of these regress,
  // a customer could bypass lockdown, IP allowlist, residency, key
  // policy, or DPA acceptance.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(routeSrc, /enforceWorkspaceDpaForKey/);

  // Audit row written under a stable action id security teams grep
  // for. The compare row is the SOC2-relevant evidence that a given
  // key did similarity work, on what language, against what byte
  // budget.
  assert.match(routeSrc, /"v1\.compare"/);
});

test("v1/compare: every side-effect is scoped to the calling key's tenant", () => {
  // Audit: actorId = key.userId. Never a userId pulled from the
  // request body, headers, or query string.
  assert.match(routeSrc, /actorId:\s*key\.userId/);
  assert.ok(
    !/actorId:\s*(raw|body|searchParams|req\.headers)/.test(routeSrc),
    "v1/compare must not let the request select audit actor",
  );

  // Usage event: workspaceId = key.workspaceId. This is what /v1/usage
  // and the dashboard rollups filter on, so any other value would
  // leak this call into a different tenant's invoice.
  assert.match(routeSrc, /workspaceId:\s*key\.workspaceId/);

  // Webhook dispatch: workspaceId = key.workspaceId. dispatchEvent
  // fans out to receivers registered in that workspace only; passing
  // null or another id would deliver this customer's payload to
  // another customer's receiver.
  assert.match(routeSrc, /workspaceId:\s*key\.workspaceId\s*\?\?\s*null/);

  // Plan workspace fetch must use key.workspaceId. No path may let a
  // query string or body field select another workspace's plan
  // headroom.
  assert.match(routeSrc, /getWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(routeSrc),
    "v1/compare must not let query string select workspace",
  );
  assert.ok(
    !/raw\.workspaceId|body\.workspaceId/.test(routeSrc),
    "v1/compare must not let body select workspace",
  );
});

test("v1/compare: hasScope enforces compare:write and rejects unrelated scopes", async () => {
  const compareKey = await createKey("compare-writer", {
    userId: "user_alice",
    workspaceId: "ws_alpha1",
    scopes: ["compare:write"],
  });
  const readOnly = await createKey("snippets-reader", {
    userId: "user_bob",
    workspaceId: "ws_beta01",
    scopes: ["snippets:read"],
  });

  assert.equal(hasScope(compareKey.record, "compare:write"), true);
  assert.equal(hasScope(readOnly.record, "compare:write"), false);
});

test("v1/compare: live per-workspace tenant isolation on usage rollups", async () => {
  // Two workspaces, two keys, both call /v1/compare-equivalent
  // logUsage with the SAME shape the route would write. The
  // summarize() rollup must partition by workspaceId.
  const keyA = await createKey("alpha-compare", {
    userId: "user_alice",
    workspaceId: "ws_alpha1",
    scopes: ["compare:write"],
  });
  const keyB = await createKey("beta-compare", {
    userId: "user_bob",
    workspaceId: "ws_beta01",
    scopes: ["compare:write"],
  });

  const now = Date.now();
  await usageMod.logUsage({
    ts: now,
    keyId: keyA.record.id,
    endpoint: "/v1/compare",
    bytes: 1024,
    latencyMs: 2.5,
    workspaceId: keyA.record.workspaceId,
  });
  await usageMod.logUsage({
    ts: now,
    keyId: keyB.record.id,
    endpoint: "/v1/compare",
    bytes: 2048,
    latencyMs: 3.0,
    workspaceId: keyB.record.workspaceId,
  });

  // Workspace alpha's view must not see workspace beta's call, and
  // vice versa. summarize() takes a Set<string> scope of allowed
  // workspace ids; passing only alpha must filter beta out.
  const alphaView = await usageMod.summarize(30, now, new Set(["ws_alpha1"]));
  const betaView = await usageMod.summarize(30, now, new Set(["ws_beta01"]));

  // The summary must not expose the other workspace's keyId. The
  // exact shape varies but the contract is: total bytes for alpha is
  // alpha's bytes only.
  const alphaKeyIds = (alphaView.byKey ?? []).map((k: { keyId: string }) => k.keyId);
  const betaKeyIds = (betaView.byKey ?? []).map((k: { keyId: string }) => k.keyId);
  assert.ok(
    alphaKeyIds.includes(keyA.record.id),
    "alpha summary must include alpha's compare call",
  );
  assert.ok(
    !alphaKeyIds.includes(keyB.record.id),
    "alpha summary must NEVER include beta's compare call",
  );
  assert.ok(
    betaKeyIds.includes(keyB.record.id),
    "beta summary must include beta's compare call",
  );
  assert.ok(
    !betaKeyIds.includes(keyA.record.id),
    "beta summary must NEVER include alpha's compare call",
  );
});
