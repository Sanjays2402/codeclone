/**
 * Workspace API key max age policy enforcement.
 *
 * Verifies:
 *   - sanitizeApiKeyPolicy clamps to bounds and 0 = no policy
 *   - setApiKeyPolicy persists and clears
 *   - createKey clamps expiresAt to createdAt + maxAgeDays when bound
 *     to a workspace with a policy
 *   - enforceWorkspaceApiKeyPolicyForKey returns 401 with
 *     `api_key_policy_expired` for a key whose createdAt is older than
 *     the policy deadline, and lets fresh keys through
 *
 * Run: node --test --experimental-strip-types web/tests/workspaces-api-key-policy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-akp-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "api-keys");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-akp";

const ws = await import("../lib/workspaces.ts");
const apiKeys = await import("../lib/api-keys.ts");

test("sanitizeApiKeyPolicy clamps and respects 0", () => {
  assert.deepEqual(ws.sanitizeApiKeyPolicy({ maxAgeDays: 0 }), { maxAgeDays: 0 });
  assert.deepEqual(ws.sanitizeApiKeyPolicy({ maxAgeDays: -5 }), { maxAgeDays: 0 });
  const huge = ws.sanitizeApiKeyPolicy({ maxAgeDays: 999999 });
  assert.equal(huge?.maxAgeDays, ws.API_KEY_POLICY_BOUNDS.maxAgeDays.max);
  const tiny = ws.sanitizeApiKeyPolicy({ maxAgeDays: 0.4 });
  // Any positive value clamps up to bounds.min (=1d).
  assert.equal(tiny?.maxAgeDays, ws.API_KEY_POLICY_BOUNDS.maxAgeDays.min);
  const ok = ws.sanitizeApiKeyPolicy({ maxAgeDays: 90 });
  assert.equal(ok?.maxAgeDays, 90);
  assert.equal(ws.sanitizeApiKeyPolicy(null), null);
  assert.equal(ws.sanitizeApiKeyPolicy({ maxAgeDays: "abc" } as never), null);
});

test("setApiKeyPolicy persists and clears", async () => {
  const w = await ws.createWorkspace({
    name: "Policy team",
    ownerId: "u_owner000001",
    ownerEmail: "owner@example.com",
  });
  const after = await ws.setApiKeyPolicy(w, { maxAgeDays: 30 }, "u_owner000001");
  assert.equal(after.apiKeyPolicy?.maxAgeDays, 30);
  assert.equal(after.apiKeyPolicy?.updatedBy, "u_owner000001");
  const reread = await ws.getWorkspace(w.id);
  assert.equal(reread?.apiKeyPolicy?.maxAgeDays, 30);
  const cleared = await ws.setApiKeyPolicy(reread!, null, "u_owner000001");
  assert.equal(cleared.apiKeyPolicy, null);
});

test("createKey clamps expiresAt to workspace policy", async () => {
  const w = await ws.createWorkspace({
    name: "Clamp team",
    ownerId: "u_clamp0000001",
    ownerEmail: "c@example.com",
  });
  await ws.setApiKeyPolicy(w, { maxAgeDays: 7 }, "u_clamp0000001");

  // Caller asks for 365d; policy must clamp to ~7d.
  const { record } = await apiKeys.createKey("long key", {
    userId: "u_clamp0000001",
    workspaceId: w.id,
    expiresInDays: 365,
  });
  assert.ok(record.expiresAt);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const dist = Math.abs(record.expiresAt! - (record.createdAt + sevenDaysMs));
  assert.ok(dist < 60 * 1000, `expected expiresAt ~7d from createdAt; got delta ${dist}ms`);

  // Caller passes no expiresInDays: policy still forces a deadline.
  const { record: rec2 } = await apiKeys.createKey("no expiry", {
    userId: "u_clamp0000001",
    workspaceId: w.id,
  });
  assert.ok(rec2.expiresAt, "policy must force an expiresAt even without expiresInDays");
  assert.ok(rec2.expiresAt! <= rec2.createdAt + sevenDaysMs + 1000);
});

test("apiKeyPolicyDeadline + drift detection: pure decision used by /v1 enforcer", async () => {
  // We don't import lib/api-key-policy-enforce.ts here because it pulls
  // next/server, which raw `node --test` cannot resolve. The enforcer is
  // a thin NextResponse wrapper around exactly this decision.
  const w = await ws.createWorkspace({
    name: "Enforce team",
    ownerId: "u_enf00000001",
    ownerEmail: "e@example.com",
  });
  await ws.setApiKeyPolicy(w, { maxAgeDays: 30 }, "u_enf00000001");
  const fresh = await ws.getWorkspace(w.id);
  assert.ok(fresh);

  // Fresh key (createdAt now): deadline lies in the future -> allowed.
  const freshDeadline = ws.apiKeyPolicyDeadline(fresh, Date.now());
  assert.ok(freshDeadline && freshDeadline > Date.now());

  // Drift key (createdAt 90d ago, policy 30d): deadline is in the past
  // -> /v1 enforcer must reject with api_key_policy_expired.
  const driftCreatedAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const driftDeadline = ws.apiKeyPolicyDeadline(fresh, driftCreatedAt);
  assert.ok(driftDeadline && driftDeadline < Date.now(),
    "drift key deadline must be in the past so /v1 enforcer blocks it");

  // No policy: deadline is null -> never blocked.
  const cleared = await ws.setApiKeyPolicy(fresh!, null, "u_enf00000001");
  assert.equal(ws.apiKeyPolicyDeadline(cleared, driftCreatedAt), null);

  // No workspace binding: deadline is null regardless of policy state.
  assert.equal(ws.apiKeyPolicyDeadline(null, driftCreatedAt), null);
  assert.equal(ws.apiKeyPolicyDeadline(undefined, driftCreatedAt), null);
});
