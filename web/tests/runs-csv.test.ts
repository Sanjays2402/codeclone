/**
 * Run with: node --test --experimental-strip-types web/tests/runs-csv.test.ts
 *
 * Pins the dashboard /api/runs CSV export so an MLOps reviewer on
 * the /eval page can grab the training-run index as a spreadsheet
 * in one click instead of scraping the HTML table.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, and
 *    rejects unknown formats with a 400.
 * 2) The CSV path exports the full filtered slice (status/backend/
 *    model filters apply) so a researcher who narrowed by status
 *    actually gets that narrowed set in the spreadsheet.
 * 3) UI: the /eval page renders a "Download CSV" link that points
 *    at `/api/runs?format=csv` so the button matches what is shown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/runs/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/eval/page.tsx"),
  "utf8",
);

test("/api/runs route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-runs\.csv/i,
    "must set a content-disposition with the download filename",
  );
});

test("/api/runs route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/runs CSV export includes the documented columns", () => {
  for (const col of [
    "id",
    "recipe_hash",
    "steps",
    "last_loss",
    "backend",
    "model",
    "status",
    "started_at",
    "started_at_iso",
  ]) {
    assert.ok(routeSrc.includes(`"${col}"`), `csv header must include ${col}`);
  }
});

test("/api/runs CSV export honors status/backend/model filters", () => {
  assert.match(routeSrc, /searchParams\.get\("status"\)/);
  assert.match(routeSrc, /searchParams\.get\("backend"\)/);
  assert.match(routeSrc, /searchParams\.get\("model"\)/);
});

test("/eval page renders a Download CSV link to /api/runs", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/runs\?format=csv/,
    "the button must point at /api/runs?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-runs\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});
