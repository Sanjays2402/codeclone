/**
 * Workspace member suspension.
 *
 * Verifies the access-gating contract: a suspended member is treated as a
 * non-member by canInvite / canManage / getActiveMember, while getMember
 * still returns the row so audit/forensic views keep working. Also covers
 * the sole-owner safety check and the reinstate flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ws-suspend-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");

async function seedMember(
  w: Awaited<ReturnType<typeof ws.createWorkspace>>,
  inviterId: string,
  email: string,
  userId: string,
  role: "editor" | "viewer" = "editor",
) {
  const issued = await ws.issueInvite({
    workspace: w,
    email,
    role,
    invitedBy: inviterId,
    origin: "http://localhost:3000",
  });
  await ws.acceptInvite({
    token: issued.token,
    userId,
    userEmail: email,
  });
}

test("suspended editor loses canInvite / getActiveMember but keeps audit row", async () => {
  const w = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_owner0000001",
    ownerEmail: "owner@acme.test",
  });
  await seedMember(w, "u_owner0000001", "ed@acme.test", "u_ed0000000001", "editor");

  let fresh = (await ws.getWorkspace(w.id))!;
  assert.equal(ws.canInvite(fresh, "u_ed0000000001"), true, "editor can invite before suspension");
  assert.ok(ws.getActiveMember(fresh, "u_ed0000000001"), "active member resolvable");

  await ws.suspendMember(fresh, "u_ed0000000001", { actorUserId: "u_owner0000001", reason: "offboarded" });

  fresh = (await ws.getWorkspace(w.id))!;
  // Roster row preserved for audit trail.
  const raw = ws.getMember(fresh, "u_ed0000000001");
  assert.ok(raw, "getMember still returns suspended member for audit views");
  assert.equal(raw!.status, "suspended");
  assert.equal(raw!.suspendedBy, "u_owner0000001");
  assert.equal(raw!.suspendedReason, "offboarded");
  assert.equal(typeof raw!.suspendedAt, "number");

  // Access gating treats them as a non-member.
  assert.equal(ws.getActiveMember(fresh, "u_ed0000000001"), null, "active-member lookup is null");
  assert.equal(ws.canInvite(fresh, "u_ed0000000001"), false, "suspended editor cannot invite");
  assert.equal(ws.canManage(fresh, "u_ed0000000001"), false);
});

test("sole owner cannot suspend themselves", async () => {
  const w = await ws.createWorkspace({
    name: "Solo",
    ownerId: "u_solo00000001",
    ownerEmail: "solo@acme.test",
  });
  await assert.rejects(
    ws.suspendMember(w, "u_solo00000001", { actorUserId: "u_solo00000001" }),
    /only_owner/,
  );
});

test("reinstateMember restores active access; double-suspend rejected", async () => {
  const w = await ws.createWorkspace({
    name: "Acme2",
    ownerId: "u_owner0000002",
    ownerEmail: "owner2@acme.test",
  });
  await seedMember(w, "u_owner0000002", "vi@acme.test", "u_vi0000000001", "viewer");

  let fresh = (await ws.getWorkspace(w.id))!;
  await ws.suspendMember(fresh, "u_vi0000000001", { actorUserId: "u_owner0000002" });

  fresh = (await ws.getWorkspace(w.id))!;
  await assert.rejects(
    ws.suspendMember(fresh, "u_vi0000000001", { actorUserId: "u_owner0000002" }),
    /already_suspended/,
  );

  await ws.reinstateMember(fresh, "u_vi0000000001");
  fresh = (await ws.getWorkspace(w.id))!;
  const m = ws.getActiveMember(fresh, "u_vi0000000001");
  assert.ok(m, "reinstated member is active again");
  assert.equal(m!.status, "active");
  assert.equal(m!.suspendedAt, undefined);
  assert.equal(m!.suspendedBy, undefined);
  assert.equal(m!.suspendedReason, undefined);

  await assert.rejects(
    ws.reinstateMember(fresh, "u_vi0000000001"),
    /not_suspended/,
  );
});

test("cross-tenant isolation: suspended member in workspace A still active in workspace B", async () => {
  const a = await ws.createWorkspace({
    name: "A",
    ownerId: "u_ownerA000001",
    ownerEmail: "a@x.test",
  });
  const b = await ws.createWorkspace({
    name: "B",
    ownerId: "u_ownerB000001",
    ownerEmail: "b@x.test",
  });
  await seedMember(a, "u_ownerA000001", "shared@x.test", "u_shared000001", "editor");
  await seedMember(b, "u_ownerB000001", "shared@x.test", "u_shared000001", "editor");

  const aFresh = (await ws.getWorkspace(a.id))!;
  await ws.suspendMember(aFresh, "u_shared000001", { actorUserId: "u_ownerA000001" });

  const aAfter = (await ws.getWorkspace(a.id))!;
  const bAfter = (await ws.getWorkspace(b.id))!;
  assert.equal(ws.canInvite(aAfter, "u_shared000001"), false, "blocked in A");
  assert.equal(ws.canInvite(bAfter, "u_shared000001"), true, "untouched in B");
});
