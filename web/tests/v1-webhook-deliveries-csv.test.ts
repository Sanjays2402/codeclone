/**
 * Run with: node --test --experimental-strip-types web/tests/v1-webhook-deliveries-csv.test.ts
 *
 * Covers ?format=csv on GET /v1/webhooks/{id}/deliveries. The route
 * handler imports next/server and cannot be loaded under raw
 * `node --test`, so this follows the source-level wiring pattern
 * already used in v1-webhook-failures-csv.test.ts and the other
 * v1-*-csv tests: grep-assert the route file actually wires the new
 * csv branch (content-type, per-webhook filename, RFC 4180 escaping)
 * without dropping any of the existing /v1 enforcement chain or
 * tenant scope. CSV is the same data sliced differently, so it stays
 * behind the existing webhooks:read scope and the same per-key
 * rate-limit slot a JSON poll would burn.
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
    "webhooks",
    "[id]",
    "deliveries",
    "route.ts",
  ),
  "utf8",
);

test("v1/webhooks/[id]/deliveries: route accepts format=csv and rejects unknown formats", () => {
  assert.match(routeSrc, /format !== "json" && format !== "csv"/);
  assert.match(routeSrc, /'json' or 'csv'/);
  // csv branch emits spreadsheet content-type and a per-webhook
  // filename so curl -OJ saves it under a name an on-call manager
  // can tell apart from other webhooks' delivery exports.
  assert.match(routeSrc, /text\/csv/);
  assert.match(
    routeSrc,
    /codeclone-\$\{key\.workspaceId\}-\$\{rec\.id\}-deliveries\.csv/,
  );
  // RFC 4180 double-quote escaping must live in a local CSV helper so
  // an error string containing a comma or quote does not corrupt the
  // row alignment.
  assert.match(routeSrc, /deliveriesToCsv/);
  assert.match(routeSrc, /csvCell/);
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/);
  // CSV header must list every field the DeliveryRecord shape returns
  // so SIEM ingest pipelines can map columns 1:1 without guessing.
  for (const col of [
    "id",
    "webhookId",
    "event",
    "attemptedAt",
    "attempts",
    "status",
    "ok",
    "durationMs",
    "error",
    "redeliveredFrom",
  ]) {
    assert.ok(
      routeSrc.includes(`"${col}"`),
      `CSV header missing column ${col}`,
    );
  }
});

test("v1/webhooks/[id]/deliveries: csv must not bypass enforcement or tenant scope", () => {
  // Still enforce, not peek, the rate-limit window. A CSV pull is a
  // real call against the customer's key budget.
  assert.match(routeSrc, /enforceRateLimit\(key\)/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "csv path must enforce, not peek",
  );
  // Tenant scope and the full /v1 chain must run before the csv body
  // is built: the webhook itself is loaded via the workspace-scoped
  // loader, and the deliveries list is fetched against the same
  // workspace so a cross-tenant id cannot exfiltrate another
  // workspace's delivery log via ?format=csv.
  assert.match(
    routeSrc,
    /loadWebhookForWorkspace\(id, key\.workspaceId\)/,
  );
  assert.match(
    routeSrc,
    /listDeliveriesForWorkspace\(id, key\.workspaceId\)/,
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
