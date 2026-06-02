/**
 * Run with: node --test --experimental-strip-types web/tests/collections-csv.test.ts
 *
 * Pins the dashboard /api/collections CSV export so a user on the
 * /collections page can grab their saved share collections as a
 * spreadsheet in one click, the same way /v1/collections?format=csv
 * already serves the programmatic side.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, rejects
 *    unknown formats with a 400, and stamps the chosen format into
 *    the collections.read audit row.
 * 2) UI: the /collections page renders a CSV download link that
 *    points at `/api/collections?format=csv` so the export is one
 *    click.
 * 3) The dashboard CSV header mirrors /v1/collections?format=csv so
 *    spreadsheet templates that already consume the programmatic
 *    export keep working unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/collections/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/collections/page.tsx"),
  "utf8",
);
const v1RouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/collections/route.ts"),
  "utf8",
);

test("/api/collections route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-collections\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(
    routeSrc,
    /collectionsToCsv\s*\(/,
    "must call the collectionsToCsv serializer",
  );
});

test("/api/collections route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/collections route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /action:\s*"collections\.read"/,
    "must record a collections.read audit row on csv export",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("/collections page renders a CSV link to the format=csv endpoint", () => {
  assert.match(
    pageSrc,
    /href=\s*"\/api\/collections\?format=csv"/,
    "the button must point at /api/collections?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-collections\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});

test("dashboard collections CSV header mirrors /v1/collections CSV header", () => {
  const headerRe = /const header = \[([\s\S]*?)\];/;
  const a = headerRe.exec(routeSrc);
  const b = headerRe.exec(v1RouteSrc);
  assert.ok(a, "dashboard route must declare a header array");
  assert.ok(b, "/v1 route must declare a header array");
  const parse = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
      .filter((s) => s.length > 0);
  assert.deepEqual(
    parse(a![1]),
    parse(b![1]),
    "dashboard and /v1 CSV exports must drop into the same spreadsheet columns",
  );
});
