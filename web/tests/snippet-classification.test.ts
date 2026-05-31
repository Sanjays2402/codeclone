/**
 * Snippet classification + workspace share-policy: end to end.
 *
 * Verifies that:
 *   1. SnippetRecords carry a classification field and default to "internal".
 *   2. The workspace ceiling defaults to "internal" and can be tightened
 *      or relaxed by the owner via setSnippetMaxShareClassification.
 *   3. decideSnippetShare blocks a "restricted" snippet under the
 *      default ceiling and allows it after the owner raises the ceiling.
 *   4. Cross-tenant: a user with multiple workspaces gets the MOST
 *      permissive ceiling among their workspaces.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-snipclass-"));
process.env.CODECLONE_SNIPPETS_DIR = path.join(tmp, "snippets");
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const snippets = await import("../lib/snippets.ts");
const workspaces = await import("../lib/workspaces.ts");
const policy = await import("../lib/snippets-policy.ts");

const USER = "u_alice00000001";

test("snippet classification: defaults to internal and persists", async () => {
  const rec = await snippets.createSnippet(USER, {
    title: "sample",
    language: "python",
    body: "print(1)\n",
  });
  assert.equal(rec.classification, "internal");

  const loaded = await snippets.loadSnippet(USER, rec.id);
  assert.ok(loaded);
  assert.equal(loaded!.classification, "internal");

  const updated = await snippets.updateSnippet(USER, rec.id, {
    classification: "restricted",
  });
  assert.ok(updated);
  assert.equal(updated!.classification, "restricted");

  // Invalid classification is silently dropped to current value.
  const sticky = await snippets.updateSnippet(USER, rec.id, {
    classification: "bogus" as unknown as "public",
  });
  assert.equal(sticky!.classification, "restricted");
});

test("snippet share policy: default ceiling blocks restricted", async () => {
  const ws = await workspaces.createWorkspace({
    name: "Acme",
    ownerId: USER,
    ownerEmail: "alice@acme.test",
  });
  const myWs = await workspaces.listWorkspacesForUser(USER);
  assert.equal(myWs.length, 1);

  const restricted = await snippets.createSnippet(USER, {
    title: "secret",
    language: "python",
    body: "API=1\n",
    classification: "restricted",
  });
  const internal = await snippets.createSnippet(USER, {
    title: "internal",
    language: "python",
    body: "x=1\n",
    classification: "internal",
  });

  const denied = policy.decideSnippetShare(restricted, myWs);
  assert.equal(denied.allowed, false);
  assert.equal(denied.classification, "restricted");
  assert.equal(denied.ceiling, "internal");
  assert.match(denied.reason, /blocks sharing of restricted/);

  const ok = policy.decideSnippetShare(internal, myWs);
  assert.equal(ok.allowed, true);

  // Owner raises the ceiling: restricted should now be allowed.
  await workspaces.setSnippetMaxShareClassification(ws, "restricted");
  const refreshed = await workspaces.listWorkspacesForUser(USER);
  const okNow = policy.decideSnippetShare(restricted, refreshed);
  assert.equal(okNow.allowed, true);
  assert.equal(okNow.ceiling, "restricted");

  // Clearing returns to the default ceiling.
  const ws2 = await workspaces.getWorkspace(ws.id);
  await workspaces.setSnippetMaxShareClassification(ws2!, null);
  const cleared = await workspaces.listWorkspacesForUser(USER);
  const blockedAgain = policy.decideSnippetShare(restricted, cleared);
  assert.equal(blockedAgain.allowed, false);
  assert.equal(blockedAgain.ceiling, "internal");
});

test("snippet share policy: most permissive ceiling across workspaces wins", async () => {
  const userB = "u_bob000000001";
  const strict = await workspaces.createWorkspace({
    name: "Strict",
    ownerId: userB,
    ownerEmail: "bob@strict.test",
  });
  const loose = await workspaces.createWorkspace({
    name: "Loose",
    ownerId: userB,
    ownerEmail: "bob@loose.test",
  });
  await workspaces.setSnippetMaxShareClassification(strict, "public");
  await workspaces.setSnippetMaxShareClassification(loose, "confidential");

  const list = await workspaces.listWorkspacesForUser(userB);
  assert.equal(list.length, 2);
  assert.equal(policy.effectiveShareCeiling(list), "confidential");

  const conf = await snippets.createSnippet(userB, {
    title: "c",
    language: "python",
    body: "y=1\n",
    classification: "confidential",
  });
  const d = policy.decideSnippetShare(conf, list);
  assert.equal(d.allowed, true);

  // Restricted is still blocked even with the most permissive workspace.
  const r = await snippets.createSnippet(userB, {
    title: "r",
    language: "python",
    body: "z=1\n",
    classification: "restricted",
  });
  const dr = policy.decideSnippetShare(r, list);
  assert.equal(dr.allowed, false);
  assert.equal(dr.ceiling, "confidential");
});

test("snippet share policy: no workspaces falls back to default ceiling", () => {
  assert.equal(policy.effectiveShareCeiling([]), "internal");
  const d = policy.decideSnippetShare({ classification: "confidential" }, []);
  assert.equal(d.allowed, false);
  assert.equal(d.ceiling, "internal");
});
