/**
 * Pins the CSV export added to /api/security/lockouts so a workspace
 * owner investigating a brute-force burst can snapshot the active
 * lockout grid into a spreadsheet for an incident report without
 * hand-transcribing the on-screen table, parallel to the CSV export
 * already shipped on /audit, /api-keys, /usage, /sessions, and the
 * other admin inventories.
 *
 * Source-level so it runs under the same node --test rig as the rest
 * of the suite. The owner-only auth gate and the underlying lockout
 * store itself are already pinned by tests/auth-throttle.test.ts.
 *
 * Hash-only privacy: the CSV must stay hash-only just like the JSON
 * view (no raw emails, no raw IPs) so a compromised owner account
 * still cannot exfiltrate the underlying identifiers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/security/lockouts/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/settings/security/lockouts/page.tsx"),
  "utf8",
);

test("/api/security/lockouts validates the format query param", () => {
  assert.match(
    routeSrc,
    /format\s*!==\s*"json"\s*&&\s*format\s*!==\s*"csv"/,
    "must check format against the allowed set",
  );
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/security/lockouts serves ?format=csv as an attachment", () => {
  assert.match(
    routeSrc,
    /text\/csv; charset=utf-8/,
    "must set a text/csv content-type for the export",
  );
  assert.match(
    routeSrc,
    /codeclone-security-lockouts\.csv/,
    "must set a stable attachment filename",
  );
  assert.match(
    routeSrc,
    /content-disposition.*attachment/i,
    "must mark the response as a download attachment",
  );
  assert.match(
    routeSrc,
    /cache-control.*no-store/i,
    "must not let the CSV snapshot get cached on disk by a proxy",
  );
});

test("/api/security/lockouts CSV header includes scope, hash, count, and both timestamps", () => {
  for (const col of [
    "scope",
    "hash",
    "count",
    "window_start",
    "window_start_iso",
    "locked_until",
    "locked_until_iso",
  ]) {
    assert.match(
      routeSrc,
      new RegExp(`"${col}"`),
      `CSV header must include the ${col} column`,
    );
  }
});

test("/api/security/lockouts CSV never serializes raw emails or IPs", () => {
  // Privacy gate: the only identifier in the CSV row is r.hash, which
  // is already the opaque hash the throttle store keeps on disk. The
  // route must not reach into the request or the user object for raw
  // email/IP values when building the rows.
  assert.match(
    routeSrc,
    /csvCell\(r\.hash\)/,
    "must serialize only the opaque hash, not the raw identifier",
  );
  assert.doesNotMatch(
    routeSrc,
    /csvCell\(r\.email\)|csvCell\(r\.ip\)/,
    "must not serialize a raw email or ip field into the CSV",
  );
});

test("/api/security/lockouts records the export format in the audit row", () => {
  assert.match(
    routeSrc,
    /action: "security\.lockouts\.read"/,
    "must keep the existing audit action stable",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format[^}]*\}/,
    "must stamp the format into the audit meta so a CSV pull is distinguishable from a UI read",
  );
});

test("/api/security/lockouts keeps the owner-only gate before the CSV branch", () => {
  // The 403 owner check must come before format is read so an
  // unprivileged caller cannot probe the route with ?format=csv to
  // get a different response shape than the JSON path.
  const ownerIdx = routeSrc.indexOf('action: "security.lockouts.read.denied"');
  const formatIdx = routeSrc.indexOf('url.searchParams.get("format")');
  assert.ok(ownerIdx !== -1, "owner-denied audit row must still exist");
  assert.ok(formatIdx !== -1, "format param must still be read");
  assert.ok(
    ownerIdx < formatIdx,
    "owner gate must run before the format branch so non-owners cannot probe CSV",
  );
});

test("/settings/security/lockouts page exposes a Download CSV link", () => {
  assert.match(
    pageSrc,
    /\/api\/security\/lockouts\?format=csv/,
    "must point the link at the CSV export route",
  );
  assert.match(
    pageSrc,
    /download="codeclone-security-lockouts\.csv"/,
    "must hint a stable filename for the browser save dialog",
  );
  assert.match(
    pageSrc,
    /Download CSV/,
    "must render a visible Download CSV button",
  );
});
