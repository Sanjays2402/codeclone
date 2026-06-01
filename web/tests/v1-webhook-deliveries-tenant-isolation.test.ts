/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhook-deliveries-tenant-isolation.test.ts
 *
 * Proves tenant-scoping and contract guarantees for the programmatic
 * webhook delivery log + replay endpoints:
 *
 *   GET  /v1/webhooks/[id]/deliveries
 *   POST /v1/webhooks/[id]/deliveries/[deliveryId]/redeliver
 *
 * The route handlers themselves import next/server and cannot be
 * loaded under raw `node --test`, so we follow the existing pattern
 * (see v1-webhooks-tenant-isolation.test.ts) and cover the contract
 * in two layers:
 *
 *   1) Black-box assertions on the underlying lib (lib/webhooks.ts):
 *      one workspace cannot list or replay another workspace's
 *      deliveries via the same functions the routes delegate to.
 *   2) Source-level assertions that both route files actually wire
 *      the right scope, the tenant load, audit on mutation, and the
 *      full enforcement chain (lockdown, IP allowlists, residency,
 *      API key policy, rate limit) shared by every /v1 route.
 *
 * Together these guarantee a regression (forgetting the scope check,
 * dropping the workspaceId argument, or skipping audit) fails this
 * test instead of shipping a cross-tenant disclosure bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-hook-deliv-iso-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  listDeliveriesForWorkspace,
  redeliverDelivery,
  dispatchEvent,
} = await import("../lib/webhooks.ts");

const WS_A = "ws_delta1";
const WS_B = "ws_echo22";

test("v1 webhook deliveries: list + redeliver are tenant-scoped via the lib the routes call", async () => {
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

  // Generate one delivery in each workspace using a stub fetch so we
  // do not touch the network. The route's `webhooks:read` path lists
  // these via listDeliveriesForWorkspace, exactly as our handler does.
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
  assert.equal(listA.length, 1, "workspace A should see its own delivery");
  assert.equal(listB.length, 1, "workspace B should see its own delivery");

  // Cross-tenant probe must return empty (the route surfaces 404, NOT
  // 403, so the existence of another tenant's webhook cannot be
  // probed). This is the central isolation contract.
  const crossList = await listDeliveriesForWorkspace(b.record.id, WS_A);
  assert.equal(crossList.length, 0, "cross-tenant delivery list must be empty");

  // Cross-tenant redeliver must refuse without leaking that the
  // delivery exists somewhere. The route maps `null` to a flat 404.
  const crossReplay = await redeliverDelivery(
    b.record.id,
    listB[0].id,
    WS_A,
  );
  assert.equal(crossReplay, null, "cross-tenant redeliver must return null");

  // Same-tenant redeliver succeeds (using the same stub fetch path so
  // tests stay hermetic). We do not rely on the network here.
  const sameReplay = await redeliverDelivery(
    a.record.id,
    listA[0].id,
    WS_A,
    stubOk,
  );
  assert.ok(sameReplay, "same-tenant redeliver must produce a delivery");
  assert.equal(sameReplay!.redeliveredFrom, listA[0].id);
  assert.equal(sameReplay!.ok, true);
});

const listRouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/[id]/deliveries/route.ts"),
  "utf8",
);
const replayRouteSrc = fs.readFileSync(
  path.join(
    webRoot,
    "app/api/v1/webhooks/[id]/deliveries/[deliveryId]/redeliver/route.ts",
  ),
  "utf8",
);

test("v1 webhook deliveries GET wires read scope, tenant load, and usage", () => {
  assert.match(listRouteSrc, /hasScope\(key,\s*"webhooks:read"\)/);
  assert.match(listRouteSrc, /loadWebhookForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(listRouteSrc, /listDeliveriesForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(listRouteSrc, /tenant_required/);
  assert.match(listRouteSrc, /logUsage/);
});

test("v1 webhook deliveries redeliver wires write scope, tenant load, dry-run, and audit", () => {
  assert.match(replayRouteSrc, /hasScope\(key,\s*"webhooks:write"\)/);
  assert.match(replayRouteSrc, /loadWebhookForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(replayRouteSrc, /redeliverDelivery\(id,\s*deliveryId,\s*key\.workspaceId\)/);
  assert.match(replayRouteSrc, /isDryRun\(req,\s*body\)/);
  assert.match(replayRouteSrc, /tryRecordAudit[\s\S]*v1\.webhooks\.redeliver\.dry_run"/);
  assert.match(replayRouteSrc, /tryRecordAudit[\s\S]*v1\.webhooks\.redeliver"/);
  assert.match(replayRouteSrc, /tenant_required/);
});

test("v1 webhook deliveries routes enforce the full /v1 chain", () => {
  for (const src of [listRouteSrc, replayRouteSrc]) {
    assert.match(src, /enforceRateLimit\(key\)/);
    assert.match(src, /enforceWorkspaceAllowlistForKey/);
    assert.match(src, /enforceKeyAllowlist/);
    assert.match(src, /enforceWorkspaceLockdownForKey/);
    assert.match(src, /enforceWorkspaceResidencyForKey/);
    assert.match(src, /enforceWorkspaceApiKeyPolicyForKey/);
  }
});
