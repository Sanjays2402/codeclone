/**
 * Run with:
 *   node --test --experimental-strip-types web/tests/v1-collection-items-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/collections/{id}/items. Follows the
 * same source-level wiring pattern the other v1-*-csv tests use: the
 * route handler imports next/server and cannot be loaded under raw
 * `node --test`, so this grep-asserts the route file actually wires
 * the format param, rejects unknown values, keeps the full /v1
 * enforcement chain in front of the CSV branch, and emits an RFC
 * 4180 spreadsheet response. Also pins that api-spec advertises the
 * new format param so /v1/discovery and /v1/openapi.json|yaml
 * regenerate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
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
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/collections/:id/items: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /searchParams\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // Spreadsheet content type and per-workspace, per-collection
  // download filename so a reviewer running curl -OJ can tell two
  // collection exports apart.
  assert.match(routeSrc, /text\/csv; charset=utf-8/);
  assert.match(
    routeSrc,
    /codeclone-\$\{filenameWs\}-collection-\$\{page\.collectionId\}-items\.csv/,
  );
  // RFC 4180 double-quote escaping must live in the local helper so a
  // title containing a comma or quote does not corrupt row alignment
  // when imported into Excel.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every column a reviewer needs to reconcile
  // a collection's items, plus the workspace_id stamp so multi-tenant
  // exports stay traceable.
  for (const col of [
    "collection_id",
    "workspace_id",
    "share_id",
    "title",
    "language",
    "clone_label",
    "shingle_jaccard",
    "bytes_a",
    "bytes_b",
    "created_at",
    "missing",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/collections/:id/items: CSV must not bypass the enforcement chain", () => {
  // Enforce, not peek, the rate-limit window. A nightly spreadsheet
  // export is a real call against the customer's budget and must show
  // up in /usage.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek the rate limit",
  );
  // Tenant scope plus the full /v1 policy chain must all still run
  // before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(routeSrc, /enforceWorkspaceDpaForKey/);
  // Scope unchanged: csv is a narrower presentation of the same data,
  // not a new privilege, so it stays behind collections:read.
  assert.match(routeSrc, /hasScope\(key, "collections:read"\)/);
  // The csv branch must reuse the same workspace-scoped listItems
  // call (no separate unscoped fetch path) so a cross-tenant share
  // surfaces as { missing: true }, never as another workspace's row.
  assert.match(routeSrc, /listItems\(/);
  assert.match(routeSrc, /shareScope:\s*\{\s*workspaceId:\s*key\.workspaceId/);
  assert.match(routeSrc, /notBoundToWorkspace\(\)/);
  // Audit row should record which format the caller asked for so a
  // SOC2 reviewer can tell a JSON poll from a spreadsheet export.
  assert.match(routeSrc, /format,?\s*\n/);
});

test("v1/collections/:id/items: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "collections-item-list"');
  assert.ok(idx > 0, "collections-item-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
