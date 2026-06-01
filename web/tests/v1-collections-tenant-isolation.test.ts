/**
 * Run with: node --test --experimental-strip-types web/tests/v1-collections-tenant-isolation.test.ts
 *
 * Covers /v1/collections and /v1/collections/:id, the programmatic
 * share-collection management endpoints. The high-value contract is
 * per-workspace tenant isolation: a key minted in workspace A must
 * never read, list, mutate, or delete workspace B's collections,
 * even though both live on the same on-disk store.
 *
 * The route source is asserted to wire:
 *   - scope checks (collections:read for GET, collections:write for
 *     POST/PATCH/DELETE)
 *   - billable per-key rate-limit enforce (not peek)
 *   - full workspace enforcement chain (lockdown, ws allowlist,
 *     key allowlist, residency, api-key policy, DPA)
 *   - tenant scoping via key.workspaceId on every store call (no
 *     path that lets URL/query/body select a different workspace)
 *   - audit rows under stable v1.collections.* action ids
 *
 * Then a live test exercises the store directly to prove that the
 * workspaceId filter the routes pass into listCollections actually
 * partitions records across tenants, and that records owned by
 * workspace A are invisible to workspace B.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-coll-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-coll-rl-"));
const tmpColl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-coll-data-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_COLLECTIONS_DIR = tmpColl;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "collections", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "collections", "[id]", "route.ts"),
  "utf8",
);

const { hasScope, ALL_SCOPES, SCOPE_DESCRIPTIONS, createKey } = await import(
  "../lib/api-keys.ts"
);
const { createCollection, listCollections, loadCollection } = await import(
  "../lib/collections.ts"
);

test("v1/collections: list/create route wires scopes, rate-limit, enforcement chain, workspace scope, audit", () => {
  assert.match(listRouteSrc, /hasScope\(key, "collections:read"\)/);
  assert.match(listRouteSrc, /hasScope\(key, "collections:write"\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(listRouteSrc),
    "v1/collections must enforce, not peek",
  );
  assert.match(listRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(listRouteSrc, /enforceKeyAllowlist/);
  assert.match(listRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceDpaForKey/);
  // Tenant scope: every store call uses key.workspaceId. No path
  // that reads workspaceId from URL, query string, or body.
  assert.match(listRouteSrc, /workspaceId: key\.workspaceId/);
  assert.match(listRouteSrc, /allowLegacy: false/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(listRouteSrc),
    "v1/collections must not let query string select workspace",
  );
  assert.match(listRouteSrc, /"v1\.collections\.list"/);
  assert.match(listRouteSrc, /"v1\.collections\.create"/);
});

test("v1/collections/:id: get/patch/delete route wires scopes, rate-limit, enforcement chain, workspace scope, audit", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "collections:read"\)/);
  assert.match(itemRouteSrc, /hasScope\(key, "collections:write"\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  assert.match(itemRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceDpaForKey/);
  // Cross-tenant access returns 404 (not 403) so existence is not
  // leaked across workspaces.
  assert.match(itemRouteSrc, /workspaceOwns\(/);
  assert.match(itemRouteSrc, /return notFound\(\)/);
  assert.match(itemRouteSrc, /"v1\.collections\.update"/);
  assert.match(itemRouteSrc, /"v1\.collections\.delete"/);
});

test("v1/collections: ALL_SCOPES exposes collections:read and collections:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("collections:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("collections:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["collections:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["collections:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("v1/collections: hasScope enforces collections:read and collections:write independently", async () => {
  const readOnly = await createKey("coll-reader", {
    workspaceId: "ws_a",
    scopes: ["collections:read"],
  });
  const writeOnly = await createKey("coll-writer", {
    workspaceId: "ws_b",
    scopes: ["collections:write"],
  });
  const compareOnly = await createKey("compare-only", {
    workspaceId: "ws_c",
    scopes: ["compare:write"],
  });
  assert.equal(hasScope(readOnly.record, "collections:read"), true);
  assert.equal(hasScope(readOnly.record, "collections:write"), false);
  assert.equal(hasScope(writeOnly.record, "collections:write"), true);
  assert.equal(hasScope(writeOnly.record, "collections:read"), false);
  assert.equal(hasScope(compareOnly.record, "collections:read"), false);
  assert.equal(hasScope(compareOnly.record, "collections:write"), false);
});

test("v1/collections: live per-workspace tenant isolation, workspace B can never see workspace A's collections", async () => {
  // Two workspaces, three collections, same store.
  const a1 = await createCollection({
    title: "acme sprint 42 dupes",
    workspaceId: "ws_acme",
  });
  const a2 = await createCollection({
    title: "acme migration audit",
    workspaceId: "ws_acme",
  });
  const b1 = await createCollection({
    title: "globex baseline review",
    workspaceId: "ws_globex",
  });
  // Plus one legacy unscoped record (no workspaceId, simulating
  // pre-multitenant dashboard write).
  const legacy = await createCollection({
    title: "legacy single-tenant collection",
  });
  assert.equal(legacy.workspaceId, undefined);

  // Acme key sees only acme records. allowLegacy: false matches
  // the /v1 contract.
  const acmePage = await listCollections({
    workspaceId: "ws_acme",
    allowLegacy: false,
    limit: 100,
  });
  const acmeIds = new Set(acmePage.items.map((r) => r.id));
  assert.equal(acmePage.total, 2);
  assert.ok(acmeIds.has(a1.id));
  assert.ok(acmeIds.has(a2.id));
  assert.ok(!acmeIds.has(b1.id), "ws_acme must not see ws_globex collection");
  assert.ok(!acmeIds.has(legacy.id), "ws_acme must not see legacy unscoped collection via /v1");

  // Globex key sees only globex records.
  const globexPage = await listCollections({
    workspaceId: "ws_globex",
    allowLegacy: false,
    limit: 100,
  });
  const globexIds = new Set(globexPage.items.map((r) => r.id));
  assert.equal(globexPage.total, 1);
  assert.ok(globexIds.has(b1.id));
  assert.ok(!globexIds.has(a1.id));
  assert.ok(!globexIds.has(a2.id));
  assert.ok(!globexIds.has(legacy.id));

  // Cross-tenant loadCollection returns the record, but the route's
  // workspaceOwns check (asserted statically above) rejects it. We
  // verify the stamp survived the round trip so workspaceOwns has
  // something real to compare against.
  const reloaded = await loadCollection(a1.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.workspaceId, "ws_acme");

  // A workspace with no records gets an empty page (not the global
  // store).
  const emptyPage = await listCollections({
    workspaceId: "ws_unknown",
    allowLegacy: false,
    limit: 100,
  });
  assert.equal(emptyPage.total, 0);
  assert.equal(emptyPage.items.length, 0);
});
