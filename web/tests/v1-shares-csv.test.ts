/**
 * Run with: node --test --experimental-strip-types web/tests/v1-shares-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/shares. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * follows the existing source-level wiring pattern in
 * v1-members-csv.test.ts: it grep-asserts the route file actually
 * wires the format param, rejects unknown values, and emits a
 * spreadsheet-shaped response (RFC 4180 escape, per-workspace
 * filename, text/csv content type) without bypassing the enforcement
 * chain. It also pins that api-spec advertises the new format param
 * so /v1/discovery and /v1/openapi.json|yaml regenerate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "shares", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/shares: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /sp\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // Spreadsheet content type and per-workspace download filename so a
  // compliance reviewer running curl -OJ saves the file under a name
  // they can tell apart from other workspaces' share exports.
  assert.match(routeSrc, /text\/csv; charset=utf-8/);
  assert.match(routeSrc, /codeclone-\$\{filenameWs\}-shares\.csv/);
  // RFC 4180 double-quote escaping must live in the local CSV helper
  // so a share title containing a comma or quote does not corrupt the
  // row alignment when imported into Excel.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every share-summary field the JSON shape
  // returns so spreadsheet ingest pipelines can map columns 1:1
  // without guessing.
  for (const col of [
    "id",
    "workspace_id",
    "language",
    "clone_label",
    "shingle_jaccard",
    "bytes_a",
    "bytes_b",
    "title",
    "tags",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/shares: CSV must not bypass the enforcement chain", () => {
  // Still enforce, not peek, the rate-limit window. A nightly
  // spreadsheet export is a real call against the customer's key
  // budget and must show up in /usage.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Tenant scope and lockdown/allowlist/residency/policy chain must
  // all still run before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Scope unchanged: csv is a narrower presentation of the same data,
  // not a new privilege, so it stays behind shares:read.
  assert.match(routeSrc, /hasScope\(key, "shares:read"\)/);
  // The csv branch must reuse the same workspace-scoped listing call
  // (no separate, unscoped fetch path).
  assert.match(routeSrc, /listSharesPage\(/);
});

test("v1/shares: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "shares-list"');
  assert.ok(idx > 0, "shares-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
