/**
 * Workspace ownership transfer.
 *
 * Verifies the single-owner invariant is preserved across a hand-off and
 * that the lib rejects bad inputs (non-owner caller, non-member target,
 * self transfer).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ws-xfer-"));
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

test("transferOwnership hands the single owner role across members", async () => {
  const w = await ws.createWorkspace({
    name: "Xfer team",
    ownerId: "u_alice000001",
    ownerEmail: "alice@example.com",
  });

  await seedMember(w, "u_alice000001", "bob@example.com", "u_bob000000a", "editor");

  const fresh = await ws.getWorkspace(w.id);
  assert.ok(fresh);
  await ws.transferOwnership(fresh!, "u_alice000001", "u_bob000000a");

  const after = await ws.getWorkspace(w.id);
  assert.ok(after);
  const owners = after!.members.filter((m) => m.role === "owner");
  assert.equal(owners.length, 1, "exactly one owner after transfer");
  assert.equal(owners[0].userId, "u_bob000000a");
  const alice = after!.members.find((m) => m.userId === "u_alice000001");
  assert.equal(alice?.role, "editor", "previous owner demoted to editor");
});

test("transferOwnership rejects non-owner, non-member, and self", async () => {
  const w = await ws.createWorkspace({
    name: "Reject team",
    ownerId: "u_carol000001",
    ownerEmail: "carol@example.com",
  });

  await assert.rejects(
    () => ws.transferOwnership(w, "u_carol000001", "u_carol000001"),
    /same_user/,
  );

  await assert.rejects(
    () => ws.transferOwnership(w, "u_carol000001", "u_ghost00000a"),
    /not_member/,
  );

  await seedMember(w, "u_carol000001", "dan@example.com", "u_dan0000000a", "viewer");
  const fresh = await ws.getWorkspace(w.id);
  await assert.rejects(
    () => ws.transferOwnership(fresh!, "u_dan0000000a", "u_carol000001"),
    /not_owner/,
  );
});
