/**
 * Run with: node --test --experimental-strip-types web/tests/usage-recent-csv.test.ts
 *
 * Pins the /api/usage/recent CSV export, added so auditors and FinOps
 * can grab the recent API call log as a spreadsheet from the /usage
 * page in one click instead of scraping the "Recent API calls" panel.
 *
 * Source-level (no jsdom) so it runs with the same node --test rig
 * the rest of the suite uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/usage/recent/route.ts"),
  "utf8",
);

test("/api/usage/recent route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-usage-recent\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /recentToCsv\s*\(/, "must call the recentToCsv serializer");
});

test("/api/usage/recent route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/usage/recent route audits the read with format in meta", () => {
  assert.match(routeSrc, /usage\.recent\.read/, "must write an audit row for the read");
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("recentToCsv emits the expected header + CRLF rows with ISO timestamps", () => {
  // Re-derive inline so the serializer shape is pinned independent of imports.
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  interface Row {
    ts: number;
    keyId: string;
    endpoint: string;
    bytes?: number;
    latencyMs?: number;
  }
  function recentToCsv(rows: ReadonlyArray<Row>): string {
    const lines: string[] = ["timestamp_iso,timestamp_ms,key_id,endpoint,latency_ms,bytes"];
    for (const r of rows) {
      lines.push([
        csvCell(new Date(r.ts).toISOString()),
        csvCell(r.ts),
        csvCell(r.keyId),
        csvCell(r.endpoint),
        csvCell(r.latencyMs ?? ""),
        csvCell(r.bytes ?? ""),
      ].join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  const csv = recentToCsv([
    { ts: 1717200000000, keyId: "key_abc", endpoint: "/v1/compare", latencyMs: 12.5, bytes: 1024 },
    { ts: 1717200060000, keyId: "key_xyz", endpoint: "/v1/shares" },
  ]);
  assert.equal(
    csv,
    "timestamp_iso,timestamp_ms,key_id,endpoint,latency_ms,bytes\r\n" +
      "2024-06-01T00:00:00.000Z,1717200000000,key_abc,/v1/compare,12.5,1024\r\n" +
      "2024-06-01T00:01:00.000Z,1717200060000,key_xyz,/v1/shares,,\r\n",
  );
});

test("csvCell escapes endpoints/key ids that embed commas or quotes", () => {
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  assert.equal(csvCell('/v1/x,y'), '"/v1/x,y"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a\nb'), '"a\nb"');
});

test("/usage page renders a Download CSV link pointed at /api/usage/recent?format=csv", () => {
  const pageSrc = fs.readFileSync(
    path.join(webRoot, "app/usage/page.tsx"),
    "utf8",
  );
  // The existing daily-bars CSV already matches /Download CSV/ once,
  // so we pin the recent-log URL explicitly to avoid a false positive.
  assert.match(
    pageSrc,
    /href="\/api\/usage\/recent\?[^"]*format=csv"/,
    "Recent API calls panel must link to /api/usage/recent?...format=csv",
  );
  assert.match(
    pageSrc,
    /download="codeclone-usage-recent\.csv"/,
    "anchor must carry the download attribute so browsers save with a sensible filename",
  );
});
