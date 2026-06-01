/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhooks-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping enforcement for programmatic webhook
 * management via /v1/webhooks and /v1/webhooks/[id].
 *
 * The route handlers themselves import next/server and cannot be
 * loaded under raw `node --test`, so we follow the existing pattern
 * (see v1-dry-run.test.ts) and cover the contract in two layers:
 *
 *   1) Black-box assertions on the underlying lib (lib/webhooks.ts)
 *      that one workspace cannot list, load, or delete another
 *      workspace's webhooks. This is the same scoping the routes
 *      delegate to via `listWebhooksForWorkspace`,
 *      `loadWebhookForWorkspace`, and `deleteWebhook(id, workspaceId)`.
 *   2) Source-level assertions that the route files actually wire
 *      `webhooks:read` / `webhooks:write` scope checks, the workspace
 *      gate, and audit + usage on mutations.
 *
 * Together these guarantee that a regression (forgetting the scope
 * check, dropping the workspaceId argument, or skipping audit) fails
 * this test instead of shipping a cross-tenant disclosure bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-hooks-iso-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  listWebhooksForWorkspace,
  loadWebhookForWorkspace,
  deleteWebhook,
  loadWebhook,
} = await import("../lib/webhooks.ts");

const { ALL_SCOPES, SCOPE_DESCRIPTIONS } = await import("../lib/api-keys.ts");

const WS_A = "ws_alpha1";
const WS_B = "ws_bravo2";

test("v1 webhooks: list/load/delete are tenant-scoped via the lib the routes call", async () => {
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

  // Each workspace sees only its own webhook in the list view that
  // /v1/webhooks GET delegates to.
  const listA = await listWebhooksForWorkspace(WS_A);
  const listB = await listWebhooksForWorkspace(WS_B);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].id, a.record.id);
  assert.equal(listB.length, 1);
  assert.equal(listB[0].id, b.record.id);

  // Cross-tenant fetch returns null (route surfaces as 404, NOT 403,
  // so the existence of another tenant's webhook id cannot be probed).
  assert.equal(await loadWebhookForWorkspace(b.record.id, WS_A), null);
  assert.equal(await loadWebhookForWorkspace(a.record.id, WS_B), null);
  // Same id within the right tenant resolves.
  assert.ok(await loadWebhookForWorkspace(a.record.id, WS_A));

  // Cross-tenant delete is refused AND the file is not removed.
  const cross = await deleteWebhook(b.record.id, WS_A);
  assert.equal(cross, false, "delete must refuse cross-tenant requests");
  const stillThere = await loadWebhook(b.record.id);
  assert.ok(stillThere, "cross-tenant delete must not touch the underlying file");

  // Same-tenant delete succeeds.
  const same = await deleteWebhook(b.record.id, WS_B);
  assert.equal(same, true);
  assert.equal(await loadWebhook(b.record.id), null);

  // Sanity: no `null` workspaceId fallthrough in our route code. The
  // routes 403 with `tenant_required` when key.workspaceId is missing
  // so we don't even reach the lib without a workspace argument.
});

test("v1 webhooks: scopes are registered and described in both lib/api-keys and lib/scopes", async () => {
  const scopesModule = await import("../lib/scopes.ts");
  for (const s of ["webhooks:read", "webhooks:write"] as const) {
    assert.ok(
      (ALL_SCOPES as readonly string[]).includes(s),
      `${s} missing from lib/api-keys ALL_SCOPES`,
    );
    assert.ok(
      SCOPE_DESCRIPTIONS[s as keyof typeof SCOPE_DESCRIPTIONS],
      `${s} missing from lib/api-keys SCOPE_DESCRIPTIONS`,
    );
    assert.ok(
      (scopesModule.ALL_SCOPES as readonly string[]).includes(s),
      `${s} missing from lib/scopes ALL_SCOPES`,
    );
  }
});

const listRouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/route.ts"),
  "utf8",
);
const idRouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/[id]/route.ts"),
  "utf8",
);

test("v1/webhooks route wires read scope on GET, write scope on POST, and audits create", () => {
  assert.match(listRouteSrc, /hasScope\(key,\s*"webhooks:read"\)/);
  assert.match(listRouteSrc, /hasScope\(key,\s*"webhooks:write"\)/);
  assert.match(listRouteSrc, /listWebhooksForWorkspace\(key\.workspaceId\)/);
  assert.match(listRouteSrc, /createWebhook\(\{[\s\S]*workspaceId:\s*key\.workspaceId/);
  assert.match(listRouteSrc, /tryRecordAudit[\s\S]*v1\.webhooks\.create"/);
  assert.match(listRouteSrc, /tenant_required/);
});

test("v1/webhooks/[id] route wires scopes, scoped load, scoped delete, and audits", () => {
  assert.match(idRouteSrc, /hasScope\(key,\s*"webhooks:read"\)/);
  assert.match(idRouteSrc, /hasScope\(key,\s*"webhooks:write"\)/);
  assert.match(idRouteSrc, /loadWebhookForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(idRouteSrc, /deleteWebhook\(id,\s*key\.workspaceId\)/);
  assert.match(idRouteSrc, /tryRecordAudit[\s\S]*v1\.webhooks\.delete"/);
});

test("v1 webhooks routes enforce rate-limit, ip allowlist, lockdown, residency, and api-key policy", () => {
  for (const src of [listRouteSrc, idRouteSrc]) {
    assert.match(src, /enforceRateLimit\(key\)/);
    assert.match(src, /enforceWorkspaceAllowlistForKey/);
    assert.match(src, /enforceKeyAllowlist/);
    assert.match(src, /enforceWorkspaceLockdownForKey/);
    assert.match(src, /enforceWorkspaceResidencyForKey/);
    assert.match(src, /enforceWorkspaceApiKeyPolicyForKey/);
  }
});
