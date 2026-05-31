/**
 * SSO group-to-role mapping: sanitization, resolver semantics, and
 * sole-owner protection. Runs against a temp workspaces dir.
 *
 * Coverage:
 *   - setSsoGroupMappings rejects without an SSO config and clamps
 *     malformed mappings (bad roles, blank groups, overlong names,
 *     duplicates, table-size cap).
 *   - resolveRoleFromSsoGroups handles missing claim, missing mappings,
 *     array claims, space-separated string claims, no-match, and ranked
 *     wins when multiple mappings apply.
 *   - End-to-end: a member's role is updated on the next SSO via
 *     setMemberRole, and the sole-owner safeguard prevents a demotion
 *     that would orphan a workspace.
 *   - Cross-tenant isolation: a group policy in workspace A does not
 *     affect roles in workspace B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-sso-groups-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_AUTH_SECRET = "test-sso-groups-secret";

const ws = await import("../lib/workspaces.ts");

function baseSso(updatedBy: string) {
  return {
    provider: "oidc" as const,
    issuer: "https://accounts.google.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    allowedDomain: "acme.com",
    enforced: true,
    updatedAt: Date.now(),
    updatedBy,
  };
}

test("setSsoGroupMappings refuses without an SSO config", async () => {
  const w = await ws.createWorkspace({
    name: "NoSso", ownerId: "u_groupsowner01", ownerEmail: "o@acme.com",
  });
  await assert.rejects(
    () => ws.setSsoGroupMappings(w, {
      groupClaim: "groups",
      groupMappings: [{ group: "g", role: "viewer" }],
      actorId: "u_groupsowner01",
    }),
    /sso_not_configured/,
  );
});

test("setSsoGroupMappings sanitizes claim + mappings", async () => {
  const w = await ws.createWorkspace({
    name: "Sani", ownerId: "u_sanitizeown01", ownerEmail: "o@acme.com",
  });
  await ws.setSsoConfig(w, baseSso("u_sanitizeown01"));

  // Build a junky table: bad role, blank group, way-too-long group, dup,
  // and an over-the-cap pile of valid rows.
  const longGroup = "x".repeat(ws.SSO_GROUP_NAME_MAX + 10);
  const mappings: Array<{ group: unknown; role: unknown }> = [
    { group: "okta-admins", role: "owner" },
    { group: "  okta-admins  ", role: "editor" }, // dup after trim, should be ignored
    { group: "okta-eng", role: "editor" },
    { group: "", role: "viewer" },          // blank group
    { group: "no-such", role: "moderator" }, // bad role
    { group: longGroup, role: "viewer" },   // overlong
  ];
  for (let i = 0; i < ws.SSO_GROUP_MAPPINGS_MAX + 5; i++) {
    mappings.push({ group: `g${i}`, role: "viewer" });
  }

  const updated = await ws.setSsoGroupMappings(w, {
    groupClaim: "  groups  ",
    groupMappings: mappings,
    actorId: "u_sanitizeown01",
  });
  assert.equal(updated.sso!.groupClaim, "groups");
  const out = updated.sso!.groupMappings!;
  // Cap respected.
  assert.equal(out.length, ws.SSO_GROUP_MAPPINGS_MAX);
  // First slot is the original owner mapping (dup was dropped, not replaced).
  assert.deepEqual(out[0], { group: "okta-admins", role: "owner" });
  assert.deepEqual(out[1], { group: "okta-eng", role: "editor" });
  // None of the rejected rows survived.
  assert.ok(!out.some((m) => m.group === ""));
  assert.ok(!out.some((m) => m.group.length > ws.SSO_GROUP_NAME_MAX));
});

test("resolveRoleFromSsoGroups handles array, string, miss, and ranks owner > editor > viewer", () => {
  const cfg = {
    ...baseSso("u_x"),
    groupClaim: "groups",
    groupMappings: [
      { group: "viewers", role: "viewer" as const },
      { group: "editors", role: "editor" as const },
      { group: "admins", role: "owner" as const },
    ],
  };
  // No claim -> null.
  assert.equal(ws.resolveRoleFromSsoGroups({ ...cfg, groupClaim: undefined }, ["admins"]), null);
  // No mappings -> null.
  assert.equal(ws.resolveRoleFromSsoGroups({ ...cfg, groupMappings: undefined }, ["admins"]), null);
  // No match -> null.
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, ["random"]), null);
  // Array claim, single match.
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, ["viewers"]), "viewer");
  // Array claim, multiple matches -> owner wins.
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, ["editors", "admins", "viewers"]), "owner");
  // Space-separated string claim is accepted.
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, "editors viewers"), "editor");
  // Non string/array value -> null.
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, 42), null);
  assert.equal(ws.resolveRoleFromSsoGroups(cfg, null), null);
});

test("group sync would demote and addMember + setMemberRole respect sole-owner", async () => {
  const w = await ws.createWorkspace({
    name: "Live", ownerId: "u_groupliveown1", ownerEmail: "owner@acme.com",
  });
  await ws.setSsoConfig(w, baseSso("u_groupliveown1"));
  await ws.setSsoGroupMappings(w, {
    groupClaim: "groups",
    groupMappings: [
      { group: "okta-admins", role: "owner" },
      { group: "okta-eng", role: "editor" },
    ],
    actorId: "u_groupliveown1",
  });
  // Add a viewer; they show up in okta-eng on next SSO -> should become editor.
  const inv = await ws.issueInvite({
    workspace: w,
    email: "eng@acme.com",
    role: "viewer",
    invitedBy: "u_groupliveown1",
    origin: "https://acme.test",
  });
  await ws.acceptInvite({
    token: inv.token,
    userId: "u_groupliveeng1",
    userEmail: "eng@acme.com",
  });
  const wAfterJoin = (await ws.getWorkspace(w.id))!;
  const desired = ws.resolveRoleFromSsoGroups(wAfterJoin.sso!, ["okta-eng"]);
  assert.equal(desired, "editor");
  await ws.setMemberRole(wAfterJoin, "u_groupliveeng1", desired!);
  const fresh = (await ws.getWorkspace(w.id))!;
  assert.equal(fresh.members.find((m) => m.userId === "u_groupliveeng1")!.role, "editor");

  // Sole-owner protection: if the IdP says the owner is now a viewer, the
  // setMemberRole call must throw and the role must not change on disk.
  await assert.rejects(
    () => ws.setMemberRole(fresh, "u_groupliveown1", "viewer"),
    /only_owner/,
  );
  const stillOwner = (await ws.getWorkspace(w.id))!;
  assert.equal(
    stillOwner.members.find((m) => m.userId === "u_groupliveown1")!.role,
    "owner",
  );
});

test("group policy in one workspace does not leak into another", async () => {
  const a = await ws.createWorkspace({
    name: "Tenant A", ownerId: "u_tenantaown001", ownerEmail: "o@a.com",
  });
  const b = await ws.createWorkspace({
    name: "Tenant B", ownerId: "u_tenantbown001", ownerEmail: "o@b.com",
  });
  await ws.setSsoConfig(a, { ...baseSso("u_tenantaown001"), allowedDomain: "a.com" });
  await ws.setSsoConfig(b, { ...baseSso("u_tenantbown001"), allowedDomain: "b.com" });
  await ws.setSsoGroupMappings(a, {
    groupClaim: "groups",
    groupMappings: [{ group: "okta-admins", role: "owner" }],
    actorId: "u_tenantaown001",
  });
  const freshA = (await ws.getWorkspace(a.id))!;
  const freshB = (await ws.getWorkspace(b.id))!;
  assert.deepEqual(freshA.sso!.groupMappings, [{ group: "okta-admins", role: "owner" }]);
  assert.equal(freshA.sso!.groupClaim, "groups");
  // B was never touched: no claim, no mappings.
  assert.equal(freshB.sso!.groupClaim, undefined);
  assert.equal(freshB.sso!.groupMappings, undefined);
});
