/**
 * Run with: node --test --experimental-strip-types web/tests/v1-keys-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/keys. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * follows the existing source-level wiring pattern in
 * v1-keys-usage-csv.test.ts and v1-members-csv.test.ts: it grep-asserts
 * the route file actually wires the format param, the CSV branch
 * (content-type, per-workspace filename, RFC 4180 escaping), and audits
 * the format choice so a JSON SOC2 inventory poll and a CSV inventory
 * export stay distinguishable in the audit trail. It also pins that
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
  path.resolve(here, "..", "app", "api", "v1", "keys", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/keys: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /searchParams\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // CSV branch must emit a spreadsheet content-type and a per-workspace
  // filename so curl -OJ saves it under a name a SOC2 reviewer can
  // tell apart from other workspaces' key-inventory pulls.
  assert.match(routeSrc, /text\/csv/);
  assert.match(routeSrc, /codeclone-\$\{key\.workspaceId\}-keys\.csv/);
  // RFC 4180 double-quote escaping must be in the local CSV helper so
  // a key label containing a comma or quote does not corrupt row
  // alignment.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every column the JSON shape returns so SOC2
  // and FinOps ingest pipelines can map columns 1:1 without guessing.
  for (const col of [
    "id",
    "label",
    "prefix",
    "created_at",
    "last_used_at",
    "usage_count",
    "revoked",
    "expired",
    "user_id",
    "workspace_id",
    "expires_at",
    "scopes",
    "rate_limit_rpm",
    "ip_allowlist",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/keys: CSV must not leak hashes or plaintext secrets", () => {
  // The dashboard ApiKeySummary intentionally omits hash and plaintext
  // fields. The CSV path must stay on that summary shape: no `hash`,
  // no `secret`, no `plaintext` columns should ever appear in the row
  // builder. This guards against a future refactor that swaps the
  // summary type for a full record and silently exposes the hash.
  assert.ok(
    !/csvCell\(r\.hash\b/.test(routeSrc),
    "CSV row builder must not include hash",
  );
  assert.ok(
    !/csvCell\(r\.secret\b/.test(routeSrc),
    "CSV row builder must not include secret",
  );
  assert.ok(
    !/csvCell\(r\.plaintext\b/.test(routeSrc),
    "CSV row builder must not include plaintext",
  );
});

test("v1/keys: CSV must not bypass enforcement or audit", () => {
  // Still enforce, not peek, the rate-limit window. A scheduled SOC2
  // inventory pull is a real call against the customer's key budget.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Audit row id stays stable so existing SOC2 queries keep working,
  // and the format choice is recorded in the meta blob so a CSV
  // inventory export is distinguishable from a JSON poll.
  assert.match(routeSrc, /"v1\.keys\.read"/);
  assert.match(routeSrc, /format,?\s*\}/);
  // Tenant scope and the full enforcement chain must all still run
  // before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Scope unchanged: this is a narrower slice of the same data, not a
  // new privilege, so it stays behind keys:read.
  assert.match(routeSrc, /hasScope\(key, "keys:read"\)/);
  // Tenant binding stays required (no global key dump).
  assert.match(routeSrc, /tenantRequired\(\)/);
});

test("v1/keys: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "keys-list"');
  assert.ok(idx > 0, "keys-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
  assert.match(slice, /scope: "keys:read"/);
  assert.match(slice, /path: "\/v1\/keys"/);
});
