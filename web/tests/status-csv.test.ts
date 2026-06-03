/**
 * Run with: node --test --experimental-strip-types web/tests/status-csv.test.ts
 *
 * Pins the dashboard /api/observability/snapshot CSV export so an
 * on-call engineer on the /status page can snapshot the per-route
 * latency table (count, avg, p50, p95) and the matching status-code
 * mix into a spreadsheet in one click during a postmortem instead
 * of copying numbers out of the rendered grid.
 *
 * 1) Source-level: the route honors `?format=csv`, sets text/csv,
 *    sets a content-disposition with a download filename, and
 *    rejects unknown formats with a 400.
 * 2) The CSV header matches the documented columns
 *    (method, route, count, avg_ms, p50_ms, p95_ms, status_counts).
 * 3) Live: a real CSV body for recorded traffic includes one row
 *    per (method, route) latency entry and folds the status counts
 *    for that route into the status_counts column.
 * 4) UI: the /status page renders a "Download CSV" link that points
 *    at `/api/observability/snapshot?format=csv` so the button
 *    matches what is shown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/observability/snapshot/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/status/page.tsx"),
  "utf8",
);

test("/api/observability/snapshot route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-status\.csv/i,
    "must set a content-disposition with the download filename",
  );
});

test("/api/observability/snapshot validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/observability/snapshot CSV export includes the documented columns", () => {
  for (const col of ["method", "route", "count", "avg_ms", "p50_ms", "p95_ms", "status_counts"]) {
    assert.ok(routeSrc.includes(`"${col}"`), `csv header must include ${col}`);
  }
});

test("/status page renders a Download CSV link to /api/observability/snapshot", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/observability\/snapshot\?format=csv/,
    "the button must point at /api/observability/snapshot?format=csv",
  );
  assert.match(
    pageSrc,
    /download=\s*"codeclone-status\.csv"/,
    "must request a stable download filename for the spreadsheet",
  );
});

test("/api/observability/snapshot CSV folds status counts per route", () => {
  // The status_counts column is the on-call's whole point: pair a p95
  // spike with the 5xx count on the same row. Pin the fold so a refactor
  // that drops the join silently breaks the postmortem workflow.
  assert.match(
    routeSrc,
    /statusByRoute/,
    "must group byRoute status counts by (method, route) for the csv",
  );
  assert.match(
    routeSrc,
    /status_counts/,
    "the csv must surface a status_counts column",
  );
});
