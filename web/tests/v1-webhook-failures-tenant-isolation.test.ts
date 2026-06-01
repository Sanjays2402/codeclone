/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhook-failures-tenant-isolation.test.ts
 *
 * Proves the contract guarantees for the programmatic SIEM-friendly
 * webhook-failure feed:
 *
 *   GET /v1/webhooks/failures
 *
 * The route handler imports next/server and cannot be loaded under raw
 * `node --test`, so we follow the existing /v1 testing pattern (see
 * v1-webhook-deliveries-tenant-isolation.test.ts):
 *
 *   1) Black-box assertions on collectRecentFailures with workspaceId:
 *      one workspace cannot see another workspace's webhook failures
 *      via the function the route delegates to.
 *   2) Source-level assertions that the route file actually wires the
 *      right scope, the tenant scope, audit, usage logging, NDJSON
 *      default, and the full enforcement chain (lockdown, IP
 *      allowlists, residency, API key policy, rate limit) shared by
 *      every /v1 route.
 *
 * Together these mean a regression (forgetting the scope check, dropping
 * the workspaceId, skipping audit, or removing the rate-limit guard)
 * fails this test instead of shipping a cross-tenant disclosure bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-hook-fail-iso-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  dispatchEvent,
} = await import("../lib/webhooks.ts");
const { collectRecentFailures } = await import("../lib/recent-failures.ts");

const WS_A = "ws_failalpha1";
const WS_B = "ws_failbravo2";

test("v1 webhook failures: tenant-scoped via collectRecentFailures(workspaceId)", async () => {
  await createWebhook({
    label: "alpha",
    url: "https://example.com/a",
    workspaceId: WS_A,
  });
  await createWebhook({
    label: "bravo",
    url: "https://example.com/b",
    workspaceId: WS_B,
  });

  // Generate one failure in each workspace using a stubbed fetch.
  const stubFail: typeof fetch = async () =>
    new Response("boom", { status: 503, headers: { "content-type": "text/plain" } });
  await dispatchEvent({
    workspaceId: WS_A,
    event: "compare.completed",
    payload: { hello: "alpha" },
    fetchImpl: stubFail,
  });
  await dispatchEvent({
    workspaceId: WS_B,
    event: "compare.completed",
    payload: { hello: "bravo" },
    fetchImpl: stubFail,
  });

  const onlyA = await collectRecentFailures({ workspaceId: WS_A });
  const onlyB = await collectRecentFailures({ workspaceId: WS_B });

  assert.equal(onlyA.length, 1, "workspace A should see its own failure");
  assert.equal(onlyB.length, 1, "workspace B should see its own failure");
  assert.equal(onlyA[0]!.label, "alpha");
  assert.equal(onlyB[0]!.label, "bravo");
  assert.ok(
    !onlyA.some((f) => f.label === "bravo"),
    "workspace A must never see workspace B's failures",
  );
  assert.ok(
    !onlyB.some((f) => f.label === "alpha"),
    "workspace B must never see workspace A's failures",
  );
});

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/failures/route.ts"),
  "utf8",
);

test("v1 webhook failures GET wires read scope, tenant scope, audit, usage", () => {
  assert.match(routeSrc, /hasScope\(key,\s*"webhooks:read"\)/);
  assert.match(routeSrc, /collectRecentFailures\([\s\S]*workspaceId:\s*key\.workspaceId/);
  assert.match(routeSrc, /tenant_required/);
  assert.match(routeSrc, /tryRecordAudit[\s\S]*v1\.webhooks\.failures\.read"/);
  assert.match(routeSrc, /logUsage/);
  assert.match(routeSrc, /endpoint:\s*"\/v1\/webhooks\/failures"/);
});

test("v1 webhook failures defaults to NDJSON and supports JSON", () => {
  assert.match(routeSrc, /"ndjson"/);
  assert.match(routeSrc, /application\/x-ndjson/);
  assert.match(routeSrc, /format[\s\S]*ndjson[\s\S]*json/);
});

test("v1 webhook failures enforces the full /v1 chain", () => {
  assert.match(routeSrc, /enforceRateLimit\(key\)/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
});
