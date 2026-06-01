/**
 * Run with: node --test --experimental-strip-types web/tests/v1-collection-items-tenant-isolation.test.ts
 *
 * Covers /v1/collections/:id/items, the programmatic membership-edit
 * endpoints. Two contracts matter to enterprise buyers:
 *
 *   1. A workspace A key cannot mutate a workspace B collection.
 *      Cross-tenant access returns 404, not 403, so existence of the
 *      other tenant's collection is never leaked.
 *   2. A workspace A key cannot link a workspace B share into its own
 *      workspace A collection. The share-existence check is itself
 *      tenant-scoped, so cross-tenant share IDs look like "not
 *      found", preventing membership-edit from being used as a cross
 *      -tenant existence oracle.
 *
 * Static route assertions wire scopes, rate-limit (enforce, not peek),
 * the full workspace enforcement chain, audit identifiers, and that
 * shareScope is threaded into addItem with key.workspaceId rather than
 * pulled from URL/query/body.
 *
 * The live test exercises the underlying store: a workspace B share
 * passed into addItem under workspace A's scope hint must be rejected
 * as "share not found", and the collection's shareIds must be
 * unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-rl-"));
const tmpColl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-coll-"));
const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-shares-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_COLLECTIONS_DIR = tmpColl;
process.env.CODECLONE_SHARES_DIR = tmpShares;

const here = path.dirname(fileURLToPath(import.meta.url));
const itemsRouteSrc = fs.readFileSync(
  path.resolve(
    here,
    "..",
    "app",
    "api",
    "v1",
    "collections",
    "[id]",
    "items",
    "route.ts",
  ),
  "utf8",
);

const { createCollection, addItem, loadCollection } = await import(
  "../lib/collections.ts"
);
const { createShare } = await import("../lib/share.ts");

test("v1/collections/:id/items: route wires scopes, rate-limit, enforcement chain, tenant-scoped shareScope, audit", () => {
  // Scope: writes-only on both verbs.
  assert.match(itemsRouteSrc, /hasScope\(key, "collections:write"\)/);
  assert.ok(
    !/hasScope\(key, "collections:read"\)/.test(itemsRouteSrc),
    "items mutation route should require collections:write, not read",
  );
  // Billable rate-limit enforce.
  assert.match(itemsRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(itemsRouteSrc),
    "items route must enforce, not peek",
  );
  // Full enforcement chain.
  assert.match(itemsRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemsRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemsRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceDpaForKey/);
  // Tenant ownership check on the parent collection, returning 404.
  assert.match(itemsRouteSrc, /workspaceOwns\(existing, key\.workspaceId\)/);
  assert.match(itemsRouteSrc, /return notFound\(\)/);
  // The share is loaded under the key's workspace scope, not the
  // caller's choice, so cross-tenant share IDs cannot be linked.
  assert.match(
    itemsRouteSrc,
    /shareScope: \{ workspaceId: key\.workspaceId \}/,
  );
  // workspaceId never read from request URL/body/query.
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(itemsRouteSrc),
    "items route must not let query string select workspace",
  );
  assert.ok(
    !/body\.workspaceId|b\.workspaceId/.test(itemsRouteSrc),
    "items route must not let body select workspace",
  );
  // Audit identifiers stable.
  assert.match(itemsRouteSrc, /"v1\.collections\.item_add"/);
  assert.match(itemsRouteSrc, /"v1\.collections\.item_remove"/);
});

test("v1/collections/:id/items: cross-tenant share cannot be linked into another workspace's collection", async () => {
  // Workspace A has a collection.
  const acmeCollection = await createCollection({
    title: "acme dupes",
    workspaceId: "ws_acme",
  });
  // Workspace B owns a share. Both stores share the same on-disk
  // filesystem prefix, so the only thing keeping these apart is the
  // workspace stamp + the route's shareScope hint.
  const globexShare = await createShare({
    a: "console.log(1)",
    b: "console.log(2)",
    language: "typescript",
    // Minimal ShareResult-shaped object; this test exercises tenant
    // scoping, not the comparison engine, so we keep the fixture
    // local rather than booting the trainer.
    result: {
      language: "typescript",
      scores: {
        shingleJaccard: 0.1,
        tokenJaccard: 0.1,
        containment: 0.1,
        shared: { tokens: 0, shingles: 0 },
        size: { aTokens: 1, bTokens: 1, aShingles: 1, bShingles: 1 },
        matchedTokens: [],
      },
      alignment: { pairs: [], lengthA: 1, lengthB: 1 },
      clone: {
        type: "type-3",
        label: "type-3",
        confidence: 0.1,
        structuralJaccard: 0.1,
      },
      bytes: { a: 1, b: 1 },
      latency_ms: 0.1,
      method: "shingle",
    } as unknown as Parameters<typeof createShare>[0]["result"],
    title: "globex internal review",
    workspaceId: "ws_globex",
  });
  assert.equal(globexShare.workspaceId, "ws_globex");

  // Simulate the /v1 route path: addItem invoked with the calling
  // key's workspace as shareScope. Workspace A asking to link a
  // workspace B share must be rejected as if the share did not
  // exist, never leaking that workspace B owns it.
  await assert.rejects(
    addItem(acmeCollection.id, globexShare.id, {
      shareScope: { workspaceId: "ws_acme" },
    }),
    /share not found/i,
    "workspace A must not be able to link a workspace B share",
  );

  // Collection membership is unchanged.
  const after = await loadCollection(acmeCollection.id);
  assert.ok(after);
  assert.deepEqual(after!.shareIds, []);

  // The same share linked under workspace B's own scope succeeds, so
  // the rejection above is genuinely about cross-tenant isolation and
  // not a side effect of broken share lookup.
  const globexCollection = await createCollection({
    title: "globex baseline",
    workspaceId: "ws_globex",
  });
  const linked = await addItem(globexCollection.id, globexShare.id, {
    shareScope: { workspaceId: "ws_globex" },
  });
  assert.ok(linked);
  assert.deepEqual(linked!.shareIds, [globexShare.id]);
});
