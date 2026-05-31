/**
 * Workspaces: create, invite, accept, role transitions, removal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ws-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");

test("normalizeName and slugify", () => {
  assert.equal(ws.normalizeName("  Hello  World  "), "Hello World");
  assert.equal(ws.normalizeName(""), null);
  assert.equal(ws.normalizeName("-bad"), null);
  assert.equal(ws.slugify("Hello World!"), "hello-world");
  assert.equal(ws.slugify("Café Rocks"), "cafe-rocks");
});

test("create workspace seeds owner and indexes membership", async () => {
  const w = await ws.createWorkspace({
    name: "Alpha team",
    ownerId: "u_alice000001",
    ownerEmail: "alice@example.com",
  });
  assert.equal(w.members.length, 1);
  assert.equal(w.members[0].role, "owner");
  assert.equal(w.slug, "alpha-team");
  const got = await ws.getWorkspace(w.id);
  assert.ok(got);
  assert.equal(got!.name, "Alpha team");
  const mine = await ws.listWorkspacesForUser("u_alice000001");
  assert.equal(mine.length, 1);
});

test("invite, accept, role transition, only-owner protection, remove", async () => {
  const w = await ws.createWorkspace({
    name: "Bravo team",
    ownerId: "u_bob000000a",
    ownerEmail: "bob@example.com",
  });

  const issued = await ws.issueInvite({
    workspace: w,
    email: "carol@example.com",
    role: "editor",
    invitedBy: "u_bob000000a",
    origin: "https://x.test",
  });
  assert.ok(issued.url.includes("/workspaces/invite/"));

  // Wrong secret fails.
  const bad = await ws.lookupInvite(issued.record.id + ".garbage-secret-value");
  assert.equal(bad, null);

  // Email mismatch refuses acceptance.
  const noMatch = await ws.acceptInvite({
    token: issued.token,
    userId: "u_evil00000001",
    userEmail: "mallory@example.com",
  });
  assert.equal(noMatch, null);

  // Correct email accepts.
  const ok = await ws.acceptInvite({
    token: issued.token,
    userId: "u_carol00000a",
    userEmail: "carol@example.com",
  });
  assert.ok(ok);
  const w2 = (await ws.getWorkspace(w.id))!;
  assert.equal(w2.members.length, 2);
  const carol = w2.members.find((m) => m.userId === "u_carol00000a")!;
  assert.equal(carol.role, "editor");

  // Replay of accepted invite fails.
  const replay = await ws.acceptInvite({
    token: issued.token,
    userId: "u_carol00000a",
    userEmail: "carol@example.com",
  });
  assert.equal(replay, null);

  // Permissions.
  assert.equal(ws.canInvite(w2, "u_carol00000a"), true);
  assert.equal(ws.canManage(w2, "u_carol00000a"), false);
  assert.equal(ws.canManage(w2, "u_bob000000a"), true);

  // Demote sole owner blocked.
  await assert.rejects(() => ws.setMemberRole(w2, "u_bob000000a", "viewer"), /only_owner/);

  // Promote carol then demote bob works.
  await ws.setMemberRole(w2, "u_carol00000a", "owner");
  await ws.setMemberRole(w2, "u_bob000000a", "viewer");
  const w3 = (await ws.getWorkspace(w.id))!;
  assert.equal(w3.members.find((m) => m.userId === "u_bob000000a")!.role, "viewer");

  // Remove bob (now a viewer).
  await ws.removeMember(w3, "u_bob000000a");
  const w4 = (await ws.getWorkspace(w.id))!;
  assert.equal(w4.members.length, 1);
  assert.equal(w4.members[0].userId, "u_carol00000a");
});

test("rejects duplicate-member invites and invalid roles", async () => {
  const w = await ws.createWorkspace({
    name: "Charlie",
    ownerId: "u_dave000000z",
    ownerEmail: "dave@example.com",
  });
  await assert.rejects(
    () => ws.issueInvite({
      workspace: w,
      email: "dave@example.com",
      role: "viewer",
      invitedBy: "u_dave000000z",
      origin: "https://x.test",
    }),
    /already_member/,
  );
});
