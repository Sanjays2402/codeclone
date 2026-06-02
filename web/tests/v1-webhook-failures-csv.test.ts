/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhook-failures-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/webhooks/failures. The route handler
 * imports next/server and cannot be loaded under raw `node --test`,
 * so this follows the source-level wiring pattern in
 * v1-sessions-csv.test.ts and v1-members-csv.test.ts: it grep-asserts
 * the route file actually wires the new csv branch (content-type,
 * per-workspace filename, RFC 4180 escaping) without dropping any of
 * the existing /v1 enforcement chain, audit row, or tenant scope.
 * It also pins that api-spec advertises csv as a format option so
 * /v1/discovery and /v1/openapi.json|yaml regenerate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "webhooks", "failures", "route.ts"),
  "utf8",
);
const specSrc = fs.readFileSync(
  path.resolve(here, "..", "lib", "api-spec.ts"),
  "utf8",
);

test("v1/webhooks/failures: route accepts format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /format !== "ndjson" && format !== "json" && format !== "csv"/);
  assert.match(routeSrc, /'ndjson', 'json', or 'csv'/);
  // csv branch emits spreadsheet content-type and a per-workspace
  // filename so curl -OJ saves it under a name an on-call manager
  // can tell apart from other workspaces' failure exports.
  assert.match(routeSrc, /text\/csv/);
  assert.match(
    routeSrc,
    /codeclone-\$\{key\.workspaceId\}-webhook-failures\.csv/,
  );
  // RFC 4180 double-quote escaping must live in a local CSV helper so
  // a webhook label or error string containing a comma or quote does
  // not corrupt the row alignment.
  assert.match(routeSrc, /failuresToCsv/);
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every field the RecentFailure shape returns
  // so SIEM ingest pipelines can map columns 1:1 without guessing.
  for (const col of [
    "webhookId",
    "label",
    "url",
    "event",
    "attemptedAt",
    "status",
    "attempts",
    "error",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/webhooks/failures: csv must not bypass enforcement, audit, or tenant scope", () => {
  // Still enforce, not peek, the rate-limit window. An incident-review
  // CSV pull is a real call against the customer's key budget.
  assert.match(routeSrc, /enforceRateLimit\(key\)/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Audit row id stays stable so existing SIEM/SOC2 queries keep
  // working, and the format choice is already recorded in the meta
  // blob so a csv export is distinguishable from an ndjson poll.
  assert.match(routeSrc, /"v1\.webhooks\.failures\.read"/);
  assert.match(routeSrc, /format,?\s*\n\s*\}/);
  // Tenant scope and the full /v1 chain must run before the csv body
  // is built.
  assert.match(
    routeSrc,
    /collectRecentFailures\([\s\S]*workspaceId:\s*key\.workspaceId/,
  );
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Scope unchanged: this is the same data sliced differently, not a
  // new privilege, so it stays behind webhooks:read.
  assert.match(routeSrc, /hasScope\(key, "webhooks:read"\)/);
});

test("v1/webhooks/failures: api-spec advertises ?format=csv", () => {
  const idx = specSrc.indexOf('id: "webhooks-failures"');
  assert.ok(idx > 0, "webhooks-failures entry missing from api-spec");
  const slice = specSrc.slice(idx, idx + 2000);
  assert.match(slice, /name: "format"/);
  assert.match(slice, /csv/);
});
