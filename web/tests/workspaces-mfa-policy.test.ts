/**
 * Workspace MFA enrollment policy enforcement.
 *
 * Verifies:
 *   - sanitizeMfaPolicy clamps gracePeriodDays to bounds
 *   - setMfaPolicy persists and clears
 *   - effectiveMfaPolicyForUser is scoped per user (workspace A's policy
 *     does not block users who only belong to workspace B)
 *   - mfaEnrollmentStatusFor reports blocked only when:
 *       (a) the user belongs to a workspace with requireEnrollment=true
 *       (b) the grace window has elapsed
 *       (c) the user has no confirmed TOTP enrollment
 *
 * Run: node --test --experimental-strip-types web/tests/workspaces-mfa-policy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-mfa-policy-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_MFA_DIR = path.join(tmp, "mfa");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-mfa-policy";

const ws = await import("../lib/workspaces.ts");
const auth = await import("../lib/auth.ts");
const mfa = await import("../lib/mfa.ts");
const decide = await import("../lib/mfa-policy-decide.ts");

test("sanitizeMfaPolicy clamps grace to bounds and respects requireEnrollment", () => {
  assert.deepEqual(ws.sanitizeMfaPolicy({ requireEnrollment: false }), {
    requireEnrollment: false,
    gracePeriodDays: 0,
  });
  const bigGrace = ws.sanitizeMfaPolicy({
    requireEnrollment: true,
    gracePeriodDays: 9999,
  });
  assert.equal(
    bigGrace?.gracePeriodDays,
    ws.MFA_POLICY_BOUNDS.gracePeriodDays.max,
  );
  const negGrace = ws.sanitizeMfaPolicy({
    requireEnrollment: true,
    gracePeriodDays: -5,
  });
  assert.equal(negGrace?.gracePeriodDays, 0);
  assert.equal(negGrace?.requireEnrollment, true);
});

test("setMfaPolicy persists and clears", async () => {
  const owner = await auth.findOrCreateUser("owner-set@example.com");
  let w = await ws.createWorkspace({
    name: "Set Test",
    ownerId: owner.id,
    ownerEmail: owner.email,
  });
  w = await ws.setMfaPolicy(
    w,
    { requireEnrollment: true, gracePeriodDays: 14 },
    owner.id,
  );
  const reloaded = await ws.getWorkspace(w.id);
  assert.equal(reloaded?.mfaPolicy?.requireEnrollment, true);
  assert.equal(reloaded?.mfaPolicy?.gracePeriodDays, 14);

  const cleared = await ws.setMfaPolicy(w, null, owner.id);
  assert.equal(cleared.mfaPolicy, null);
});

test("effectiveMfaPolicyForUser does not leak across workspaces", async () => {
  const alice = await auth.findOrCreateUser("alice-iso@example.com");
  const bob = await auth.findOrCreateUser("bob-iso@example.com");

  // Workspace A: alice owner, MFA enforced with 0 grace (immediate).
  let wsA = await ws.createWorkspace({
    name: "A Iso",
    ownerId: alice.id,
    ownerEmail: alice.email,
  });
  wsA = await ws.setMfaPolicy(
    wsA,
    { requireEnrollment: true, gracePeriodDays: 0 },
    alice.id,
  );

  // Workspace B: bob owner, no MFA policy.
  await ws.createWorkspace({
    name: "B Iso",
    ownerId: bob.id,
    ownerEmail: bob.email,
  });

  const aliceP = await ws.effectiveMfaPolicyForUser(alice.id);
  assert.equal(aliceP.required, true, "alice (member of A) sees policy");
  assert.equal(aliceP.workspaceId, wsA.id);
  assert.equal(aliceP.pastDeadline, true, "0d grace = past deadline immediately");

  const bobP = await ws.effectiveMfaPolicyForUser(bob.id);
  assert.equal(bobP.required, false, "bob (not in A) sees no policy");
  assert.equal(bobP.workspaceId, null);
});

test("mfaEnrollmentStatusFor blocks only when policy + no enrollment + past grace", async () => {
  const carol = await auth.findOrCreateUser("carol-blk@example.com");
  let w = await ws.createWorkspace({
    name: "Block Test",
    ownerId: carol.id,
    ownerEmail: carol.email,
  });

  // No policy yet: not blocked.
  let s = await decide.mfaEnrollmentStatusFor(carol);
  assert.equal(s.required, false);
  assert.equal(s.blocked, false);

  // Enable with 30d grace: required but not blocked.
  w = await ws.setMfaPolicy(
    w,
    { requireEnrollment: true, gracePeriodDays: 30 },
    carol.id,
  );
  s = await decide.mfaEnrollmentStatusFor(carol);
  assert.equal(s.required, true);
  assert.equal(s.blocked, false, "30d grace not yet elapsed");
  assert.equal(s.workspaceId, w.id);
  assert.ok((s.secondsRemaining ?? 0) > 0);

  // Tighten to 0d grace: blocked because not enrolled.
  await ws.setMfaPolicy(
    w,
    { requireEnrollment: true, gracePeriodDays: 0 },
    carol.id,
  );
  s = await decide.mfaEnrollmentStatusFor(carol);
  assert.equal(s.blocked, true, "0d grace + not enrolled = blocked");

  // Enroll: no longer blocked even though policy still active.
  const start = await mfa.startEnrollment(carol.id, carol.email);
  const code = mfa.totp(start.secret);
  await mfa.confirmEnrollment(carol.id, code);
  s = await decide.mfaEnrollmentStatusFor(carol);
  assert.equal(s.enrolled, true);
  assert.equal(s.blocked, false, "enrolled users are never blocked");
});
