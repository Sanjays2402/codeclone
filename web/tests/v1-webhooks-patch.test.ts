/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhooks-patch.test.ts
 *
 * Covers PATCH /v1/webhooks/[id] in two layers (same pattern as
 * v1-webhooks-tenant-isolation.test.ts, since next/server cannot be
 * loaded under raw node:test):
 *
 *   1) Black-box assertions on `updateWebhook` in lib/webhooks.ts:
 *      partial edits succeed, secret never rotates, no-op edits don't
 *      mutate, validation rejects bad URLs, workspace domain allowlist
 *      is honored, and cross-tenant edits fail without touching disk.
 *   2) Source-level assertions that the route file wires the
 *      webhooks:write scope, the tenant gate, dry-run preview, audit
 *      with before/after diff, rate limit, and all standard guards.
 *
 * A regression in any of these (forgetting the scope check, dropping
 * the workspaceId argument, skipping audit, allowing secret edit, or
 * skipping domain-allowlist enforcement on URL change) fails this
 * test instead of shipping a cross-tenant or compliance bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-hooks-patch-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createWebhook,
  updateWebhook,
  loadWebhook,
  loadWebhookForWorkspace,
} = await import("../lib/webhooks.ts");

const WS_A = "ws_alpha1";
const WS_B = "ws_bravo2";

test("updateWebhook: partial edits land, secret never rotates, updatedAt advances", async () => {
  const created = await createWebhook({
    label: "first",
    url: "https://example.com/first",
    events: ["compare.completed"],
    workspaceId: WS_A,
  });
  const before = await loadWebhook(created.record.id);
  assert.ok(before);
  const originalSecret = before.secretHash;

  // Sleep 1ms so updatedAt strictly advances on systems with coarse clocks.
  await new Promise((r) => setTimeout(r, 2));

  const r = await updateWebhook(created.record.id, WS_A, {
    label: "renamed",
    url: "https://example.com/second",
    events: ["compare.completed", "audit.recorded"],
  });
  assert.equal(r.changed, true);
  assert.equal(r.record.label, "renamed");
  assert.equal(r.record.url, "https://example.com/second");
  assert.deepEqual(r.record.events.slice().sort(), ["audit.recorded", "compare.completed"]);
  assert.deepEqual(r.diff.before.url, "https://example.com/first");
  assert.deepEqual(r.diff.after.url, "https://example.com/second");

  const after = await loadWebhook(created.record.id);
  assert.ok(after);
  assert.equal(after.secretHash, originalSecret, "PATCH must never rotate the signing secret");
  assert.equal(after.secretPrefix, before.secretPrefix);
  assert.ok((after.updatedAt ?? 0) > (before.updatedAt ?? before.createdAt));
});

test("updateWebhook: disabled toggle works and persists", async () => {
  const c = await createWebhook({
    label: "toggle",
    url: "https://example.com/toggle",
    workspaceId: WS_A,
  });
  const r1 = await updateWebhook(c.record.id, WS_A, { disabled: true });
  assert.equal(r1.changed, true);
  assert.equal(r1.record.disabled, true);
  const stored = await loadWebhook(c.record.id);
  assert.equal(stored?.disabled, true);

  // No-op repeat: changed=false, no diff entries.
  const r2 = await updateWebhook(c.record.id, WS_A, { disabled: true });
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.diff.before, {});
  assert.deepEqual(r2.diff.after, {});
});

test("updateWebhook: bad URL is rejected with a structured error", async () => {
  const c = await createWebhook({
    label: "bad",
    url: "https://example.com/bad",
    workspaceId: WS_A,
  });
  await assert.rejects(
    () => updateWebhook(c.record.id, WS_A, { url: "ftp://nope" }),
    /http or https|valid http/,
  );
  const after = await loadWebhook(c.record.id);
  assert.equal(after?.url, "https://example.com/bad", "rejected edit must not mutate the record");
});

test("updateWebhook: workspace domain allowlist is enforced on URL change", async () => {
  const c = await createWebhook({
    label: "allow",
    url: "https://allowed.example.com/hook",
    workspaceId: WS_A,
    domainAllowlist: ["allowed.example.com"],
  });
  await assert.rejects(
    () =>
      updateWebhook(c.record.id, WS_A, {
        url: "https://other.example.com/hook",
        domainAllowlist: ["allowed.example.com"],
      }),
    /domain allowlist/i,
  );
  // Same-domain change is fine.
  const ok = await updateWebhook(c.record.id, WS_A, {
    url: "https://allowed.example.com/hook2",
    domainAllowlist: ["allowed.example.com"],
  });
  assert.equal(ok.record.url, "https://allowed.example.com/hook2");
});

test("updateWebhook: cross-tenant edit is refused and does not touch disk", async () => {
  const c = await createWebhook({
    label: "owned-by-b",
    url: "https://example.com/b-only",
    workspaceId: WS_B,
  });
  await assert.rejects(
    () => updateWebhook(c.record.id, WS_A, { label: "stolen" }),
    /not found/i,
  );
  const stored = await loadWebhook(c.record.id);
  assert.equal(stored?.label, "owned-by-b");
  assert.ok(await loadWebhookForWorkspace(c.record.id, WS_B));
  assert.equal(await loadWebhookForWorkspace(c.record.id, WS_A), null);
});

const idRouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/[id]/route.ts"),
  "utf8",
);

test("v1/webhooks/[id] PATCH route wires scope, tenant, dry-run, audit-with-diff, and all guards", () => {
  assert.match(idRouteSrc, /export async function PATCH\(/);
  assert.match(idRouteSrc, /hasScope\(key,\s*"webhooks:write"\)/);
  assert.match(idRouteSrc, /updateWebhook\(id,\s*key\.workspaceId/);
  assert.match(idRouteSrc, /loadWebhookForWorkspace\(id,\s*key\.workspaceId\)/);
  assert.match(idRouteSrc, /v1\.webhooks\.update"/);
  assert.match(idRouteSrc, /v1\.webhooks\.update\.dry_run"/);
  assert.match(idRouteSrc, /diff:\s*result\.diff/);
  assert.match(idRouteSrc, /isDryRun\(req,\s*body\)/);
  assert.match(idRouteSrc, /tenant_required|tenantRequired/);
  // All standard procurement guards must apply to PATCH too.
  for (const guard of [
    /enforceRateLimit\(key\)/,
    /enforceWorkspaceAllowlistForKey/,
    /enforceKeyAllowlist/,
    /enforceWorkspaceLockdownForKey/,
    /enforceWorkspaceResidencyForKey/,
    /enforceWorkspaceApiKeyPolicyForKey/,
  ]) {
    // Each appears at least 3 times now (GET, DELETE, PATCH).
    const matches = idRouteSrc.match(new RegExp(guard.source, "g")) ?? [];
    assert.ok(matches.length >= 3, `${guard} must be wired into PATCH as well as GET+DELETE (saw ${matches.length})`);
  }
});
