/**
 * Run with: node --test --experimental-strip-types web/tests/v1-keys-update-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping and least-privilege guarantees of the
 * new programmatic PATCH /v1/keys/[id] endpoint.
 *
 * The route handler imports next/server and cannot be loaded under
 * raw `node --test`, so this follows the existing pattern (see
 * v1-webhooks-tenant-isolation.test.ts) and covers the contract in
 * two layers:
 *
 *   1) Black-box assertions on `updateKeyForWorkspace` proving:
 *        - cross-tenant PATCH returns null (route surfaces 404),
 *        - scope narrowing succeeds and writes a meaningful diff,
 *        - scope widening is refused (throws),
 *        - cleared rpm / cleared ipAllowlist round-trip correctly,
 *        - revoked or expired keys are refused.
 *   2) Source-level assertions that the route file actually wires
 *      `keys:write`, the workspace gate, the self-target guard,
 *      audit, and the dry-run preview path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-patch-"));
process.env.CODECLONE_KEYS_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const {
  createKey,
  loadKey,
  loadKeyForWorkspace,
  updateKeyForWorkspace,
  revokeKey,
} = await import("../lib/api-keys.ts");

const WS_A = "ws_alpha1";
const WS_B = "ws_bravo2";

test("PATCH /v1/keys: cross-tenant update returns null (route surfaces 404)", async () => {
  const a = await createKey("alpha key", {
    workspaceId: WS_A,
    scopes: ["compare:write", "shares:read"],
  });
  const b = await createKey("bravo key", {
    workspaceId: WS_B,
    scopes: ["compare:write"],
  });

  // A cannot touch B's key.
  const cross = await updateKeyForWorkspace(b.record.id, WS_A, { label: "stolen" });
  assert.equal(cross, null, "cross-tenant PATCH must return null");

  // The actual stored record for B is untouched.
  const bRec = await loadKey(b.record.id);
  assert.ok(bRec);
  assert.equal(bRec!.label, "bravo key", "cross-tenant PATCH must not mutate the target");

  // Same-tenant PATCH on A succeeds and reports a real diff.
  const ok = await updateKeyForWorkspace(a.record.id, WS_A, { label: "alpha renamed" });
  assert.ok(ok);
  assert.equal(ok!.changed, true);
  assert.equal(ok!.diff.before.label, "alpha key");
  assert.equal(ok!.diff.after.label, "alpha renamed");
  const aReloaded = await loadKeyForWorkspace(a.record.id, WS_A);
  assert.equal(aReloaded!.label, "alpha renamed");
});

test("PATCH /v1/keys: scope narrowing succeeds, widening is refused", async () => {
  const k = await createKey("narrow me", {
    workspaceId: WS_A,
    scopes: ["compare:write", "shares:read", "usage:read"],
  });

  // Narrow: drop usage:read.
  const narrowed = await updateKeyForWorkspace(k.record.id, WS_A, {
    scopes: ["compare:write", "shares:read"],
  });
  assert.ok(narrowed);
  assert.equal(narrowed!.changed, true);
  assert.deepEqual(narrowed!.summary.scopes, ["compare:write", "shares:read"]);

  // Widen: try to add audit:read back, which was never granted.
  await assert.rejects(
    () =>
      updateKeyForWorkspace(k.record.id, WS_A, {
        scopes: ["compare:write", "shares:read", "audit:read"],
      }),
    /narrow, not widen/i,
    "PATCH must refuse to widen scopes",
  );

  // Re-widening to a previously held scope is also refused (you must
  // rotate or recreate to grant additional scopes).
  await assert.rejects(
    () =>
      updateKeyForWorkspace(k.record.id, WS_A, {
        scopes: ["compare:write", "shares:read", "usage:read"],
      }),
    /narrow, not widen/i,
  );

  // Clearing scopes outright is refused (would silently widen to
  // legacy full-privilege mode).
  await assert.rejects(
    () => updateKeyForWorkspace(k.record.id, WS_A, { scopes: null }),
    /cannot be cleared/i,
  );
});

test("PATCH /v1/keys: rpm + ipAllowlist set/clear round-trip", async () => {
  const k = await createKey("rpm-ip", { workspaceId: WS_A, scopes: ["compare:write"] });

  const set = await updateKeyForWorkspace(k.record.id, WS_A, {
    rpm: 42,
    ipAllowlist: ["10.0.0.0/8", "2001:db8::/32"],
  });
  assert.ok(set);
  assert.equal(set!.summary.rateLimit?.rpm, 42);
  assert.deepEqual(set!.summary.ipAllowlist, ["10.0.0.0/8", "2001:db8::/32"]);

  const cleared = await updateKeyForWorkspace(k.record.id, WS_A, {
    rpm: null,
    ipAllowlist: [],
  });
  assert.ok(cleared);
  assert.equal(cleared!.summary.rateLimit, undefined);
  assert.equal(cleared!.summary.ipAllowlist, undefined);
  assert.equal(cleared!.diff.before.rateLimit?.rpm, 42);
});

test("PATCH /v1/keys: refuses to edit a revoked key", async () => {
  const k = await createKey("revoked", { workspaceId: WS_A, scopes: ["compare:write"] });
  await revokeKey(k.record.id);
  await assert.rejects(
    () => updateKeyForWorkspace(k.record.id, WS_A, { label: "nope" }),
    /revoked/i,
  );
});

test("PATCH /v1/keys: expiresAt validation", async () => {
  const k = await createKey("exp", { workspaceId: WS_A, scopes: ["compare:write"] });

  await assert.rejects(
    () => updateKeyForWorkspace(k.record.id, WS_A, { expiresAt: Date.now() - 1000 }),
    /future epoch/i,
  );
  const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const set = await updateKeyForWorkspace(k.record.id, WS_A, { expiresAt: future });
  assert.ok(set);
  assert.equal(set!.summary.expiresAt, future);
});

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/keys/[id]/route.ts"),
  "utf8",
);

test("v1/keys/[id] route wires PATCH with scope, tenant gate, audit, and dry-run", () => {
  assert.match(routeSrc, /export async function PATCH/);
  assert.match(routeSrc, /hasScope\(key,\s*"keys:write"\)/);
  // Self-target guard: a caller cannot PATCH the key it is using.
  assert.match(routeSrc, /id === key\.id[\s\S]{0,80}selfTarget\(\)/);
  // Workspace-scoped store call.
  assert.match(routeSrc, /updateKeyForWorkspace\(id,\s*key\.workspaceId!?/);
  // Audited with a diff for SOC2 evidence.
  assert.match(routeSrc, /tryRecordAudit[\s\S]*v1\.keys\.update"/);
  // Dry-run preview path is wired.
  assert.match(routeSrc, /isDryRun\(req,\s*body\)/);
  assert.match(routeSrc, /v1\.keys\.update\.dry_run"/);
});
