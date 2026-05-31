/**
 * Just-in-time support access grants.
 *
 * Verifies the lib contract that powers /api/workspaces/:id/support-access:
 *   - createSupportGrant adds a viewer-role member with status "support"
 *     and a bounded expiresAt.
 *   - While unexpired, the grant counts as an active member (read access).
 *   - canInvite / canManage stay false (viewer role; no privilege creep).
 *   - Once expiresAt is in the past, isMemberActive flips to false, so
 *     the existing access gate revokes the grant with no background job.
 *   - revokeSupportGrant removes the row entirely.
 *   - Refuses to overwrite a permanent member or to revoke one through
 *     the support console (no accidental teammate deletion).
 *   - sanitizeSupportGrantInput rejects out-of-range and malformed input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ws-support-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");

test("grant adds expiring viewer member, expiry deactivates without background job", async () => {
  const w = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_owner0000001",
    ownerEmail: "owner@acme.test",
  });

  const result = await ws.createSupportGrant(
    w,
    { userId: "u_support00001", email: "vendor@codeclone.support" },
    { email: "vendor@codeclone.support", minutes: 60, reason: "Investigating ticket SUP-1", caseRef: "SUP-1" },
    "u_owner0000001",
  );
  assert.equal(result.replaced, false);
  assert.equal(result.member.role, "viewer");
  assert.equal(result.member.status, "support");
  assert.equal(result.member.grantedBy, "u_owner0000001");
  assert.equal(result.member.grantCaseRef, "SUP-1");
  assert.ok(typeof result.member.expiresAt === "number" && result.member.expiresAt > Date.now());

  let fresh = (await ws.getWorkspace(w.id))!;
  // While the grant is live the engineer counts as an active member: they
  // can read the workspace but cannot invite or manage.
  assert.ok(ws.getActiveMember(fresh, "u_support00001"), "support grant resolves as active member");
  assert.equal(ws.canInvite(fresh, "u_support00001"), false, "support grant cannot invite");
  assert.equal(ws.canManage(fresh, "u_support00001"), false, "support grant cannot manage");

  // Past the expiry the existing isMemberActive predicate flips automatically.
  const future = result.member.expiresAt! + 1;
  const expiredMember = ws.getMember(fresh, "u_support00001")!;
  assert.equal(ws.isMemberActive(expiredMember, future), false, "expired support grant is inactive");
  assert.equal(ws.isSupportGrantExpired(expiredMember, future), true);

  const listed = ws.listSupportGrants(fresh);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, "vendor@codeclone.support");
  assert.equal(listed[0].expired, false);
});

test("grant for an existing permanent member is rejected", async () => {
  const w = await ws.createWorkspace({
    name: "BadMix",
    ownerId: "u_owner0000002",
    ownerEmail: "owner2@acme.test",
  });
  // Try to "grant" support access to the existing owner; must refuse so we
  // never silently downgrade a real teammate into a viewer support row.
  await assert.rejects(
    ws.createSupportGrant(
      w,
      { userId: "u_owner0000002", email: "owner2@acme.test" },
      { email: "owner2@acme.test", minutes: 60, reason: "should not work" },
      "u_owner0000002",
    ),
    /already_member/,
  );
});

test("replacing an existing support grant updates expiry and reason without duplicating", async () => {
  const w = await ws.createWorkspace({
    name: "Replace",
    ownerId: "u_owner0000003",
    ownerEmail: "owner3@acme.test",
  });
  await ws.createSupportGrant(
    w,
    { userId: "u_support00002", email: "v2@codeclone.support" },
    { email: "v2@codeclone.support", minutes: 30, reason: "First touch" },
    "u_owner0000003",
  );
  const second = await ws.createSupportGrant(
    (await ws.getWorkspace(w.id))!,
    { userId: "u_support00002", email: "v2@codeclone.support" },
    { email: "v2@codeclone.support", minutes: 120, reason: "Extending window" },
    "u_owner0000003",
  );
  assert.equal(second.replaced, true);
  const fresh = (await ws.getWorkspace(w.id))!;
  const supportRows = fresh.members.filter((m) => m.userId === "u_support00002");
  assert.equal(supportRows.length, 1, "extension does not create a duplicate row");
  assert.equal(supportRows[0].grantReason, "Extending window");
});

test("revokeSupportGrant removes only support rows, refuses permanent members", async () => {
  const w = await ws.createWorkspace({
    name: "Revoke",
    ownerId: "u_owner0000004",
    ownerEmail: "owner4@acme.test",
  });
  await ws.createSupportGrant(
    w,
    { userId: "u_support00003", email: "v3@codeclone.support" },
    { email: "v3@codeclone.support", minutes: 60, reason: "Initial debug" },
    "u_owner0000004",
  );
  const fresh = (await ws.getWorkspace(w.id))!;
  const { removed } = await ws.revokeSupportGrant(fresh, "u_support00003");
  assert.ok(removed, "support grant returned");
  const after = (await ws.getWorkspace(w.id))!;
  assert.equal(after.members.find((m) => m.userId === "u_support00003"), undefined);

  // Refuses to revoke the owner via the support console.
  await assert.rejects(ws.revokeSupportGrant(after, "u_owner0000004"), /not_support_grant/);
});

test("sanitizeSupportGrantInput enforces input contract", () => {
  // Happy path.
  assert.ok(
    ws.sanitizeSupportGrantInput({
      email: "ok@vendor.test",
      minutes: 60,
      reason: "Looking into ticket",
      caseRef: "SUP-2026-0001",
    }),
  );
  // Too short reason.
  assert.equal(ws.sanitizeSupportGrantInput({ email: "ok@v.test", minutes: 60, reason: "x" }), null);
  // Below floor.
  assert.equal(ws.sanitizeSupportGrantInput({ email: "ok@v.test", minutes: 1, reason: "valid" }), null);
  // Above hard cap (>24h).
  assert.equal(
    ws.sanitizeSupportGrantInput({ email: "ok@v.test", minutes: 60 * 25, reason: "valid" }),
    null,
  );
  // Malformed caseRef.
  assert.equal(
    ws.sanitizeSupportGrantInput({ email: "ok@v.test", minutes: 60, reason: "valid", caseRef: "bad ref!" }),
    null,
  );
});
