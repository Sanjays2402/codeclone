/**
 * Run with: node --test --experimental-strip-types web/tests/webhooks-csv.test.ts
 *
 * Pins the dashboard /api/webhooks CSV export added so a workspace
 * owner on the /webhooks page can grab their endpoint inventory as
 * a spreadsheet (SOC2 CC7.2 webhook configuration evidence) in one
 * click, the same way /v1/webhooks?format=csv already serves the
 * programmatic side.
 *
 * 1) Source-level: the route honors `?format=csv`, sets the text/csv
 *    content-type, sets a content-disposition with a per-workspace
 *    download filename, validates unknown formats with a 400, and
 *    stamps the chosen format into the audit row.
 * 2) UI: the /webhooks page renders a "Download CSV" link that points
 *    at `/api/webhooks?workspaceId=...&format=csv` so the export is
 *    one click and scoped to the active workspace.
 * 3) The webhooksToCsv serializer mirrors the /v1/webhooks CSV header
 *    so a dashboard export and a programmatic export drop into the
 *    same spreadsheet columns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/webhooks/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/webhooks/page.tsx"),
  "utf8",
);
const v1RouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/webhooks/route.ts"),
  "utf8",
);

test("/api/webhooks route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-\$\{[^}]+\}-webhooks\.csv/i,
    "must set a content-disposition with a per-workspace filename",
  );
  assert.match(routeSrc, /webhooksToCsv\s*\(/, "must call the webhooksToCsv serializer");
});

test("/api/webhooks route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/webhooks route audits the format and workspace in the read row", () => {
  assert.match(
    routeSrc,
    /action:\s*"webhooks\.read"/,
    "must record a webhooks.read audit row",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*workspaceId\b/,
    "audit meta must include the resolved workspaceId",
  );
});

test("/webhooks page renders a Download CSV link to the format=csv endpoint", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(
    pageSrc,
    /\/api\/webhooks\?workspaceId=\$\{encodeURIComponent\(activeWs\)\}&format=csv/,
    "must point at the workspace-scoped CSV endpoint",
  );
  assert.match(
    pageSrc,
    /download=\{`codeclone-\$\{activeWs\}-webhooks\.csv`\}/,
    "must suggest a per-workspace download filename",
  );
});

test("dashboard webhooksToCsv header matches /v1/webhooks header order", () => {
  // Extract the header arrays from both routes and compare them so a
  // CSV pulled from the dashboard drops into the same spreadsheet
  // columns as one pulled programmatically.
  function extractHeader(src: string): string[] {
    const i = src.indexOf("function webhooksToCsv");
    assert.ok(i >= 0, "webhooksToCsv function must exist");
    const headerStart = src.indexOf("const header = [", i);
    assert.ok(headerStart >= 0, "header literal must exist");
    const headerEnd = src.indexOf("];", headerStart);
    const slice = src.slice(headerStart, headerEnd);
    const out: string[] = [];
    for (const m of slice.matchAll(/"([^"]+)"/g)) out.push(m[1]);
    return out;
  }
  const dash = extractHeader(routeSrc);
  const v1 = extractHeader(v1RouteSrc);
  assert.deepEqual(
    dash,
    v1,
    "dashboard CSV header must match /v1/webhooks CSV header so columns align",
  );
});
