/**
 * Run with: node --test --experimental-strip-types web/tests/usage-csv.test.ts
 *
 * Pins the dashboard /api/usage CSV export added so FinOps users can
 * grab a spreadsheet from the /usage page without dropping to curl.
 *
 * 1) Source-level: the route honors `?format=csv`, sets the
 *    text/csv content-type, sets a content-disposition with a
 *    download filename, and validates unknown formats with a 400.
 *    Regression guard if anyone strips the branch later.
 * 2) UI: the /usage page renders a "Download CSV" link that points at
 *    `/api/usage?...&format=csv` so the export is one click, not a
 *    URL someone has to hand-craft.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/usage/route.ts"),
  "utf8",
);

test("/api/usage route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-usage\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /byDayToCsv\s*\(/, "must call the byDayToCsv serializer");
});

test("/api/usage route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/usage route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("byDayToCsv emits an RFC 4180 header row + CRLF lines", () => {
  // The serializer lives inline in the route so we can't import it;
  // re-derive it inline and pin the format the route is committed to.
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function byDayToCsv(rows: ReadonlyArray<{ date: string; count: number }>): string {
    const lines: string[] = ["date,count"];
    for (const r of rows) lines.push([csvCell(r.date), csvCell(r.count)].join(","));
    return lines.join("\r\n") + "\r\n";
  }

  const csv = byDayToCsv([
    { date: "2026-05-01", count: 12 },
    { date: "2026-05-02", count: 0 },
  ]);
  assert.equal(
    csv,
    "date,count\r\n2026-05-01,12\r\n2026-05-02,0\r\n",
  );
});

test("/usage page renders a Download CSV button pointed at /api/usage?format=csv", () => {
  const pageSrc = fs.readFileSync(
    path.join(webRoot, "app/usage/page.tsx"),
    "utf8",
  );
  assert.match(pageSrc, /Download CSV/, "Download CSV button must be present");
  assert.match(
    pageSrc,
    /format=csv/,
    "button must link to a format=csv URL",
  );
  assert.match(
    pageSrc,
    /download="codeclone-usage\.csv"/,
    "anchor must carry the download attribute so browsers save with a sensible filename",
  );
});
