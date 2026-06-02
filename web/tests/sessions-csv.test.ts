/**
 * Run with: node --test --experimental-strip-types web/tests/sessions-csv.test.ts
 *
 * Pins the dashboard /api/sessions CSV export added so a user on the
 * /settings/sessions page can grab their active sessions as a
 * spreadsheet (security review / incident response evidence) in one
 * click, the same way /v1/sessions?format=csv already serves the
 * programmatic side.
 *
 * 1) Source-level: the route honors `?format=csv`, sets the
 *    text/csv content-type, sets a content-disposition with a
 *    download filename, validates unknown formats with a 400, and
 *    stamps the chosen format into the audit row.
 * 2) UI: the /settings/sessions page renders a "Download CSV" link
 *    pointed at `/api/sessions?format=csv` so the export is one click.
 * 3) The dashboard CSV header overlaps the /v1/sessions CSV header so
 *    spreadsheets produced via UI vs API drop into the same columns,
 *    and adds a `current` column to mark the calling device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/sessions/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/settings/sessions/page.tsx"),
  "utf8",
);
const v1RouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/sessions/route.ts"),
  "utf8",
);

test("/api/sessions route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-sessions\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /sessionsToCsv\s*\(/, "must call the sessionsToCsv serializer");
});

test("/api/sessions route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/sessions route audits the format in the read row", () => {
  assert.match(routeSrc, /tryRecordAudit/, "must record an audit row on read");
  assert.match(routeSrc, /action:\s*"auth\.sessions_read"/, "audit action should be auth.sessions_read");
  assert.match(routeSrc, /format\s*\}/, "audit meta must include the chosen format");
});

test("/settings/sessions page renders a one-click Download CSV link", () => {
  assert.match(
    pageSrc,
    /href="\/api\/sessions\?format=csv"/,
    "the page must link to /api/sessions?format=csv",
  );
  assert.match(pageSrc, /Download CSV/, "the link must be labeled Download CSV");
  assert.match(pageSrc, /DownloadSimple/, "must use the DownloadSimple icon to match other download buttons");
});

test("dashboard sessions CSV header overlaps the /v1/sessions CSV header", () => {
  const shared = [
    "jti",
    "created_at",
    "expires_at",
    "last_seen_at",
    "ip",
    "user_agent",
    "created_ip",
    "created_user_agent",
  ];
  for (const col of shared) {
    assert.match(
      routeSrc,
      new RegExp(`"${col}"`),
      `dashboard CSV header must include ${col}`,
    );
    assert.match(
      v1RouteSrc,
      new RegExp(`"${col}"`),
      `/v1/sessions CSV header must include ${col} (sanity)`,
    );
  }
  assert.match(routeSrc, /"current"/, "dashboard CSV must add a current column to mark the calling device");
});

test("CSV cell quoting follows RFC 4180 for embedded quotes and newlines", () => {
  // The csvCell helper should escape ", CR, LF by wrapping in quotes and
  // doubling embedded quotes, matching the rest of the codebase.
  assert.match(routeSrc, /\/\[",\\r\\n\]\//, "csvCell must detect quote, CR, or LF");
  assert.match(routeSrc, /replace\(\/"\/g, '""'\)/, "csvCell must double embedded quotes");
});
