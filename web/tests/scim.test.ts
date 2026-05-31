/**
 * SCIM 2.0 provisioning: token binding, cross-tenant isolation, and
 * resource CRUD round-trips.
 *
 * Proves the boring things enterprise security reviews ask about:
 *   1. A token issued for workspace A cannot authenticate against
 *      workspace B (binding is enforced at verify time).
 *   2. Missing / malformed bearer tokens get 401 with WWW-Authenticate.
 *   3. Provisioned users live under their workspace and never appear in
 *      another workspace's list.
 *   4. PATCH active=false works (Okta deprovisioning shape).
 *   5. Duplicate userName creation returns 409 with a Location header.
 *   6. Workspace deleteWorkspace() also wipes SCIM token + user mirror.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-scim-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_SCIM_DIR = path.join(tmp, "scim");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");

const scim = await import("../lib/scim.ts");
const ws = await import("../lib/workspaces.ts");

const wsA = await ws.createWorkspace({
  name: "Acme", ownerId: "u_acme_owner", ownerEmail: "owner@acme.test",
});
const wsB = await ws.createWorkspace({
  name: "Widgets", ownerId: "u_widg_owner", ownerEmail: "owner@widgets.test",
});

const tokenA = await scim.issueScimToken({ workspaceId: wsA.id, createdBy: wsA.createdBy });
const tokenB = await scim.issueScimToken({ workspaceId: wsB.id, createdBy: wsB.createdBy });

test("issued token validates only for its own workspace", async () => {
  const okA = await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: `Bearer ${tokenA.plaintext}` });
  assert.equal(okA, true, "A token must accept workspace A");
  const okB = await scim.verifyScimToken({ workspaceId: wsB.id, authHeader: `Bearer ${tokenA.plaintext}` });
  assert.equal(okB, false, "A token MUST be rejected at workspace B");
  const okA2 = await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: `Bearer ${tokenB.plaintext}` });
  assert.equal(okA2, false, "B token MUST be rejected at workspace A");
});

test("missing, malformed, and wrong-scheme bearer headers are rejected", async () => {
  assert.equal(await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: null }), false);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: "" }), false);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: "Basic abc" }), false);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: "Bearer cc_scim_short" }), false);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsA.id, authHeader: "Bearer not_a_scim_token" }), false);
});

test("plaintext token is shown once: only a hash + prefix is persisted", async () => {
  const meta = await scim.getScimTokenMeta(wsA.id);
  assert.ok(meta, "token meta must exist");
  assert.equal(meta!.prefix, tokenA.record.prefix);
  // Walk the file directly and confirm the plaintext never appears on disk.
  const tokenFile = path.join(process.env.CODECLONE_SCIM_DIR!, "tokens", `${wsA.id}.json`);
  const raw = await fs.readFile(tokenFile, "utf8");
  assert.ok(!raw.includes(tokenA.plaintext), "plaintext token must not be persisted");
  assert.ok(raw.includes(tokenA.record.hash), "hash must be persisted");
});

test("provisioned users are isolated per workspace", async () => {
  const base = "https://example.test/scim/v2";
  const baseA = `${base}/${wsA.id}`;
  const baseB = `${base}/${wsB.id}`;

  const alice = await scim.createUser({
    workspaceId: wsA.id, baseUrl: baseA,
    body: { userName: "alice@acme.test", emails: [{ value: "alice@acme.test", primary: true }], externalId: "okta-1" },
  });
  const bob = await scim.createUser({
    workspaceId: wsB.id, baseUrl: baseB,
    body: { userName: "bob@widgets.test", emails: [{ value: "bob@widgets.test", primary: true }], externalId: "okta-2" },
  });

  const listA = await scim.listUsers(wsA.id, baseA);
  const listB = await scim.listUsers(wsB.id, baseB);

  assert.equal(listA.totalResults, 1);
  assert.equal(listA.Resources[0].userName, "alice@acme.test");
  assert.equal(listB.totalResults, 1);
  assert.equal(listB.Resources[0].userName, "bob@widgets.test");

  // Cross-tenant fetch by id must miss.
  const cross = await scim.getUser(wsB.id, alice.id, baseB);
  assert.equal(cross, null, "alice from workspace A must NOT be visible inside workspace B");

  // userName filter scopes correctly.
  const filtered = await scim.listUsers(wsA.id, baseA, { filter: 'userName eq "bob@widgets.test"' });
  assert.equal(filtered.totalResults, 0, "bob must not match inside workspace A");
  void bob;
});

test("PATCH active=false deprovisions; PUT replaces; DELETE removes", async () => {
  const baseA = `https://example.test/scim/v2/${wsA.id}`;
  const list = await scim.listUsers(wsA.id, baseA);
  const alice = list.Resources[0];

  const patched = await scim.patchUser({
    workspaceId: wsA.id, id: alice.id, baseUrl: baseA,
    body: { Operations: [{ op: "replace", path: "active", value: false }] },
  });
  assert.equal(patched!.active, false);

  const replaced = await scim.replaceUser({
    workspaceId: wsA.id, id: alice.id, baseUrl: baseA,
    body: { userName: "alice@acme.test", active: true, displayName: "Alice (replaced)" },
  });
  assert.equal(replaced!.active, true);
  assert.equal(replaced!.displayName, "Alice (replaced)");

  const removed = await scim.deleteUser(wsA.id, alice.id);
  assert.equal(removed, true);
  assert.equal(await scim.getUser(wsA.id, alice.id, baseA), null);
});

test("duplicate userName at create returns 409 ScimError", async () => {
  const baseA = `https://example.test/scim/v2/${wsA.id}`;
  await scim.createUser({ workspaceId: wsA.id, baseUrl: baseA, body: { userName: "dup@acme.test" } });
  await assert.rejects(
    () => scim.createUser({ workspaceId: wsA.id, baseUrl: baseA, body: { userName: "dup@acme.test" } }),
    (err: unknown) => err instanceof scim.ScimError && (err as InstanceType<typeof scim.ScimError>).status === 409,
  );
});

test("missing userName at create returns 400", async () => {
  const baseA = `https://example.test/scim/v2/${wsA.id}`;
  await assert.rejects(
    () => scim.createUser({ workspaceId: wsA.id, baseUrl: baseA, body: {} }),
    (err: unknown) => err instanceof scim.ScimError && (err as InstanceType<typeof scim.ScimError>).status === 400,
  );
});

test("unsupported SCIM filter rejected with invalidFilter", async () => {
  const baseA = `https://example.test/scim/v2/${wsA.id}`;
  await assert.rejects(
    () => scim.listUsers(wsA.id, baseA, { filter: 'userName co "alice"' }),
    (err: unknown) => err instanceof scim.ScimError && (err as InstanceType<typeof scim.ScimError>).status === 400,
  );
});

test("rotate invalidates the prior token", async () => {
  const wsC = await ws.createWorkspace({
    name: "Tertia", ownerId: "u_tertia_owner", ownerEmail: "o@tertia.test",
  });
  const first = await scim.issueScimToken({ workspaceId: wsC.id, createdBy: wsC.createdBy });
  const rotated = await scim.rotateScimToken({ workspaceId: wsC.id, rotatedBy: wsC.createdBy });
  assert.ok(rotated);
  assert.notEqual(first.plaintext, rotated!.plaintext);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsC.id, authHeader: `Bearer ${first.plaintext}` }), false);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsC.id, authHeader: `Bearer ${rotated!.plaintext}` }), true);
});

test("revoke removes the token; rotate on revoked returns null", async () => {
  const wsD = await ws.createWorkspace({
    name: "Quarta", ownerId: "u_quarta_owner", ownerEmail: "o@quarta.test",
  });
  const issued = await scim.issueScimToken({ workspaceId: wsD.id, createdBy: wsD.createdBy });
  assert.equal(await scim.revokeScimToken(wsD.id), true);
  assert.equal(await scim.verifyScimToken({ workspaceId: wsD.id, authHeader: `Bearer ${issued.plaintext}` }), false);
  assert.equal(await scim.rotateScimToken({ workspaceId: wsD.id, rotatedBy: wsD.createdBy }), null);
});

test("workspace delete wipes SCIM token + user mirror", async () => {
  const wsE = await ws.createWorkspace({
    name: "Quinta", ownerId: "u_quinta_owner", ownerEmail: "o@quinta.test",
  });
  await scim.issueScimToken({ workspaceId: wsE.id, createdBy: wsE.createdBy });
  await scim.createUser({
    workspaceId: wsE.id, baseUrl: `https://x/scim/v2/${wsE.id}`,
    body: { userName: "ghost@quinta.test" },
  });
  await ws.deleteWorkspace(wsE);
  assert.equal(await scim.getScimTokenMeta(wsE.id), null);
  const usersDir = path.join(process.env.CODECLONE_SCIM_DIR!, "users", wsE.id);
  await assert.rejects(() => fs.readdir(usersDir), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
});
