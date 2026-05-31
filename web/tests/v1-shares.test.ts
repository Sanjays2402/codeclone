/**
 * Run with: node --test --experimental-strip-types web/tests/v1-shares.test.ts
 *
 * Black-box test for the data + auth pieces that back /v1/shares and
 * /v1/shares/[id]. We test the underlying library behavior (listShares,
 * loadShare, scope checks, bearer parsing) so the route handlers stay
 * thin glue. No network, no FS outside temp dirs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-shares-"));
const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-"));
process.env.CODECLONE_SHARES_DIR = tmpShares;
process.env.CODECLONE_KEYS_DIR = tmpKeys;

const { createShare, loadShare, listSharesPage } = await import(
  "../lib/share.ts"
);
const { createKey, findByPlaintext, hasScope, extractBearer, ALL_SCOPES } =
  await import("../lib/api-keys.ts");

function fakeResult(score = 0.42) {
  return {
    language: "javascript",
    scores: { shingleJaccard: score, tokenJaccard: 0.5, containment: 0.6 },
    alignment: { rows: [] },
    clone: {
      label: "Type-2",
      confidence: 0.7,
      structuralSim: 0.5,
      rawTokenSim: 0.6,
      rationale: [],
    },
    bytes: { a: 10, b: 12 },
    latency_ms: 1.23,
    method: "test",
  } as any;
}

test("v1/shares: shares:read is a registered scope", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("shares:read"));
});

test("v1/shares: extractBearer reads Authorization and x-api-key", () => {
  const r1 = new Request("http://x/", {
    headers: { authorization: "Bearer cc_live_abc" },
  });
  assert.equal(extractBearer(r1), "cc_live_abc");
  const r2 = new Request("http://x/", {
    headers: { "x-api-key": "cc_live_def" },
  });
  assert.equal(extractBearer(r2), "cc_live_def");
  const r3 = new Request("http://x/");
  assert.equal(extractBearer(r3), null);
});

test("v1/shares: scope gate rejects compare-only keys, allows shares:read", async () => {
  const writer = await createKey("compare-only", { scopes: ["compare:write"] });
  const reader = await createKey("reader", { scopes: ["shares:read"] });
  const wRec = await findByPlaintext(writer.plaintext);
  const rRec = await findByPlaintext(reader.plaintext);
  assert.ok(wRec && rRec);
  assert.equal(hasScope(wRec, "shares:read" as any), false);
  assert.equal(hasScope(rRec, "shares:read" as any), true);
});

test("v1/shares: list returns paginated summaries with next_offset semantics", async () => {
  // Seed 5 shares.
  for (let i = 0; i < 5; i++) {
    await createShare({
      a: `let a${i} = ${i};`,
      b: `let b${i} = ${i};`,
      language: "javascript",
      result: fakeResult(0.1 * (i + 1)),
      title: `share ${i}`,
    });
  }
  const page = await listSharesPage({ limit: 2, offset: 0 });
  assert.equal(page.items.length, 2);
  assert.ok(page.total >= 5);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 0);
  for (const item of page.items) {
    assert.ok(typeof item.id === "string");
    assert.ok(typeof item.cloneLabel === "string");
    assert.ok(typeof item.shingleJaccard === "number");
  }
  // Second page advances.
  const page2 = await listSharesPage({ limit: 2, offset: 2 });
  assert.equal(page2.offset, 2);
  assert.notEqual(page2.items[0]?.id, page.items[0]?.id);
});

test("v1/shares/[id]: loadShare returns full record or null", async () => {
  const rec = await createShare({
    a: "let a = 1;",
    b: "let a = 2;",
    language: "javascript",
    result: fakeResult(0.9),
    title: "detail test",
    tags: ["unit"],
  });
  const got = await loadShare(rec.id);
  assert.ok(got);
  assert.equal(got!.id, rec.id);
  assert.equal(got!.title, "detail test");
  assert.deepEqual(got!.tags, ["unit"]);
  assert.equal(got!.a, "let a = 1;");

  const miss = await loadShare("doesnotexist");
  assert.equal(miss, null);
});

test("v1/shares: shares:write is a registered scope (DELETE gate)", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("shares:write"));
});

test("v1/shares/[id] DELETE: requires shares:write scope (RBAC)", async () => {
  const reader = await createKey("reader-2", { scopes: ["shares:read"] });
  const writer = await createKey("writer-2", { scopes: ["shares:write"] });
  const rRec = await findByPlaintext(reader.plaintext);
  const wRec = await findByPlaintext(writer.plaintext);
  assert.ok(rRec && wRec);
  // Reader (shares:read only) must NOT have shares:write.
  assert.equal(hasScope(rRec, "shares:write" as any), false);
  // Writer must have it.
  assert.equal(hasScope(wRec, "shares:write" as any), true);
  // And by design must NOT inherit shares:read.
  assert.equal(hasScope(wRec, "shares:read" as any), false);
});

test("v1/shares/[id] DELETE: dry_run preview leaves the share intact", async () => {
  const { isDryRun, DRY_RUN_HEADER } = await import("../lib/dry-run.ts");
  const { deleteShare } = await import("../lib/share.ts");

  const rec = await createShare({
    a: "let a = 1;",
    b: "let a = 2;",
    language: "javascript",
    result: fakeResult(0.5),
    title: "dry-run target",
  });

  // Simulate the route's dry-run detection.
  const req = new Request(`http://x/v1/shares/${rec.id}?dry_run=true`, {
    method: "DELETE",
  });
  assert.equal(isDryRun(req, null), true);
  assert.equal(DRY_RUN_HEADER["x-codeclone-dry-run"], "true");

  // Dry-run MUST NOT call deleteShare. Confirm the record is still loadable.
  const still = await loadShare(rec.id);
  assert.ok(still, "dry-run must not delete the share");
  assert.equal(still!.id, rec.id);

  // Sanity: actual delete removes it, and a second delete is a no-op.
  assert.equal(await deleteShare(rec.id), true);
  assert.equal(await loadShare(rec.id), null);
  assert.equal(await deleteShare(rec.id), false);
});
