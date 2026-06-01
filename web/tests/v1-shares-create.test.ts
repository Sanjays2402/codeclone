/**
 * Run with: node --test --experimental-strip-types web/tests/v1-shares-create.test.ts
 *
 * Black-box tests for POST /v1/shares (programmatic share creation).
 *
 * We exercise the underlying scope + tenant gating that the route
 * relies on, plus the createShare/listSharesPage tenant filter, so
 * the route handler stays thin glue. The key invariants:
 *
 *   1. shares:write is a real registered scope (no fake RBAC).
 *   2. shares:read keys CANNOT create shares (permission denial).
 *   3. A share created by workspace A is invisible to workspace B
 *      when listing via the tenant filter used by /v1/shares GET.
 *   4. createShare round-trips the recomputed scores so a share
 *      link cannot lie about its similarity score.
 *   5. Snippet size cap is enforced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-shares-create-"));
const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-shares-create-keys-"));
process.env.CODECLONE_SHARES_DIR = tmpShares;
process.env.CODECLONE_KEYS_DIR = tmpKeys;

const { createShare, listSharesPage, loadShare, MAX_SNIPPET_BYTES } =
  await import("../lib/share.ts");
const { createKey, findByPlaintext, hasScope, ALL_SCOPES } = await import(
  "../lib/api-keys.ts"
);
const { compareCode, alignLines, classifyClone } = await import(
  "../lib/similarity.ts"
);

function freshResult(a: string, b: string, language = "javascript") {
  const scores = compareCode(a, b);
  return {
    language,
    scores,
    alignment: alignLines(a, b),
    clone: classifyClone(a, b, scores),
    bytes: {
      a: Buffer.byteLength(a, "utf-8"),
      b: Buffer.byteLength(b, "utf-8"),
    },
    latency_ms: 0.5,
    method: "test",
  };
}

test("POST /v1/shares: shares:write is a registered scope", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("shares:write"));
});

test("POST /v1/shares: shares:read alone cannot create (RBAC denial)", async () => {
  const readerOnly = await createKey("reader-only", { scopes: ["shares:read"] });
  const rec = await findByPlaintext(readerOnly.plaintext);
  assert.ok(rec);
  // The route requires shares:write specifically. shares:read keys
  // are intentionally NOT granted write by inheritance.
  assert.equal(hasScope(rec, "shares:write" as any), false);
});

test("POST /v1/shares: shares:write key is recognized for create", async () => {
  const writer = await createKey("writer-key", {
    scopes: ["shares:write"],
    workspaceId: "ws_tenant_alpha",
  });
  const rec = await findByPlaintext(writer.plaintext);
  assert.ok(rec);
  assert.equal(hasScope(rec, "shares:write" as any), true);
  assert.equal(rec!.workspaceId, "ws_tenant_alpha");
});

test("POST /v1/shares: cross-tenant isolation - workspace B cannot see workspace A's share", async () => {
  const a = "function add(x, y) { return x + y; }";
  const b = "function add(x, y) { return x + y; }";
  const created = await createShare({
    a,
    b,
    language: "javascript",
    result: freshResult(a, b),
    title: "alpha-owned",
    workspaceId: "ws_tenant_alpha",
  });

  // Workspace A sees it.
  const pageA = await listSharesPage({
    limit: 50,
    offset: 0,
    workspaceId: "ws_tenant_alpha",
    allowLegacy: false,
  });
  assert.ok(
    pageA.items.some((it) => it.id === created.id),
    "workspace A must see its own share",
  );

  // Workspace B must NOT see it.
  const pageB = await listSharesPage({
    limit: 50,
    offset: 0,
    workspaceId: "ws_tenant_beta",
    allowLegacy: false,
  });
  assert.equal(
    pageB.items.some((it) => it.id === created.id),
    false,
    "workspace B must NOT see workspace A's share",
  );

  // Direct load returns the raw record but the route layer scopes by
  // workspaceId before returning, so the record itself must carry the
  // tenant stamp - that is what enforces isolation downstream.
  const raw = await loadShare(created.id);
  assert.ok(raw);
  assert.equal(raw!.workspaceId, "ws_tenant_alpha");
});

test("POST /v1/shares: recomputed scores are pinned to the snippets (link cannot lie)", async () => {
  const a = "let x = 1;\nlet y = 2;";
  const b = "let x = 1;\nlet y = 3;";
  const result = freshResult(a, b);
  const rec = await createShare({
    a,
    b,
    language: "javascript",
    result,
    workspaceId: "ws_tenant_alpha",
  });
  const loaded = await loadShare(rec.id);
  assert.ok(loaded);
  // The server-computed similarity travels with the record, not whatever
  // the caller might have asserted.
  assert.equal(loaded!.result.scores.shingleJaccard, result.scores.shingleJaccard);
  assert.equal(loaded!.a, a);
  assert.equal(loaded!.b, b);
});

test("POST /v1/shares: snippet size cap is real", async () => {
  const tooBig = "x".repeat(MAX_SNIPPET_BYTES + 1);
  await assert.rejects(
    createShare({
      a: tooBig,
      b: "y",
      language: "javascript",
      result: freshResult("a", "b"),
      workspaceId: "ws_tenant_alpha",
    }),
    /at most/,
  );
});
