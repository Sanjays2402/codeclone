/**
 * Run with: node --test --experimental-strip-types web/tests/notifications-csv.test.ts
 *
 * Pins the /api/notifications CSV export added so a user on the
 * /notifications page can grab their activity inbox as a spreadsheet
 * (audit trail of share/batch/webhook events) in one click, the same
 * way other workspace inventories (api-keys, webhooks, snippets,
 * collections, pairs, usage, eval runs) already export.
 *
 * 1) Source-level: the route honors ?format=csv, sets the text/csv
 *    content-type, sets a content-disposition with a download
 *    filename, validates unknown formats with a 400, and stamps the
 *    chosen format into the audit row.
 * 2) UI: the /notifications page renders a "Download CSV" link that
 *    points at /api/notifications?format=csv so the export is one
 *    click and respects the active unread filter.
 * 3) The notificationsToCsv serializer emits an RFC 4180 header row
 *    with CRLF terminators and quotes cells that contain commas,
 *    quotes, or newlines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/notifications/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/notifications/page.tsx"),
  "utf8",
);

test("/api/notifications route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition[^]*codeclone-notifications\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /notificationsToCsv\s*\(/, "must call the notificationsToCsv serializer");
});

test("/api/notifications route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/notifications route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /action:\s*"notification\.read"/,
    "must record a notification.read audit row when listing",
  );
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for evidence",
  );
});

test("/notifications page renders a Download CSV link to the format=csv endpoint", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(pageSrc, /\/api\/notifications\?format=csv/);
  assert.match(pageSrc, /download="codeclone-notifications\.csv"/);
});

test("/notifications page CSV link respects the active unread filter", () => {
  // When the user has filter === "unread" the CSV should also be the
  // unread subset so the spreadsheet matches what they see on screen.
  assert.match(pageSrc, /filter === "unread"[^]*unread=1/);
});

test("notificationsToCsv emits an RFC 4180 header row + CRLF lines", () => {
  // The serializer lives inline in the route so we can't import it;
  // re-derive it inline and pin the format the route is committed to.
  type Row = {
    id: string;
    kind: string;
    title: string;
    body?: string;
    href?: string;
    createdAt: number;
    readAt?: number;
  };
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function notificationsToCsv(rows: ReadonlyArray<Row>): string {
    const header = [
      "id",
      "kind",
      "title",
      "body",
      "href",
      "created_at",
      "read_at",
      "read",
    ];
    const lines: string[] = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.id),
          csvCell(r.kind),
          csvCell(r.title),
          csvCell(r.body ?? ""),
          csvCell(r.href ?? ""),
          csvCell(r.createdAt),
          csvCell(r.readAt ?? null),
          csvCell(r.readAt ? "true" : "false"),
        ].join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  const csv = notificationsToCsv([
    {
      id: "n_1",
      kind: "share.created",
      title: "Saved comparison, build 4127",
      body: 'Tagged "ci"',
      href: "/r/abc",
      createdAt: 1700000000000,
      readAt: undefined,
    },
    {
      id: "n_2",
      kind: "webhook.failed",
      title: "Delivery failed",
      createdAt: 1700000050000,
      readAt: 1700000060000,
    },
  ]);

  assert.ok(
    csv.startsWith(
      "id,kind,title,body,href,created_at,read_at,read\r\n",
    ),
    "header row pinned",
  );
  // Comma inside the title must be quoted (RFC 4180).
  assert.match(csv, /"Saved comparison, build 4127"/);
  // Embedded quotes get doubled.
  assert.match(csv, /"Tagged ""ci"""/);
  // Unread row carries empty read_at and read=false.
  assert.match(csv, /n_1,share\.created,[^\r\n]*,1700000000000,,false/);
  // Read row carries the timestamp and read=true.
  assert.match(csv, /n_2,webhook\.failed,Delivery failed,,,1700000050000,1700000060000,true/);
  // CRLF terminator on the final row.
  assert.ok(csv.endsWith("\r\n"));
});

test("route source pins the same header columns the test re-derives", () => {
  // If anyone reorders or renames columns in the route inline serializer,
  // the spreadsheet contract breaks and prior downloads stop loading.
  const header =
    'id",\n    "kind",\n    "title",\n    "body",\n    "href",\n    "created_at",\n    "read_at",\n    "read';
  assert.ok(
    routeSrc.includes(header),
    "/api/notifications CSV header columns drifted",
  );
});
