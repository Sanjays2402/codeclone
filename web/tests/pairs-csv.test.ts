/**
 * Run with: node --test --experimental-strip-types web/tests/pairs-csv.test.ts
 *
 * Pins the dashboard /api/pairs CSV export so a researcher on the
 * /pairs page can grab the filtered clone-pair index as a
 * spreadsheet in one click instead of scraping the HTML table.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, and
 *    rejects unknown formats with a 400.
 * 2) The CSV path exports the full filtered slice (not the on-screen
 *    page) so filters like ?lang=python carry into the spreadsheet.
 * 3) UI: the /pairs page renders a "Download CSV" link that points at
 *    `/api/pairs?format=csv` and propagates the active q + lang filters
 *    so the download matches what the user is looking at.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/pairs/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/pairs/page.tsx"),
  "utf8",
);

test("/api/pairs route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-pairs\.csv/i,
    "must set a content-disposition with the download filename",
  );
});

test("/api/pairs route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/pairs CSV export does not silently truncate to the on-screen page", () => {
  // The HTML view caps at 300 rows; the CSV export must not inherit that cap,
  // otherwise a "Download CSV" button on a filtered view of 5000 rows would
  // quietly hand the user only the first page of results.
  const csvBranch = routeSrc.split('if (format === "csv")')[1] ?? "";
  assert.ok(csvBranch.length > 0, "csv branch must exist before the json fallthrough");
  const cap = csvBranch.split("if (format")[0]; // just the csv branch body
  assert.doesNotMatch(
    cap,
    /\blimit:\s*(100|300)\b/,
    "csv export must not pin limit to the dashboard page size",
  );
  assert.match(
    cap,
    /MAX_SAFE_INTEGER|Infinity/,
    "csv export must request the full filtered slice",
  );
});

test("/pairs page renders a Download CSV link to the format=csv endpoint", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/pairs\?\$\{csvParams/,
    "the button must point at /api/pairs with a query string",
  );
  assert.match(
    pageSrc,
    /csvParams\.set\("q",\s*q\)/,
    "must forward the active q filter into the CSV download",
  );
  assert.match(
    pageSrc,
    /csvParams\.set\("lang",\s*lang\)/,
    "must forward the active lang filter into the CSV download",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-pairs\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});
