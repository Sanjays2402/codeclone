/**
 * Run with: node --test --experimental-strip-types web/tests/workspaces-csv.test.ts
 *
 * Pins the dashboard /api/workspaces CSV export so a signed-in user
 * on the /workspaces page can grab their workspace inventory as a
 * spreadsheet in one click for an access review, an offboarding
 * checklist, or to feed downstream IGA tooling without having to
 * mint a bearer key first.
 *
 * 1) The route honors `?format=csv`, sets text/csv, sets a
 *    content-disposition with a stable download filename, rejects
 *    unknown formats with a 400, and stamps the chosen format into
 *    the workspaces.read audit row so SOC2 evidence shows who
 *    pulled the inventory and when.
 * 2) Unauthenticated callers still get 401 before any CSV is
 *    produced (the auth check is wired ahead of the format branch).
 * 3) The /workspaces page renders a CSV download link that points
 *    at /api/workspaces?format=csv so the export is one click.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/workspaces/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/workspaces/page.tsx"),
  "utf8",
);

test("/api/workspaces route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-workspaces\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(
    routeSrc,
    /workspacesToCsv\s*\(/,
    "must call the workspacesToCsv serializer",
  );
});

test("/api/workspaces route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/workspaces route still rejects unauthenticated callers before CSV", () => {
  const authIdx = routeSrc.indexOf('error: "unauthenticated"');
  const csvIdx = routeSrc.indexOf('text/csv');
  assert.ok(authIdx > 0, "auth gate must be present");
  assert.ok(csvIdx > 0, "csv branch must be present");
  assert.ok(
    authIdx < csvIdx,
    "auth gate must be wired ahead of the CSV branch so anon callers never read the inventory",
  );
});

test("/api/workspaces route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /action:\s*"workspaces\.read"/,
    "must record a workspaces.read audit row on csv export",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("/api/workspaces CSV header is the agreed inventory column set", () => {
  const headerRe = /const header = \[([\s\S]*?)\];/;
  const m = headerRe.exec(routeSrc);
  assert.ok(m, "route must declare a header array");
  const cols = m![1]
    .split(",")
    .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((s) => s.length > 0);
  assert.deepEqual(
    cols,
    ["id", "name", "slug", "my_role", "member_count", "created_at"],
    "CSV columns must stay stable so downstream spreadsheets do not silently shift",
  );
});

test("/workspaces page renders a CSV link to the format=csv endpoint", () => {
  assert.match(
    pageSrc,
    /href=\s*"\/api\/workspaces\?format=csv"/,
    "the button must point at /api/workspaces?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-workspaces\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});
