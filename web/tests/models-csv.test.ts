/**
 * Run with: node --test --experimental-strip-types web/tests/models-csv.test.ts
 *
 * Pins the dashboard /api/models CSV export so an MLOps reviewer on
 * the /models page can grab the adapter index (joined with eval
 * metrics) as a spreadsheet in one click instead of scraping the
 * HTML table.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, and
 *    rejects unknown formats with a 400.
 * 2) The CSV path exports the full filtered slice (backend/base
 *    filters apply) so a researcher who narrowed by backend
 *    actually gets that narrowed set in the spreadsheet.
 * 3) The CSV joins eval reports by model name so the row carries
 *    pass@1 / mini_pass_rate next to each adapter, matching what
 *    the /models page joins on screen.
 * 4) UI: the /models page renders a "Download CSV" link that points
 *    at `/api/models?format=csv` so the button matches what is shown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/models/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/models/page.tsx"),
  "utf8",
);

test("/api/models route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-models\.csv/i,
    "must set a content-disposition with the download filename",
  );
});

test("/api/models route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/models CSV export includes the documented columns", () => {
  for (const col of [
    "name",
    "base_model",
    "backend",
    "recipe_hash",
    "final_train_loss",
    "pass_at_1",
    "mini_pass_rate",
    "created_at",
  ]) {
    assert.ok(routeSrc.includes(`"${col}"`), `csv header must include ${col}`);
  }
});

test("/api/models CSV export honors backend/base filters", () => {
  assert.match(routeSrc, /searchParams\.get\("backend"\)/);
  assert.match(routeSrc, /searchParams\.get\("base"\)/);
});

test("/api/models CSV joins the eval report by model name", () => {
  assert.match(
    routeSrc,
    /loadEvalReports/,
    "must load eval reports to join pass@1 / mini_pass_rate",
  );
  assert.match(
    routeSrc,
    /byModel/,
    "must build a model-name lookup for the join",
  );
});

test("/models page renders a Download CSV link to /api/models", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/models\?format=csv/,
    "the button must point at /api/models?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-models\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});
