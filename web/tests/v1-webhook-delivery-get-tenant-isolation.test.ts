/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhook-delivery-get-tenant-isolation.test.ts
 *
 * Proves tenant-scoping and contract guarantees for:
 *
 *   GET /v1/webhooks/[id]/deliveries/[deliveryId]
 *
 * The route handler imports next/server and cannot be loaded under
 * raw `node --test`, so we follow the existing pattern (see
 * v1-webhook-deliveries-tenant-isolation.test.ts) and cover the
 * contract in two layers:
 *
 *   1) Black-box assertion on the underlying lib: a workspace cannot
 *      see another workspace's delivery via the same lookup the route
 *      uses (listDeliveriesForWorkspace + id filter).
 *   2) Source-level assertions that the route file actually wires
 *      the right scope, the tenant load, usage logging, and the full
 *      enforcement chain (lockdown, IP allowlists, residency, API
 *      key policy, rate limit) shared by every /v1 route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-hook-deliv-get-iso-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  listDeliveriesForWorkspace,
  dispatchEvent,
} = await import("../lib/webhooks.ts");

const WS_A = "ws_foxtrot1";
const WS_B = "ws_golf22";

test("v1 webhook single-delivery GET is tenant-scoped via the lib the route calls", async () => {
  const a = await createWebhook({
    label: "alpha",
    url: "https://example.com/a",
    workspaceId: WS_A,
  });
  const b = await createWebhook({
    label: "bravo",
    url: "https://example.com/b",
    workspaceId: WS_B,
  });

  const stubOk: typeof fetch = async () =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  await dispatchEvent({
    workspaceId: WS_A,
    event: "compare.completed",
    payload: { hello: "alpha" },
    fetchImpl: stubOk,
  });
  await dispatchEvent({
    workspaceId: WS_B,
    event: "compare.completed",
    payload: { hello: "bravo" },
    fetchImpl: stubOk,
  });

  const listA = await listDeliveriesForWorkspace(a.record.id, WS_A);
  const listB = await listDeliveriesForWorkspace(b.record.id, WS_B);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);

  // Same-tenant single-delivery lookup (route does: list-then-find).
  const sameTenant = listA.find((d) => d.id === listA[0].id) ?? null;
  assert.ok(sameTenant, "same-tenant single delivery lookup must succeed");

  // Cross-tenant probe: workspace A asking for workspace B's
  // delivery by id must come back empty (route surfaces flat 404,
  // never 403, so the delivery's existence cannot be probed).
  const crossList = await listDeliveriesForWorkspace(b.record.id, WS_A);
  assert.equal(crossList.length, 0);
  const crossLookup = crossList.find((d) => d.id === listB[0].id) ?? null;
  assert.equal(crossLookup, null, "cross-tenant single delivery lookup must be null");
});

const routeSrc = fs.readFileSync(
  path.join(
    webRoot,
    "app/api/v1/webhooks/[id]/deliveries/[deliveryId]/route.ts",
  ),
  "utf8",
);

test("v1 webhook single-delivery GET wires read scope, tenant load, and usage", () => {
  assert.match(routeSrc, /hasScope\(key,\s*"webhooks:read"\)/);
  assert.match(routeSrc, /loadWebhookForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(routeSrc, /listDeliveriesForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(routeSrc, /tenant_required/);
  assert.match(routeSrc, /logUsage/);
  // Flat 404, never 403, on cross-tenant or missing delivery.
  assert.match(routeSrc, /Webhook or delivery not found/);
});

test("v1 webhook single-delivery GET enforces the full /v1 chain", () => {
  assert.match(routeSrc, /enforceRateLimit\(key\)/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
});
