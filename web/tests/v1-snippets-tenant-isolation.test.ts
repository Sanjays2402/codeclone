/**
 * Run with: node --test --experimental-strip-types web/tests/v1-snippets-tenant-isolation.test.ts
 *
 * Covers /v1/snippets and /v1/snippets/:id, the programmatic snippet
 * corpus management endpoints. The high-value contract is per-user
 * tenant isolation: a key minted by user A must never read, list,
 * mutate, or delete user B's snippets, even though both live on the
 * same on-disk store.
 *
 * The route source itself is asserted to wire:
 *   - the scope checks (snippets:read for GET, snippets:write for
 *     POST/PATCH/DELETE)
 *   - the billable per-key rate-limit enforce (not peek)
 *   - the full workspace enforcement chain (lockdown, ws allowlist,
 *     key allowlist, residency, api-key policy, DPA)
 *   - tenant scoping to key.userId (no path that lets the URL or
 *     query string select a different user's records)
 *   - audit rows under stable v1.snippets.* action ids
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-snippets-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-snippets-rl-"));
const tmpSn = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-snippets-data-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_SNIPPETS_DIR = tmpSn;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "snippets", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "snippets", "[id]", "route.ts"),
  "utf8",
);

const { hasScope, ALL_SCOPES, SCOPE_DESCRIPTIONS, createKey } = await import(
  "../lib/api-keys.ts"
);
const { createSnippet, loadSnippet, listSnippets, deleteSnippet, updateSnippet } =
  await import("../lib/snippets.ts");

test("v1/snippets: list/create route wires scopes, rate-limit, enforcement chain, user scope, audit", () => {
  assert.match(listRouteSrc, /hasScope\(key, "snippets:read"\)/);
  assert.match(listRouteSrc, /hasScope\(key, "snippets:write"\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(listRouteSrc),
    "v1/snippets must enforce, not peek",
  );
  assert.match(listRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(listRouteSrc, /enforceKeyAllowlist/);
  assert.match(listRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceDpaForKey/);
  // Tenant scope: every store call uses key.userId. No path that
  // reads userId from the URL, query string, or body.
  assert.match(listRouteSrc, /listSnippets\(key\.userId,/);
  assert.match(listRouteSrc, /createSnippet\(key\.userId,/);
  assert.ok(
    !/userId.*searchParams|searchParams.*userId/.test(listRouteSrc),
    "v1/snippets must not let query string select user",
  );
  assert.match(listRouteSrc, /"v1\.snippets\.list"/);
  assert.match(listRouteSrc, /"v1\.snippets\.create"/);
});

test("v1/snippets/:id: get/patch/delete route wires scopes, rate-limit, enforcement chain, user scope, audit", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "snippets:read"\)/);
  assert.match(itemRouteSrc, /hasScope\(key, "snippets:write"\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  assert.match(itemRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceDpaForKey/);
  assert.match(itemRouteSrc, /loadSnippet\(key\.userId,/);
  assert.match(itemRouteSrc, /updateSnippet\(key\.userId,/);
  assert.match(itemRouteSrc, /deleteSnippet\(key\.userId,/);
  assert.match(itemRouteSrc, /"v1\.snippets\.read"/);
  assert.match(itemRouteSrc, /"v1\.snippets\.update"/);
  assert.match(itemRouteSrc, /"v1\.snippets\.delete"/);
});

test("v1/snippets: ALL_SCOPES exposes snippets:read and snippets:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("snippets:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("snippets:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["snippets:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["snippets:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("v1/snippets: hasScope enforces snippets:read and snippets:write independently", async () => {
  const readOnly = await createKey("snippets-reader", {
    userId: "user_reader",
    workspaceId: "ws_a",
    scopes: ["snippets:read"],
  });
  const writeOnly = await createKey("snippets-writer", {
    userId: "user_writer",
    workspaceId: "ws_b",
    scopes: ["snippets:write"],
  });
  const compareOnly = await createKey("compare-only", {
    userId: "user_other",
    workspaceId: "ws_c",
    scopes: ["compare:write"],
  });
  assert.equal(hasScope(readOnly.record, "snippets:read"), true);
  assert.equal(hasScope(readOnly.record, "snippets:write"), false);
  assert.equal(hasScope(writeOnly.record, "snippets:write"), true);
  assert.equal(hasScope(writeOnly.record, "snippets:read"), false);
  assert.equal(hasScope(compareOnly.record, "snippets:read"), false);
  assert.equal(hasScope(compareOnly.record, "snippets:write"), false);
});

test("v1/snippets: live per-user tenant isolation, user B's key can never see user A's snippets", async () => {
  // Two users, two snippets, same store.
  const recA = await createSnippet("user_alice", {
    title: "alice baseline",
    language: "python",
    body: "def alice():\n    return 1\n",
    tags: ["alice", "baseline"],
  });
  const recB = await createSnippet("user_bob", {
    title: "bob baseline",
    language: "python",
    body: "def bob():\n    return 2\n",
    tags: ["bob"],
  });

  // Sanity: per-user list is partitioned.
  const aliceList = await listSnippets("user_alice");
  const bobList = await listSnippets("user_bob");
  assert.equal(aliceList.length, 1);
  assert.equal(bobList.length, 1);
  assert.equal(aliceList[0].id, recA.id);
  assert.equal(bobList[0].id, recB.id);

  // The /v1 routes always pass key.userId into the lib. Simulate
  // that contract: Bob's key (userId = user_bob) trying to fetch
  // Alice's snippet by guessing the id must come back null. The lib
  // defensively rechecks `rec.userId === userId` after load so this
  // holds even if the file paths collide.
  const crossLoad = await loadSnippet("user_bob", recA.id);
  assert.equal(crossLoad, null, "user_bob must not be able to read user_alice's snippet");

  // Same contract for delete and update.
  const crossDelete = await deleteSnippet("user_bob", recA.id);
  assert.equal(crossDelete, false, "user_bob must not be able to delete user_alice's snippet");
  const stillThere = await loadSnippet("user_alice", recA.id);
  assert.ok(stillThere, "alice's snippet must survive a cross-tenant delete attempt");

  const crossUpdate = await updateSnippet("user_bob", recA.id, { title: "pwned" });
  assert.equal(crossUpdate, null, "user_bob must not be able to update user_alice's snippet");
  const reloaded = await loadSnippet("user_alice", recA.id);
  assert.equal(reloaded!.title, "alice baseline", "alice's snippet must keep its title");

  // And cross-tenant listing must never leak.
  for (const r of bobList) {
    assert.notEqual(r.id, recA.id);
    assert.equal(r.userId, "user_bob");
  }
});
