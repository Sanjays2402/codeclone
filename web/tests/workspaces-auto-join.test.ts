/**
 * Domain auto-join: sanitizer + cross-tenant isolation.
 *
 * Proves a user signing in with an email at one workspace's auto-join
 * domain is NEVER added to an unrelated workspace, and that SSO-enforced
 * workspaces only auto-join via the SSO callback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-autojoin-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");

test("sanitizeAutoJoinDomains accepts valid, rejects junk, lowercases, strips @", () => {
  const r = ws.sanitizeAutoJoinDomains([
    "Acme.com", "@example.org", "bad..domain", "", "x", "trailing-.com", "  ok-co.io  ",
    "acme.com", // dup
  ]);
  assert.deepEqual(r.ok, ["acme.com", "example.org", "ok-co.io"]);
  assert.ok(r.rejected.includes("bad..domain"));
  assert.ok(r.rejected.includes("trailing-.com"));
});

test("auto-join adds member only to matching workspace, never cross-tenant", async () => {
  const acme = await ws.createWorkspace({
    name: "Acme team", ownerId: "u_owner_acme", ownerEmail: "owner@acme.com",
  });
  const widgets = await ws.createWorkspace({
    name: "Widgets Inc", ownerId: "u_owner_widg", ownerEmail: "owner@widgets.io",
  });

  await ws.setAutoJoin((await ws.getWorkspace(acme.id))!, ["acme.com"], "editor");
  // Widgets has NO auto-join configured.

  const joined = await ws.applyAutoJoinForUser({
    userId: "u_new_alice0",
    email: "alice@acme.com",
    viaSso: false,
  });

  assert.equal(joined.length, 1);
  assert.equal(joined[0].id, acme.id);

  const acmeAfter = await ws.getWorkspace(acme.id);
  const widgetsAfter = await ws.getWorkspace(widgets.id);
  assert.ok(acmeAfter!.members.some((m) => m.userId === "u_new_alice0"));
  assert.ok(!widgetsAfter!.members.some((m) => m.userId === "u_new_alice0"),
    "alice@acme.com must NOT be auto-joined to widgets.io workspace");
  assert.equal(
    acmeAfter!.members.find((m) => m.userId === "u_new_alice0")!.role,
    "editor",
  );

  // Idempotent: second call is a no-op.
  const again = await ws.applyAutoJoinForUser({
    userId: "u_new_alice0", email: "alice@acme.com", viaSso: false,
  });
  assert.equal(again.length, 0);
});

test("auto-join does not match unrelated domains", async () => {
  const w = await ws.createWorkspace({
    name: "Iso", ownerId: "u_iso_owner1", ownerEmail: "o@iso.test",
  });
  await ws.setAutoJoin(w, ["iso.test"], "viewer");
  const joined = await ws.applyAutoJoinForUser({
    userId: "u_outsider01", email: "stranger@evil.example",
    viaSso: false,
  });
  assert.equal(joined.length, 0);
  const after = await ws.getWorkspace(w.id);
  assert.ok(!after!.members.some((m) => m.userId === "u_outsider01"));
});

test("SSO-enforced workspace only auto-joins via SSO", async () => {
  const w = await ws.createWorkspace({
    name: "Locked", ownerId: "u_locked_own1", ownerEmail: "o@locked.test",
  });
  await ws.setAutoJoin(w, ["locked.test"], "viewer");
  // Simulate SSO enforcement by writing the sso block directly.
  const fresh = (await ws.getWorkspace(w.id))!;
  fresh.sso = {
    provider: "oidc",
    issuer: "https://issuer.example/",
    clientId: "cid",
    clientSecret: "csec",
    allowedDomain: "locked.test",
    enforced: true,
    updatedAt: Date.now(),
    updatedBy: "u_locked_own1",
  };
  const wsPath = path.join(process.env.CODECLONE_WORKSPACES_DIR!, `${w.id}.json`);
  await fs.writeFile(wsPath, JSON.stringify(fresh));

  // Magic-link sign-in must NOT auto-join.
  const magic = await ws.applyAutoJoinForUser({
    userId: "u_magic_user0", email: "u@locked.test", viaSso: false,
  });
  assert.equal(magic.length, 0,
    "SSO-enforced workspace must not auto-join magic-link sign-ins");

  // SSO sign-in does.
  const sso = await ws.applyAutoJoinForUser({
    userId: "u_sso_user001", email: "u@locked.test", viaSso: true,
  });
  assert.equal(sso.length, 1);
  assert.equal(sso[0].id, w.id);
});
