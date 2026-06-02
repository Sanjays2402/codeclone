/**
 * Run with: node --test --experimental-strip-types web/tests/v1-snippets-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/snippets. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * mirrors the source-level wiring pattern used by the other
 * v1-*-csv tests: grep-asserts the route file actually wires the
 * format param, rejects unknown values, and emits a spreadsheet-shaped
 * response (RFC 4180 escape, per-user filename, text/csv content
 * type) without bypassing the enforcement chain. Also pins that
 * api-spec advertises the new format param so /v1/discovery and
 * /v1/openapi.json|yaml regenerate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "snippets", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/snippets: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /sp\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // Spreadsheet content type and per-user download filename so an
  // operator running curl -OJ saves the file under a name they can
  // tell apart from other identities' snippet exports.
  assert.match(routeSrc, /text\/csv; charset=utf-8/);
  assert.match(routeSrc, /codeclone-\$\{key\.userId\}-snippets\.csv/);
  // RFC 4180 double-quote escaping must live in the local CSV helper
  // so a snippet title or body containing a comma, quote, or newline
  // does not corrupt row alignment when imported into Excel.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every snippet-summary field a reviewer needs
  // to audit a user's corpus. Body is collapsed to a bytes count so a
  // multi-line snippet does not torpedo the spreadsheet, but the id
  // is preserved for drill-down via GET /v1/snippets/{id}.
  for (const col of [
    "id",
    "title",
    "language",
    "classification",
    "tags",
    "bytes",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/snippets: CSV must not bypass the enforcement chain", () => {
  // Still enforce, not peek, the rate-limit window. A nightly
  // spreadsheet export is a real call against the customer's key
  // budget and must show up in /usage.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Lockdown / allowlist / residency / policy / DPA chain must all
  // still run before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  assert.match(routeSrc, /enforceWorkspaceDpaForKey/);
  // Scope unchanged: csv is a narrower presentation of the same data,
  // not a new privilege, so it stays behind snippets:read.
  assert.match(routeSrc, /hasScope\(key, "snippets:read"\)/);
  // The csv branch must reuse the same user-scoped listing call
  // (no separate, unscoped fetch path) and must still require a
  // user binding like the JSON path.
  assert.match(routeSrc, /listSnippets\(key\.userId/);
  assert.match(routeSrc, /notBoundToUser\(\)/);
  // Audit row should record which format the caller asked for so a
  // SOC2 reviewer can tell a JSON poll from a spreadsheet export.
  assert.match(routeSrc, /format,?\s*\n/);
});

test("v1/snippets: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "snippets-list"');
  assert.ok(idx > 0, "snippets-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
