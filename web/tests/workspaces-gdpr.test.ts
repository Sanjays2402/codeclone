/**
 * GDPR/DPA: workspace export + hard-delete cross-tenant isolation.
 *
 * Verifies that:
 *   - exportWorkspace returns only records bound to the target workspace
 *   - deleteWorkspace removes the workspace, its invites, and member
 *     index entries while leaving sibling workspaces untouched
 *   - API key records scoped to other workspaces survive a delete
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ws-gdpr-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "keys");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");

const ws = await import("../lib/workspaces.ts");
const keys = await import("../lib/api-keys.ts");
const audit = await import("../lib/audit.ts");

test("exportWorkspace returns only the target workspace's data", async () => {
  const a = await ws.createWorkspace({
    name: "Alpha team",
    ownerId: "u_alice000001",
    ownerEmail: "alice@example.com",
  });
  const b = await ws.createWorkspace({
    name: "Bravo team",
    ownerId: "u_bob000000a",
    ownerEmail: "bob@example.com",
  });

  // Invites scoped to each workspace.
  await ws.issueInvite({
    workspace: a,
    email: "carol@example.com",
    role: "editor",
    invitedBy: "u_alice000001",
    origin: "https://x.test",
  });
  await ws.issueInvite({
    workspace: b,
    email: "dave@example.com",
    role: "viewer",
    invitedBy: "u_bob000000a",
    origin: "https://x.test",
  });

  // API keys: one in A, one in B, one unscoped.
  const keyA = await keys.createKey("alpha key", { userId: "u_alice000001", workspaceId: a.id });
  const keyB = await keys.createKey("bravo key", { userId: "u_bob000000a", workspaceId: b.id });
  await keys.createKey("loose key", { userId: "u_alice000001" });

  // Audit entries in both workspaces.
  await audit.recordAudit(undefined, {
    action: "test.alpha",
    actorId: "u_alice000001",
    actorEmail: "alice@example.com",
    workspaceId: a.id,
    target: { type: "workspace", id: a.id },
  });
  await audit.recordAudit(undefined, {
    action: "test.bravo",
    actorId: "u_bob000000a",
    actorEmail: "bob@example.com",
    workspaceId: b.id,
    target: { type: "workspace", id: b.id },
  });

  const bundle = await ws.exportWorkspace(a);
  assert.equal(bundle.workspace.id, a.id);
  assert.equal(bundle.invites.length, 1);
  assert.equal(bundle.invites[0]!.email, "carol@example.com");
  // Cross-tenant isolation on keys.
  assert.equal(bundle.apiKeys.length, 1);
  assert.equal((bundle.apiKeys[0] as { id: string }).id, keyA.record.id);
  assert.notEqual((bundle.apiKeys[0] as { id: string }).id, keyB.record.id);
  // Cross-tenant isolation on audit.
  assert.ok(bundle.audit.length >= 1);
  for (const e of bundle.audit) {
    assert.equal((e as { workspaceId: string }).workspaceId, a.id);
  }
  // Secrets never leak.
  assert.equal((bundle.apiKeys[0] as Record<string, unknown>).hash, undefined);
  if (bundle.workspace.sso) {
    assert.equal((bundle.workspace.sso as Record<string, unknown>).clientSecret, undefined);
  }
});

test("deleteWorkspace removes only the target workspace and its scoped data", async () => {
  const a = await ws.createWorkspace({
    name: "Alpha2 team",
    ownerId: "u_alice000002",
    ownerEmail: "alice2@example.com",
  });
  const b = await ws.createWorkspace({
    name: "Bravo2 team",
    ownerId: "u_bob000000b",
    ownerEmail: "bob2@example.com",
  });
  await ws.issueInvite({
    workspace: a,
    email: "eve@example.com",
    role: "editor",
    invitedBy: "u_alice000002",
    origin: "https://x.test",
  });
  const keyA = await keys.createKey("alpha2 key", { userId: "u_alice000002", workspaceId: a.id });
  const keyB = await keys.createKey("bravo2 key", { userId: "u_bob000000b", workspaceId: b.id });

  const result = await ws.deleteWorkspace(a);
  assert.equal(result.workspaceId, a.id);
  assert.ok(result.removedInvites >= 1);
  assert.equal(result.removedApiKeys, 1);
  assert.equal(result.removedMembers, 1);

  // A is gone.
  assert.equal(await ws.getWorkspace(a.id), null);
  // B is untouched.
  const stillB = await ws.getWorkspace(b.id);
  assert.ok(stillB);
  assert.equal(stillB!.name, "Bravo2 team");
  // A's key is gone, B's key survives.
  assert.equal(await keys.loadKey(keyA.record.id), null);
  const survivor = await keys.loadKey(keyB.record.id);
  assert.ok(survivor);
  assert.equal(survivor!.workspaceId, b.id);
  // Owner's reverse index no longer lists A but unchanged otherwise.
  const mine = await ws.listWorkspacesForUser("u_alice000002");
  assert.equal(mine.length, 0);
});

test("export bundle round-trips through JSON", async () => {
  const w = await ws.createWorkspace({
    name: "Round trip",
    ownerId: "u_round000001",
    ownerEmail: "round@example.com",
  });
  const bundle = await ws.exportWorkspace(w);
  const round = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  assert.equal(round.v, 1);
  assert.equal(round.workspace.id, w.id);
  assert.equal(typeof round.exportedAt, "number");
});
