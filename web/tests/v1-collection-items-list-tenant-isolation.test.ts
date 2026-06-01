/**
 * Run with: node --test --experimental-strip-types web/tests/v1-collection-items-list-tenant-isolation.test.ts
 *
 * Covers GET /v1/collections/:id/items, the paginated expansion of a
 * collection's membership. Three contracts matter to enterprise buyers:
 *
 *   1. A workspace A key cannot list items of a workspace B collection.
 *      Cross-tenant ids return 404, not 403, so existence of the other
 *      tenant's collection is never leaked.
 *   2. The list handler is read-only: requires collections:read, never
 *      collections:write.
 *   3. Defence in depth: shares that the calling workspace cannot see
 *      surface as `{ missing: true }` rather than leaking the cross
 *      -tenant snippet's language, title, or scores. The cursor stays
 *      stable across visibility changes.
 *
 * Static route assertions wire scope, rate-limit (enforce, not peek),
 * the full workspace enforcement chain, the new audit identifier, and
 * that loadShare is passed a workspace-scoped ShareScope rather than
 * being called bare.
 *
 * The live test exercises the underlying store: a collection owned by
 * workspace A whose shareIds include a workspace B share must report
 * the cross-tenant share as `missing` when listed under workspace A's
 * scope, and only the workspace A share's full row should be emitted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-list-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-list-rl-"));
const tmpColl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-list-coll-"));
const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-collitems-list-shares-"));
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

const { createCollection, addItem, listItems } = await import(
  "../lib/collections.ts"
);
const { createShare } = await import("../lib/share.ts");

test("v1/collections/:id/items GET: route wires read scope, rate-limit, enforcement chain, tenant-scoped loadShare, audit", () => {
  // GET handler exists and uses the read scope, not write.
  assert.match(itemsRouteSrc, /export async function GET\(/);
  assert.match(itemsRouteSrc, /hasScope\(key, "collections:read"\)/);
  // The list handler audits under its own action id, distinct from add/remove.
  assert.match(itemsRouteSrc, /"v1\.collections\.item_list"/);
  // Defence in depth: the loadShare call inside listItems is workspace
  // scoped. The route must thread the caller's workspaceId, not call
  // listItems bare.
  assert.match(
    itemsRouteSrc,
    /listItems\([\s\S]*?shareScope:\s*\{\s*workspaceId:\s*key\.workspaceId\s*\}/,
  );
  // Billable rate-limit enforce, not peek.
  assert.match(itemsRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(itemsRouteSrc),
    "items list must enforce, not peek",
  );
  // Full enforcement chain.
  assert.match(itemsRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemsRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemsRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(itemsRouteSrc, /enforceWorkspaceDpaForKey/);
  // Limit is validated against [1,100].
  assert.match(itemsRouteSrc, /limit must be an integer in \[1,100\]/);
});

test("listItems: cross-tenant share inside a collection surfaces as missing, real share renders in full", async () => {
  // Build a workspace A share, a workspace B share, and a workspace A
  // collection that (somehow) references both. POST cannot create this
  // state today, but old data, manual edits, and future bugs are real,
  // so the read path must not leak the workspace B snippet.
  const sampleResult = {
    bytes: { a: 100, b: 100 },
    scores: { shingleJaccard: 0.91, tokenRatio: 0.88, lengthRatio: 1.0 },
    clone: { label: "near-duplicate", confidence: 0.92 },
    diff: [],
  } as const;

  const shareA = await createShare({
    a: "console.log('a')\n",
    b: "console.log('aa')\n",
    language: "javascript",
    result: sampleResult as never,
    title: "workspace-a row",
    workspaceId: "ws_a",
  });
  const shareB = await createShare({
    a: "print('b')\n",
    b: "print('bb')\n",
    language: "python",
    result: sampleResult as never,
    title: "workspace-b secret",
    workspaceId: "ws_b",
  });

  const coll = await createCollection({
    workspaceId: "ws_a",
    title: "ws_a curation",
  });
  // Force-link the workspace A share through the normal scoped path.
  const afterA = await addItem(coll.id, shareA.id, {
    shareScope: { workspaceId: "ws_a" },
  });
  assert.ok(afterA, "addItem under workspace A should succeed for ws_a share");
  // Force-link the workspace B share by writing the collection file directly,
  // simulating legacy data the new GET handler must safely degrade on.
  const collFile = path.join(tmpColl, `${coll.id}.json`);
  const raw = JSON.parse(fs.readFileSync(collFile, "utf8")) as {
    shareIds: string[];
  };
  raw.shareIds.push(shareB.id);
  fs.writeFileSync(collFile, JSON.stringify(raw));

  const page = await listItems(coll.id, {
    limit: 25,
    shareScope: { workspaceId: "ws_a" },
  });
  assert.ok(page, "listItems should resolve for the owning workspace");
  assert.equal(page.total, 2, "total counts every shareId, including hidden");
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, null, "single page when total <= limit");

  const visible = page.items.find((i) => i.id === shareA.id);
  const hidden = page.items.find((i) => i.id === shareB.id);
  assert.ok(visible, "workspace A share should be visible");
  assert.equal(visible.language, "javascript");
  assert.equal(visible.cloneLabel, "near-duplicate");
  assert.equal(visible.title, "workspace-a row");
  assert.notEqual(visible.missing, true);

  assert.ok(hidden, "workspace B share should appear as a placeholder row");
  assert.equal(hidden.missing, true, "cross-tenant share must be marked missing");
  assert.equal(hidden.language, "?", "cross-tenant language must not leak");
  assert.equal(hidden.cloneLabel, "missing", "cross-tenant clone label must not leak");
  assert.equal(hidden.shingleJaccard, 0, "cross-tenant score must not leak");
  assert.notEqual(
    (hidden as { title?: string }).title,
    "workspace-b secret",
    "cross-tenant title must not leak",
  );
});

test("listItems: paginates via opaque cursor and rejects unknown collection", async () => {
  const sampleResult = {
    bytes: { a: 10, b: 10 },
    scores: { shingleJaccard: 1, tokenRatio: 1, lengthRatio: 1 },
    clone: { label: "exact", confidence: 1 },
    diff: [],
  } as const;
  const coll = await createCollection({
    workspaceId: "ws_p",
    title: "paginated",
  });
  for (let i = 0; i < 3; i++) {
    const s = await createShare({
      a: `// ${i}\n`,
      b: `// ${i}!\n`,
      language: "javascript",
      result: sampleResult as never,
      workspaceId: "ws_p",
    });
    const after = await addItem(coll.id, s.id, {
      shareScope: { workspaceId: "ws_p" },
    });
    assert.ok(after, `addItem ${i} should succeed`);
  }

  const p1 = await listItems(coll.id, {
    limit: 2,
    shareScope: { workspaceId: "ws_p" },
  });
  assert.ok(p1);
  assert.equal(p1.total, 3);
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor, "should yield a cursor when more items remain");

  const p2 = await listItems(coll.id, {
    limit: 2,
    cursor: p1.nextCursor,
    shareScope: { workspaceId: "ws_p" },
  });
  assert.ok(p2);
  assert.equal(p2.items.length, 1, "second page returns the tail");
  assert.equal(p2.nextCursor, null, "no further pages");

  const missing = await listItems("zzzzzzzzzz", {
    shareScope: { workspaceId: "ws_p" },
  });
  assert.equal(missing, null, "unknown collection id returns null (route maps to 404)");
});
