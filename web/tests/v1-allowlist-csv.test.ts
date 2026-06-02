/**
 * Run with: node --test --experimental-strip-types web/tests/v1-allowlist-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/allowlist. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * follows the same source-level wiring pattern as the other
 * v1-*-csv tests: it grep-asserts the route file actually wires the
 * format param, rejects unknown values, and emits a spreadsheet-shaped
 * response (RFC 4180 escape, per-workspace filename, text/csv content
 * type) without bypassing the existing enforcement chain. It also
 * pins that api-spec advertises the new format param so /v1/discovery
 * and /v1/openapi.json|yaml regenerate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "allowlist", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/allowlist: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /sp\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // Spreadsheet content type and per-workspace download filename so a
  // compliance reviewer running curl -OJ saves the file under a name
  // they can tell apart from other workspaces' allowlist exports.
  assert.match(routeSrc, /text\/csv; charset=utf-8/);
  assert.match(routeSrc, /codeclone-\$\{filenameWs\}-allowlist\.csv/);
  // RFC 4180 double-quote escaping must live in the local CSV helper
  // so an exotic CIDR or future free-text column does not corrupt the
  // row alignment when imported into Excel.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every column a SOC2 CC6.6 reviewer needs to
  // reconcile a workspace's CIDR allowlist plus the workspace_id
  // stamp so multi-workspace evidence dumps stay traceable.
  for (const col of [
    "workspace_id",
    "position",
    "cidr",
    "enforced",
    "generated_at",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/allowlist: CSV must not bypass the enforcement chain", () => {
  // The csv branch must still run through the shared gate that does
  // auth, scope, lockdown, workspace + key IP allowlists, residency,
  // workspace API key policy, and rate-limit before any side effect.
  // We assert that by pinning the gate() helper as the entry point.
  assert.match(routeSrc, /await gate\(req, "allowlist:read"\)/);
  // Rate-limit is enforced inside gate(); the csv branch must not
  // introduce a parallel peek path.
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Membership check (active workspace member) must still run before
  // the CSV is built. Reads are open to any active member, not just
  // owners, mirroring the JSON path.
  assert.match(routeSrc, /getActiveMember\(ws, key\.userId\)/);
  // Audit row should record which format the caller asked for so a
  // SOC2 reviewer can tell a JSON poll from a spreadsheet evidence
  // dump in the audit log.
  assert.match(routeSrc, /v1\.allowlist\.read/);
  assert.match(routeSrc, /format,?\s*\n/);
});

test("v1/allowlist: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "allowlist-get"');
  assert.ok(idx > 0, "allowlist-get entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
