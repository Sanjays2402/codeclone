/**
 * Run with: node --test --experimental-strip-types web/tests/datasets-csv.test.ts
 *
 * Pins the dashboard /api/datasets CSV export so a researcher on
 * the /datasets page can grab the per-language pair counts across
 * splits as a spreadsheet in one click instead of copying numbers
 * out of the rendered bar chart.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, and
 *    rejects unknown formats with a 400.
 * 2) The route validates the `split` filter (train|val|test|all)
 *    and rejects unknown splits with an invalid_request 400 so a
 *    typo does not silently widen the export.
 * 3) The CSV header matches the documented columns
 *    (split, language, pairs, share).
 * 4) UI: the /datasets page renders a "Download CSV" link that
 *    points at `/api/datasets?format=csv` so the button matches
 *    what is shown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/datasets/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/datasets/page.tsx"),
  "utf8",
);

test("/api/datasets route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-datasets\.csv/i,
    "must set a content-disposition with the download filename",
  );
});

test("/api/datasets route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/datasets route validates the split filter", () => {
  assert.match(routeSrc, /searchParams\.get\("split"\)/);
  assert.match(
    routeSrc,
    /split must be one of 'train', 'val', 'test', or 'all'/,
    "must reject unknown split with an invalid_request 400 so a typo does not silently widen the export",
  );
});

test("/api/datasets CSV export includes the documented columns", () => {
  for (const col of ["split", "language", "pairs", "share"]) {
    assert.ok(routeSrc.includes(`"${col}"`), `csv header must include ${col}`);
  }
});

test("/datasets page renders a Download CSV link to /api/datasets", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/datasets\?format=csv/,
    "the button must point at /api/datasets?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-datasets\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});
