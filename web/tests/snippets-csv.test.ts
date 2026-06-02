/**
 * Run with: node --test --experimental-strip-types web/tests/snippets-csv.test.ts
 *
 * Pins the dashboard /api/snippets CSV export so a user on the
 * /snippets page can grab their snippet library as a spreadsheet
 * in one click, the same way /v1/snippets?format=csv already
 * serves the programmatic side.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, rejects
 *    unknown formats with a 400, and stamps the chosen format into
 *    the snippets.read audit row.
 * 2) UI: the /snippets page renders a "Download CSV" link that
 *    points at `/api/snippets?format=csv` so the export is one click.
 * 3) The dashboard CSV header mirrors /v1/snippets?format=csv so
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
  path.join(webRoot, "app/api/snippets/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/snippets/page.tsx"),
  "utf8",
);
const v1RouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/snippets/route.ts"),
  "utf8",
);

test("/api/snippets route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-snippets\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /snippetsToCsv\s*\(/, "must call the snippetsToCsv serializer");
});

test("/api/snippets route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/snippets route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /action:\s*"snippets\.read"/,
    "must record a snippets.read audit row",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("/snippets page renders a Download CSV link to the format=csv endpoint", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /href=\s*"\/api\/snippets\?format=csv"/,
    "the button must point at /api/snippets?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-snippets\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});

test("dashboard snippets CSV header mirrors /v1/snippets CSV header", () => {
  // Pull the header arrays from both routes and require the same column order.
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
