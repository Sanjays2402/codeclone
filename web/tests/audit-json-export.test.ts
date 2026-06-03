/**
 * Run with: node --test --experimental-strip-types web/tests/audit-json-export.test.ts
 *
 * Pins the /api/audit JSON export added so a SOC2 / SIEM reviewer can
 * download the filtered audit log as a structured JSON file (preserving
 * the nested `diff` and `meta` fields that the CSV flattens) in one
 * click from /audit, parallel to the existing CSV export.
 *
 * 1) Source-level: the route accepts `?format=json` as an export branch,
 *    sets application/json with an attachment content-disposition and a
 *    download filename, validates unknown format values with a 400, and
 *    stamps `format: "json"` into an `audit.export` row.
 * 2) The default (no `format` param) keeps returning the dashboard's
 *    `{items, count, limit}` JSON shape without attachment headers, so
 *    the /audit page client stays unchanged.
 * 3) UI: the /audit page renders a one-click "json" download link
 *    pointed at /api/audit with the active filters forwarded, the same
 *    way the existing CSV button forwards filters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/audit/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/audit/page.tsx"),
  "utf8",
);

test("/api/audit route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
  assert.match(
    routeSrc,
    /format\s*!==\s*"json"\s*&&\s*format\s*!==\s*"csv"/,
    "must check format against the allowed set",
  );
});

test("/api/audit route serves explicit ?format=json as an attachment download", () => {
  assert.match(
    routeSrc,
    /content-disposition.*audit-\$\{Date\.now\(\)\}\.json/,
    "must set a content-disposition with the audit-<ts>.json filename",
  );
  assert.match(
    routeSrc,
    /application\/json; charset=utf-8/,
    "must set application/json content-type for the export",
  );
  assert.match(
    routeSrc,
    /cache-control.*no-store/,
    "must mark the export as no-store to keep it off shared caches",
  );
});

test("/api/audit route writes audit.export with format:'json' on JSON download", () => {
  // Same row shape the CSV branch writes, so reviewers see the same
  // action verb regardless of which export format the operator picked.
  assert.match(
    routeSrc,
    /action:\s*"audit\.export"[\s\S]{0,400}format:\s*"json"/,
    "must record audit.export with meta.format = 'json'",
  );
  assert.match(
    routeSrc,
    /action:\s*"audit\.export"[\s\S]{0,400}format:\s*"csv"/,
    "must keep the existing audit.export row on the CSV branch",
  );
});

test("/api/audit route default (no format param) preserves the dashboard read shape", () => {
  // The dashboard reads /api/audit with no `format` and consumes
  // `{items, count, limit}` as a plain JSON response. The export branch
  // must only fire when format= is set explicitly, otherwise the page
  // would start downloading itself.
  assert.match(
    routeSrc,
    /if\s*\(formatRaw\)\s*\{/,
    "must gate the JSON download branch on an explicit formatRaw value",
  );
  assert.match(
    routeSrc,
    /action:\s*"audit\.read"/,
    "the default branch must keep recording audit.read (not audit.export)",
  );
  assert.match(
    routeSrc,
    /NextResponse\.json\(\{\s*items:\s*entries,\s*count:\s*entries\.length,\s*limit\s*\}\)/,
    "the default branch must keep returning {items,count,limit} without attachment headers",
  );
});

test("/audit page renders a one-click json download link with the active filters", () => {
  assert.match(
    pageSrc,
    /jsonHref\s*=\s*useMemo\(\(\)\s*=>\s*`\/api\/audit\?\$\{buildQuery\(\)\}&format=json`/,
    "the page must derive jsonHref from the same buildQuery() the csv link uses",
  );
  assert.match(
    pageSrc,
    /href=\{jsonHref\}/,
    "the page must render an anchor pointed at jsonHref",
  );
  assert.match(
    pageSrc,
    /download/,
    "the json link must carry the download attribute so browsers save instead of navigate",
  );
});
