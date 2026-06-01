/**
 * Run with:
 *   node --test --experimental-strip-types web/tests/v1-webhooks-rotate-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping contract for /v1/webhooks/[id]/rotate.
 *
 * The route handler imports next/server and cannot be loaded under raw
 * `node --test`, so we follow the existing pattern (see
 * v1-webhooks-tenant-isolation.test.ts) and cover the contract in two
 * layers:
 *
 *   1) Black-box assertions on lib/webhooks.ts: rotate, finalize and
 *      cancel reject cross-tenant calls AND never mutate the target
 *      record. This is exactly the scoping the route delegates to.
 *   2) Source-level assertions that the route file actually wires the
 *      'webhooks:write' scope check, the workspace gate, audit, and
 *      the rest of the workspace policy fence (allowlist, residency,
 *      lockdown).
 *
 * Together these guarantee that a regression - forgetting the scope
 * check, dropping the workspaceId argument, or skipping audit - fails
 * this test instead of shipping a cross-tenant rotation oracle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-rotate-iso-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  rotateSecret,
  finalizeRotation,
  cancelRotation,
  loadWebhookForWorkspace,
} = await import("../lib/webhooks.ts");

const WS_A = "ws_alpha1";
const WS_B = "ws_bravo2";

test("v1 webhooks rotate: rotate is tenant-scoped via the lib the route calls", async () => {
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

  // Cross-tenant rotate returns null AND does not touch the target.
  const crossRotate = await rotateSecret(b.record.id, WS_A);
  assert.equal(crossRotate, null, "rotateSecret must refuse cross-tenant");
  const bAfterCross = await loadWebhookForWorkspace(b.record.id, WS_B);
  assert.ok(bAfterCross, "cross-tenant rotate must not delete the target");
  assert.equal(
    bAfterCross!.pendingSecretPrefix,
    undefined,
    "cross-tenant rotate must not seed a pending secret on the target",
  );

  // Same-tenant rotate succeeds and seeds pending fields.
  const ok = await rotateSecret(a.record.id, WS_A, 60_000);
  assert.ok(ok, "same-tenant rotate must succeed");
  assert.ok(ok!.secret.startsWith("whsec_"), "rotate must return a fresh plaintext");
  assert.ok(ok!.record.pendingSecretPrefix, "rotate must seed a pending prefix");
  assert.ok(ok!.expiresAt > Date.now(), "rotate must set a future expiry");

  // Cross-tenant finalize returns null and does not promote.
  const crossFin = await finalizeRotation(a.record.id, WS_B);
  assert.equal(crossFin, null, "finalizeRotation must refuse cross-tenant");
  const aStill = await loadWebhookForWorkspace(a.record.id, WS_A);
  assert.ok(
    aStill!.pendingSecretPrefix,
    "cross-tenant finalize must not promote pending to primary",
  );

  // Cross-tenant cancel returns null and does not clear pending.
  const crossCancel = await cancelRotation(a.record.id, WS_B);
  assert.equal(crossCancel, null, "cancelRotation must refuse cross-tenant");
  const aStill2 = await loadWebhookForWorkspace(a.record.id, WS_A);
  assert.ok(
    aStill2!.pendingSecretPrefix,
    "cross-tenant cancel must leave the pending secret intact",
  );

  // Owning workspace can cancel its own pending rotation.
  const ownCancel = await cancelRotation(a.record.id, WS_A);
  assert.ok(ownCancel, "owner cancel must succeed");
  assert.equal(
    ownCancel!.pendingSecretPrefix,
    undefined,
    "owner cancel must clear the pending prefix",
  );

  // Touch b: rotate + finalize round-trip works inside its own tenant.
  const r2 = await rotateSecret(b.record.id, WS_B, 60_000);
  assert.ok(r2);
  const fin = await finalizeRotation(b.record.id, WS_B);
  assert.ok(fin);
  assert.equal(
    fin!.pendingSecretPrefix,
    undefined,
    "finalize must clear pending after promoting",
  );
  assert.equal(
    fin!.secretPrefix,
    r2!.record.pendingSecretPrefix,
    "finalize must promote the rotated prefix to primary",
  );
});

test("v1 webhooks rotate: route source wires scope, workspace gate, and audit", async () => {
  const routePath = path.join(
    webRoot,
    "app/api/v1/webhooks/[id]/rotate/route.ts",
  );
  const src = fs.readFileSync(routePath, "utf-8");

  // Bearer auth wired (matches the rest of /v1).
  assert.match(src, /extractBearer\(/, "must extract a bearer token");
  assert.match(src, /findByPlaintext\(/, "must resolve the key from plaintext");

  // Scope gate is the same one that gates webhook create/delete.
  assert.match(
    src,
    /hasScope\(key,\s*["']webhooks:write["']\)/,
    "must require the webhooks:write scope",
  );
  assert.match(
    src,
    /insufficientScope\(["']webhooks:write["']/,
    "must surface insufficient_scope with the right scope name",
  );

  // Workspace-scoping: every rotate / finalize / cancel must be called
  // with key.workspaceId. A regression that drops the second argument
  // (current call: `rotateSecret(id, key.workspaceId!, ...)`) would let
  // a key from workspace A rotate workspace B's secret, which is the
  // failure mode this test is here to prevent.
  assert.match(
    src,
    /rotateSecret\(id,\s*key\.workspaceId!/,
    "rotateSecret must be scoped to the calling key's workspace",
  );
  assert.match(
    src,
    /finalizeRotation\(id,\s*key\.workspaceId!\)/,
    "finalizeRotation must be scoped to the calling key's workspace",
  );
  assert.match(
    src,
    /cancelRotation\(id,\s*key\.workspaceId!\)/,
    "cancelRotation must be scoped to the calling key's workspace",
  );
  assert.match(
    src,
    /loadWebhookForWorkspace\(id,\s*key\.workspaceId!\)/,
    "pre-flight lookup must be workspace-scoped",
  );

  // Tenant-required guard: keys with no workspace can never use this.
  assert.match(src, /tenantRequired\(\)/, "must reject workspaceId-less keys");

  // Workspace policy fence is fully wired (same as sibling /v1 routes).
  assert.match(src, /enforceWorkspaceAllowlistForKey/);
  assert.match(src, /enforceKeyAllowlist/);
  assert.match(src, /enforceWorkspaceLockdownForKey/);
  assert.match(src, /enforceWorkspaceResidencyForKey/);
  assert.match(src, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(src, /enforceRateLimit\(key\)/);

  // Every mutating verb writes a v1.* audit entry with workspaceId.
  assert.match(src, /v1\.webhooks\.secret\.rotate_initiate/);
  assert.match(src, /v1\.webhooks\.secret\.rotate_finalize/);
  assert.match(src, /v1\.webhooks\.secret\.rotate_cancel/);
  // workspaceId is carried into audit so SIEM filtering still works.
  assert.match(
    src,
    /workspaceId:\s*key\.workspaceId!/,
    "audit entries must carry the workspaceId",
  );
});
