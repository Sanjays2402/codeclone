/**
 * Run with: node --test --experimental-strip-types web/tests/run-cases-csv.test.ts
 *
 * Pins the dashboard /api/runs/[runId]/cases CSV export so a
 * researcher on the /eval/[runId] page can grab the per-case eval
 * results as a spreadsheet in one click instead of scraping the
 * heatmap.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a per-run download filename,
 *    rejects unknown formats with a 400, and returns 404 for an
 *    unknown run id.
 * 2) The CSV path honors the result=pass|fail filter so a reviewer
 *    who narrowed to failing cases actually gets that narrowed slice.
 * 3) UI: the /eval/[runId] page renders a "Download cases CSV"
 *    button that points at the per-run cases endpoint and only
 *    renders when there are per-case scores to export.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/runs/[runId]/cases/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/eval/[runId]/page.tsx"),
  "utf8",
);

test("/api/runs/[runId]/cases route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-run-/i,
    "must set a content-disposition with a per-run download filename",
  );
});

test("/api/runs/[runId]/cases route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/runs/[runId]/cases route returns 404 for an unknown run id", () => {
  assert.match(routeSrc, /not_found/, "must surface not_found for missing runs");
  assert.match(routeSrc, /status:\s*404/, "must return a 404 status for missing runs");
});

test("/api/runs/[runId]/cases CSV export includes the documented columns", () => {
  for (const col of ["run_id", "case", "result", "passed", "note"]) {
    assert.ok(routeSrc.includes(`"${col}"`), `csv header must include ${col}`);
  }
});

test("/api/runs/[runId]/cases CSV export honors the result filter", () => {
  assert.match(routeSrc, /searchParams\.get\("result"\)/);
  assert.match(routeSrc, /result === "pass"|"pass"/);
  assert.match(routeSrc, /"fail"/);
});

test("/eval/[runId] page renders a Download cases CSV button to the per-run endpoint", () => {
  assert.match(pageSrc, /Download cases CSV/);
  assert.match(
    pageSrc,
    /\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/cases\?format=csv/,
    "the button must point at /api/runs/[runId]/cases?format=csv",
  );
  assert.match(
    pageSrc,
    /codeclone-run-/,
    "must request a stable per-run download filename for the spreadsheet",
  );
  assert.match(
    pageSrc,
    /ev\?\.mini_scores && ev\.mini_scores\.length > 0/,
    "must only render the button when there are per-case scores to export",
  );
});
