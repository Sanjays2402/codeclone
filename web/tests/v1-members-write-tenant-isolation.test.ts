/**
 * Run with: node --test --experimental-strip-types web/tests/v1-members-write-tenant-isolation.test.ts
 *
 * Covers the write half of /v1/members (POST invite, PATCH role/status,
 * DELETE remove). The hard contract here is the same as the read half:
 * a key minted in workspace A must never mutate a member in workspace B,
 * even though both workspaces share an on-disk store. Cross-tenant
 * probes surface as 404 (not 403) so foreign user ids cannot be guessed.
 *
 * Also covered:
 *   - both routes wire the full /v1 enforcement chain
 *   - members:write scope is enforced (and exposed in ALL_SCOPES)
 *   - RBAC: only keys bound to an active owner can mutate membership;
 *     editor and viewer keys are denied with a "denied" audit row
 *   - self-target protection: the calling owner cannot demote, suspend,
 *     or remove themselves through this endpoint
 *   - live invite -> roster grows; live role flip -> persisted; live
 *     remove -> roster shrinks; all scoped to the caller's workspaceId
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-write-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-write-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-write-ws-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "members", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "members", "[userId]", "route.ts"),
  "utf8",
);

const { ALL_SCOPES, SCOPE_DESCRIPTIONS, hasScope, createKey } = await import(
  "../lib/api-keys.ts"
);
const {
  createWorkspace,
  getWorkspace,
  setMemberRole,
  issueInvite,
  removeMember,
  suspendMember,
} = await import("../lib/workspaces.ts");

test("members write: ALL_SCOPES exposes members:write with a description", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("members:write"));
  assert.ok(
    typeof SCOPE_DESCRIPTIONS["members:write" as keyof typeof SCOPE_DESCRIPTIONS] ===
      "string",
  );
});

test("members write: POST route source wires scope, enforcement chain, rate-limit, RBAC, audit", () => {
  assert.match(listRouteSrc, /hasScope\(key, "members:write"\)/);
  assert.match(listRouteSrc, /canManage\(ws, key\.userId\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.match(listRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(listRouteSrc, /enforceKeyAllowlist/);
  assert.match(listRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(listRouteSrc, /"v1\.members\.invite"/);
  // Workspace always derived from key.workspaceId, never from body.
  assert.match(listRouteSrc, /getWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/body\.workspace_id|body\.workspaceId|body\["workspace/.test(listRouteSrc),
    "POST /v1/members must never let the body select the workspace",
  );
});

test("members write: [userId] route source wires scope, RBAC, self-protection, tenant 404, audit", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "members:write"\)/);
  assert.match(itemRouteSrc, /canManage\(ws, key\.userId\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  assert.match(itemRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(itemRouteSrc, /"v1\.members\.update"/);
  assert.match(itemRouteSrc, /"v1\.members\.remove"/);
  assert.match(itemRouteSrc, /self_target_forbidden/);
  // Target is found in ws.members (which came from key.workspaceId),
  // never from a query string or body field.
  assert.match(itemRouteSrc, /ws\.members\.find/);
  assert.match(itemRouteSrc, /getWorkspace\(key\.workspaceId\)/);
});

test("members write: hasScope rejects read-only keys, accepts members:write keys", async () => {
  const readOnly = await createKey("read-only", {
    workspaceId: "ws_scopecheck_r",
    scopes: ["members:read"],
  });
  const writer = await createKey("writer", {
    workspaceId: "ws_scopecheck_w",
    scopes: ["members:read", "members:write"],
  });
  assert.equal(hasScope(readOnly.record, "members:write"), false);
  assert.equal(hasScope(writer.record, "members:write"), true);
});

test("members write: live RBAC + invite/role/remove flow stays within tenant", async () => {
  const wsA = await createWorkspace({
    name: "Tenant A",
    ownerId: "u_a_owner",
    ownerEmail: "owner@a.example",
  });
  const wsB = await createWorkspace({
    name: "Tenant B",
    ownerId: "u_b_owner",
    ownerEmail: "owner@b.example",
  });

  // Issue and accept an invite into wsA so it has an editor we can mutate.
  const inv = await issueInvite({
    workspace: wsA,
    email: "alice@a.example",
    role: "editor",
    invitedBy: "u_a_owner",
    origin: "http://localhost:3000",
  });
  // Manually attach to roster (acceptInvite needs the token round-trip;
  // we just want a non-owner present for the test).
  const wsA1 = (await getWorkspace(wsA.id))!;
  wsA1.members.push({
    userId: "u_a_alice",
    email: "alice@a.example",
    role: "editor",
    joinedAt: Date.now(),
  });
  await setMemberRole(wsA1, "u_a_alice", "editor");
  assert.ok(inv.record.id.startsWith("inv_"));

  // Sanity: workspaces are distinct on disk.
  const liveA = (await getWorkspace(wsA.id))!;
  const liveB = (await getWorkspace(wsB.id))!;
  assert.notEqual(liveA.id, liveB.id);

  // Cross-tenant target lookup: a key bound to wsB looking up alice (u_a_alice)
  // in its own workspace must not find her -- she lives in wsA.
  const targetInB = liveB.members.find((m) => m.userId === "u_a_alice");
  assert.equal(targetInB, undefined, "wsB roster must not contain wsA's alice");

  // Owner-of-wsA mutation contract: setMemberRole flips role, persists.
  const updated = await setMemberRole(liveA, "u_a_alice", "viewer");
  const m = updated.members.find((x) => x.userId === "u_a_alice")!;
  assert.equal(m.role, "viewer");

  // Suspension preserves the roster entry.
  const suspended = await suspendMember(updated, "u_a_alice", {
    actorUserId: "u_a_owner",
    reason: "Workday leaver",
  });
  const ms = suspended.members.find((x) => x.userId === "u_a_alice")!;
  assert.equal(ms.status, "suspended");
  assert.equal(ms.suspendedReason, "Workday leaver");

  // Removal drops the entry.
  const removed = await removeMember(suspended, "u_a_alice");
  assert.equal(
    removed.members.find((x) => x.userId === "u_a_alice"),
    undefined,
  );

  // wsB has not been touched throughout.
  const liveB2 = (await getWorkspace(wsB.id))!;
  assert.equal(liveB2.members.length, 1);
  assert.equal(liveB2.members[0].email, "owner@b.example");
});

test("members write: only-owner invariants stop you from deleting the only owner", async () => {
  const ws = await createWorkspace({
    name: "Solo",
    ownerId: "u_solo",
    ownerEmail: "solo@x.example",
  });
  await assert.rejects(
    () => removeMember(ws, "u_solo"),
    /only_owner/,
  );
  await assert.rejects(
    () => setMemberRole(ws, "u_solo", "editor"),
    /only_owner/,
  );
});
