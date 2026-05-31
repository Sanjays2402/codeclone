/**
 * Workspace member role changes and forced removals.
 *
 * Verifies the privilege-boundary contract that the PATCH and DELETE
 * handlers on /api/workspaces/<id> implement:
 *
 *   1. setMemberRole + revokeAllSessions wired together cleanly:
 *      changing a member's role and then revoking their sessions leaves
 *      that user with zero active sessions and the new role on disk.
 *   2. Sole-owner demotion is rejected (`only_owner`).
 *   3. Forced removal of a non-owner succeeds AND tearing down their
 *      sessions + API keys leaves them with nothing usable.
 *   4. removeMember refuses to drop the last owner (`only_owner`).
 *   5. Source-level assertion: the route handler actually wires MFA
 *      step-up, session revocation, and audit diffs for role changes
 *      and removals. This guards against a regression that silently
 *      drops the new credential-severing behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codeclone-role-change-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_SESSIONS_DIR = path.join(tmp, "sessions");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "api-keys");

const ws = await import("../lib/workspaces.ts");
const sessions = await import("../lib/sessions.ts");

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

test("role downgrade + revokeAllSessions: editor demoted to viewer loses every session", async () => {
  const w = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_owner0000001",
    ownerEmail: "owner@acme.test",
  });
  await seedMember(w, "u_owner0000001", "ed@acme.test", "u_ed0000000001", "editor");

  // Editor has two live sessions (laptop + phone).
  await sessions.createSession({
    jti: sessions.newJti(),
    userId: "u_ed0000000001",
    ttlSec: 3600,
    ip: "10.0.0.1",
    userAgent: "laptop",
  });
  await sessions.createSession({
    jti: sessions.newJti(),
    userId: "u_ed0000000001",
    ttlSec: 3600,
    ip: "10.0.0.2",
    userAgent: "phone",
  });
  assert.equal((await sessions.listSessions("u_ed0000000001")).length, 2);

  const fresh = (await ws.getWorkspace(w.id))!;
  await ws.setMemberRole(fresh, "u_ed0000000001", "viewer");
  const revoked = await sessions.revokeAllSessions("u_ed0000000001");
  assert.equal(revoked, 2, "both active sessions revoked on role downgrade");

  const after = (await ws.getWorkspace(w.id))!;
  assert.equal(
    after.members.find((m) => m.userId === "u_ed0000000001")!.role,
    "viewer",
    "role persisted as viewer",
  );
  assert.equal((await sessions.listSessions("u_ed0000000001")).length, 0, "no active sessions remain");
});

test("setMemberRole refuses to demote the sole owner", async () => {
  const w = await ws.createWorkspace({
    name: "Solo",
    ownerId: "u_solo00000001",
    ownerEmail: "solo@acme.test",
  });
  await assert.rejects(
    () => ws.setMemberRole(w, "u_solo00000001", "editor"),
    /only_owner/,
  );
  // Untouched on disk.
  const after = (await ws.getWorkspace(w.id))!;
  assert.equal(after.members.find((m) => m.userId === "u_solo00000001")!.role, "owner");
});

test("forced removal: removeMember + revokeAllSessions clears membership and credentials", async () => {
  const w = await ws.createWorkspace({
    name: "Beta",
    ownerId: "u_owner0000002",
    ownerEmail: "owner2@beta.test",
  });
  await seedMember(w, "u_owner0000002", "vic@beta.test", "u_vic0000000001", "editor");
  await sessions.createSession({
    jti: sessions.newJti(),
    userId: "u_vic0000000001",
    ttlSec: 3600,
    ip: "10.0.0.9",
    userAgent: "ua",
  });
  assert.equal((await sessions.listSessions("u_vic0000000001")).length, 1);

  const fresh = (await ws.getWorkspace(w.id))!;
  await ws.removeMember(fresh, "u_vic0000000001");
  const revoked = await sessions.revokeAllSessions("u_vic0000000001");
  assert.equal(revoked, 1, "session revoked on forced removal");

  const after = (await ws.getWorkspace(w.id))!;
  assert.equal(
    after.members.find((m) => m.userId === "u_vic0000000001"),
    undefined,
    "removed member is no longer on the roster",
  );
  assert.equal(ws.getActiveMember(after, "u_vic0000000001"), null);
  assert.equal((await sessions.listSessions("u_vic0000000001")).length, 0);
});

test("removeMember refuses to drop the last owner", async () => {
  const w = await ws.createWorkspace({
    name: "LastOwner",
    ownerId: "u_owner0000003",
    ownerEmail: "lone@acme.test",
  });
  await assert.rejects(
    () => ws.removeMember(w, "u_owner0000003"),
    /only_owner/,
  );
});

test("route source wires MFA, session revocation, and audit diffs for role changes and removals", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routePath = path.resolve(here, "..", "app/api/workspaces/[id]/route.ts");
  const src = fs.readFileSync(routePath, "utf8");

  // PATCH role-change branch must require MFA step-up, revoke sessions,
  // and audit the diff. Each of these is a concrete regression guard.
  assert.match(src, /requireStepUp\(/, "PATCH must call requireStepUp");
  assert.match(src, /revokeAllSessions\(targetUserId\)/, "PATCH must revoke target user's sessions on role change");
  assert.match(src, /workspace\.member_role_change/, "PATCH must audit role changes under workspace.member_role_change");
  assert.match(src, /before:\s*\{\s*role:\s*beforeRole\s*\}/, "PATCH audit must include before/after role diff");

  // DELETE (forced removal) must require MFA, revoke sessions AND keys,
  // and audit with sessionsRevoked + apiKeysRevoked meta.
  assert.match(src, /revokeKey\(/, "DELETE must revoke removed user's API keys");
  assert.match(src, /listKeys\(targetUserId\)/, "DELETE must enumerate removed user's API keys");
  assert.match(src, /apiKeysRevoked/, "DELETE audit must report apiKeysRevoked count");
  assert.match(src, /workspace\.member_remove/, "DELETE must audit forced removals");
});
