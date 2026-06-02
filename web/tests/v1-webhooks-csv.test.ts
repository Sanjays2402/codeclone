/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhooks-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/webhooks. The route handler imports
 * next/server and cannot be loaded under raw `node --test`, so this
 * follows the source-level wiring pattern in v1-members-csv.test.ts:
 * it grep-asserts the route file actually wires the format param, the
 * CSV branch (content-type, per-workspace filename, RFC 4180 escaping),
 * and audits the format choice so a JSON ops poll and a CSV inventory
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
  path.resolve(here, "..", "app", "api", "v1", "webhooks", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/webhooks: route wires format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /searchParams\.get\("format"\)/);
  assert.match(routeSrc, /Invalid 'format' value/);
  // CSV branch must emit a spreadsheet content-type and a per-workspace
  // filename so curl -OJ saves it under a name a SOC 2 reviewer can
  // tell apart from other workspaces' webhook inventory pulls.
  assert.match(routeSrc, /text\/csv/);
  assert.match(routeSrc, /codeclone-\$\{key\.workspaceId\}-webhooks\.csv/);
  // RFC 4180 double-quote escaping must be in the local CSV helper so
  // a webhook label or url containing a comma or quote does not
  // corrupt the row alignment.
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every column the JSON summary returns so
  // ops/SOC 2 ingest pipelines can map columns 1:1 without guessing.
  for (const col of [
    "id",
    "label",
    "url",
    "events",
    "disabled",
    "secret_prefix",
    "pending_secret_prefix",
    "created_at",
    "updated_at",
    "success_count",
    "failure_count",
    "last_delivery_at",
    "last_status",
    "last_error",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/webhooks: CSV must not bypass enforcement or audit", () => {
  // Enforce, not peek, the rate-limit window. A nightly inventory
  // pull is a real call against the customer's key budget.
  assert.match(routeSrc, /enforceRateLimit\(key\)/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "csv path must enforce, not peek");
  // Audit row is new on GET; format choice is recorded in the meta
  // blob so a CSV inventory export is distinguishable from a JSON poll.
  assert.match(routeSrc, /"v1\.webhooks\.read"/);
  assert.match(routeSrc, /format,?\s*\n\s*\}/);
  // Tenant scope and lockdown/allowlist/residency/policy chain must
  // all still run before the CSV is built.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Scope unchanged: this is a narrower slice of the same data, not a
  // new privilege, so it stays behind webhooks:read.
  assert.match(routeSrc, /hasScope\(key, "webhooks:read"\)/);
  // Tenant scope on the listing call itself.
  assert.match(routeSrc, /listWebhooksForWorkspace\(key\.workspaceId\)/);
});

test("v1/webhooks: api-spec advertises ?format=csv so discovery and openapi regenerate", () => {
  const idx = specSrc.indexOf('id: "webhooks-list"');
  assert.ok(idx > 0, "webhooks-list entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
