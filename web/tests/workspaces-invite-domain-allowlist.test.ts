/**
 * Invite-domain allowlist: sanitizer + enforcement across every join path.
 *
 * Proves that:
 *   - The sanitizer normalizes and rejects junk consistently with auto-join.
 *   - issueInvite refuses an off-policy invitee.
 *   - acceptInvite refuses an invite that became off-policy after issuance.
 *   - applyAutoJoinForUser skips a workspace whose allowlist excludes the
 *     candidate domain, even when autoJoinDomains still includes it.
 *   - Existing members are never affected by a policy change.
 *   - SCIM createUser refuses an off-policy userName.
 *   - Cross-tenant: a policy on workspace A never leaks into workspace B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-invdom-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");
const scim = await import("../lib/scim.ts");

test("sanitizeInviteDomainAllowlist normalizes and rejects junk", () => {
  const r = ws.sanitizeInviteDomainAllowlist([
    "Acme.com", "@example.org", "bad..domain", "", "  ok-co.io  ", "acme.com",
  ]);
  assert.deepEqual(r.ok, ["acme.com", "example.org", "ok-co.io"]);
  assert.ok(r.rejected.includes("bad..domain"));
});

test("issueInvite refuses an off-policy invitee", async () => {
  const w = await ws.createWorkspace({
    name: "Acme", ownerId: "u_owner_1", ownerEmail: "owner@acme.com",
  });
  await ws.setInviteDomainAllowlist((await ws.getWorkspace(w.id))!, ["acme.com"]);

  const w1 = (await ws.getWorkspace(w.id))!;
  await assert.rejects(
    () => ws.issueInvite({
      workspace: w1,
      email: "intruder@evil.com",
      role: "viewer",
      invitedBy: "u_owner_1",
      origin: "http://localhost",
    }),
    /invite_domain_not_allowed/,
  );

  // On-policy invite still works.
  const w2 = (await ws.getWorkspace(w.id))!;
  const issued = await ws.issueInvite({
    workspace: w2,
    email: "alice@acme.com",
    role: "viewer",
    invitedBy: "u_owner_1",
    origin: "http://localhost",
  });
  assert.ok(issued.token);
});

test("acceptInvite refuses an invite that became off-policy after issuance", async () => {
  const w = await ws.createWorkspace({
    name: "Widgets", ownerId: "u_owner_2", ownerEmail: "owner@widgets.io",
  });
  // No policy yet, issue an invite.
  const issued = await ws.issueInvite({
    workspace: (await ws.getWorkspace(w.id))!,
    email: "bob@contractor.org",
    role: "viewer",
    invitedBy: "u_owner_2",
    origin: "http://localhost",
  });
  // Owner now tightens the policy to widgets.io only.
  await ws.setInviteDomainAllowlist((await ws.getWorkspace(w.id))!, ["widgets.io"]);

  const accepted = await ws.acceptInvite({
    token: issued.token,
    userId: "u_bob_1",
    userEmail: "bob@contractor.org",
  });
  assert.equal(accepted, null);
  const after = await ws.getWorkspace(w.id);
  assert.equal(after!.members.find((m) => m.userId === "u_bob_1"), undefined);
});

test("auto-join honors invite-domain allowlist", async () => {
  const w = await ws.createWorkspace({
    name: "Gizmo", ownerId: "u_owner_3", ownerEmail: "owner@gizmo.co",
  });
  await ws.setAutoJoin((await ws.getWorkspace(w.id))!, ["gizmo.co", "old.com"], "viewer");
  // Allowlist tightens: only gizmo.co domain may join.
  await ws.setInviteDomainAllowlist((await ws.getWorkspace(w.id))!, ["gizmo.co"]);

  const joined = await ws.applyAutoJoinForUser({
    userId: "u_legacy_1", email: "carol@old.com", viaSso: false,
  });
  assert.equal(joined.length, 0);

  const joined2 = await ws.applyAutoJoinForUser({
    userId: "u_new_1", email: "dave@gizmo.co", viaSso: false,
  });
  assert.equal(joined2.length, 1);
  assert.equal(joined2[0].id, w.id);
});

test("policy change does not evict existing members", async () => {
  const w = await ws.createWorkspace({
    name: "Legacy", ownerId: "u_owner_4", ownerEmail: "owner@legacy.dev",
  });
  // Add a member with a different domain first.
  const cur = (await ws.getWorkspace(w.id))!;
  cur.members.push({
    userId: "u_existing_1", email: "ex@outside.org", role: "viewer", joinedAt: Date.now(),
  });
  // Persist via setInviteDomainAllowlist which writes the workspace.
  await ws.setInviteDomainAllowlist(cur, ["legacy.dev"]);
  const after = await ws.getWorkspace(w.id);
  assert.ok(after!.members.some((m) => m.userId === "u_existing_1"));
  // The existing member is still treated as allowed by the policy.
  assert.equal(ws.isEmailAllowedForWorkspace(after!, "ex@outside.org"), true);
  // But a new outside email is not.
  assert.equal(ws.isEmailAllowedForWorkspace(after!, "new@outside.org"), false);
});

test("SCIM createUser refuses an off-policy userName", async () => {
  const w = await ws.createWorkspace({
    name: "Strict", ownerId: "u_owner_5", ownerEmail: "owner@strict.io",
  });
  await ws.setInviteDomainAllowlist((await ws.getWorkspace(w.id))!, ["strict.io"]);
  await assert.rejects(
    () => scim.createUser({
      workspaceId: w.id,
      baseUrl: "http://localhost/scim/v2/" + w.id,
      body: { userName: "intruder@evil.com", emails: [{ value: "intruder@evil.com", primary: true }] },
    }),
    (e: unknown) => e instanceof Error && /domain not permitted/.test(e.message),
  );
  // On-policy still works.
  const u = await scim.createUser({
    workspaceId: w.id,
    baseUrl: "http://localhost/scim/v2/" + w.id,
    body: { userName: "good@strict.io" },
  });
  assert.ok(u.id);
});

test("cross-tenant: policy on workspace A does not constrain workspace B", async () => {
  const a = await ws.createWorkspace({
    name: "A", ownerId: "u_a_o", ownerEmail: "o@a.com",
  });
  const b = await ws.createWorkspace({
    name: "B", ownerId: "u_b_o", ownerEmail: "o@b.com",
  });
  await ws.setInviteDomainAllowlist((await ws.getWorkspace(a.id))!, ["a.com"]);
  // B has no policy: any domain is fine.
  const bws = (await ws.getWorkspace(b.id))!;
  const issued = await ws.issueInvite({
    workspace: bws,
    email: "anyone@whatever.io",
    role: "viewer",
    invitedBy: "u_b_o",
    origin: "http://localhost",
  });
  assert.ok(issued.token);
  // A still rejects.
  const aws = (await ws.getWorkspace(a.id))!;
  await assert.rejects(
    () => ws.issueInvite({
      workspace: aws,
      email: "anyone@whatever.io",
      role: "viewer",
      invitedBy: "u_a_o",
      origin: "http://localhost",
    }),
    /invite_domain_not_allowed/,
  );
});
