/**
 * Run with: node --test --experimental-strip-types web/tests/v1-sessions-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/sessions. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * follows the source-level wiring pattern in v1-members-csv.test.ts
 * and v1-keys-usage-csv.test.ts: it grep-asserts the route file
 * actually wires the format param, the CSV branch (content-type,
 * per-workspace filename, RFC 4180 escaping), and records the format
 * choice in the audit row so a SOAR JSON poll and a SOC2 CC6.1 CSV
 * roster export stay distinguishable in the audit trail. It also
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
  path.resolve(here, "..", "app", "api", "v1", "sessions", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/sessions: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /searchParams\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // CSV branch must emit a spreadsheet content-type and a per-workspace
  // filename so curl -OJ saves it under a name a SOC2 reviewer can
  // tell apart from other workspaces' session exports.
  assert.match(routeSrc, /text\/csv/);
  assert.match(routeSrc, /codeclone-\$\{ws\.id\}-sessions\.csv/);
  // RFC 4180 double-quote escaping must be in the local CSV helper so
  // a user agent string containing a comma or quote does not corrupt
  // the row alignment.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every field the JSON shape returns so SIEM
  // ingest pipelines can map columns 1:1 without guessing.
  for (const col of [
    "jti",
    "user_id",
    "created_at",
    "expires_at",
    "last_seen_at",
    "ip",
    "user_agent",
    "created_ip",
    "created_user_agent",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/sessions: CSV must not bypass enforcement or audit", () => {
  // Still enforce, not peek, the rate-limit window. An access-review
  // CSV pull is a real call against the customer's key budget.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Audit row id stays stable so existing SIEM/SOC2 queries keep
  // working, and the format choice is recorded in the meta blob so a
  // CSV export is distinguishable from a JSON poll.
  assert.match(routeSrc, /"v1\.sessions\.read"/);
  assert.match(routeSrc, /format,?\s*\n\s*\}/);
  // Tenant scope and lockdown/allowlist/residency/policy chain must
  // all still run before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Scope unchanged: this is a narrower slice of the same data, not a
  // new privilege, so it stays behind sessions:read.
  assert.match(routeSrc, /hasScope\(key, "sessions:read"\)/);
});

test("v1/sessions: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "sessions-list"');
  assert.ok(idx > 0, "sessions-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
