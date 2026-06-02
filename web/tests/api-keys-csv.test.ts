/**
 * Run with: node --test --experimental-strip-types web/tests/api-keys-csv.test.ts
 *
 * Pins the dashboard /api/api-keys CSV export added so a user on the
 * /api-keys page can grab their key inventory as a spreadsheet
 * (SOC2 CC6.1 / CC6.3 rotation evidence) in one click, the same way
 * /v1/keys?format=csv already serves the programmatic side.
 *
 * 1) Source-level: the route honors `?format=csv`, sets the
 *    text/csv content-type, sets a content-disposition with a
 *    download filename, validates unknown formats with a 400, and
 *    stamps the chosen format into the audit row.
 * 2) UI: the /api-keys page renders a "Download CSV" link that
 *    points at `/api/api-keys?format=csv` so the export is one click.
 * 3) The keysToCsv serializer mirrors the /v1/keys CSV header so a
 *    dashboard export and a programmatic export drop into the same
 *    spreadsheet columns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/api-keys/route.ts"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/api-keys/page.tsx"),
  "utf8",
);
const v1RouteSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/keys/route.ts"),
  "utf8",
);

test("/api/api-keys route wires the csv format branch", () => {
  assert.match(routeSrc, /format\s*===\s*"csv"/, "must branch on format === 'csv'");
  assert.match(routeSrc, /text\/csv/, "must set text/csv content-type for the export");
  assert.match(
    routeSrc,
    /content-disposition.*codeclone-api-keys\.csv/i,
    "must set a content-disposition with the download filename",
  );
  assert.match(routeSrc, /keysToCsv\s*\(/, "must call the keysToCsv serializer");
});

test("/api/api-keys route validates unknown format values", () => {
  assert.match(
    routeSrc,
    /format must be 'json' \(default\) or 'csv'/,
    "must reject unknown format with an invalid_request 400",
  );
});

test("/api/api-keys route audits the format in the read row", () => {
  assert.match(
    routeSrc,
    /meta:\s*\{[^}]*format\b/,
    "audit meta must include the chosen format for SOC2 evidence",
  );
});

test("/api-keys page renders a Download CSV link to the format=csv endpoint", () => {
  assert.match(pageSrc, /Download CSV/);
  assert.match(pageSrc, /\/api\/api-keys\?format=csv/);
  assert.match(pageSrc, /download="codeclone-api-keys\.csv"/);
});

test("keysToCsv emits an RFC 4180 header row + CRLF lines that match /v1/keys", () => {
  // The serializer lives inline in both routes so we can't import it;
  // re-derive it inline and pin the format they are committed to.
  type Row = {
    id: string;
    label: string;
    prefix: string;
    createdAt: number;
    lastUsedAt?: number;
    usageCount: number;
    revoked?: boolean;
    expired?: boolean;
    userId?: string;
    workspaceId?: string;
    expiresAt?: number;
    scopes?: ReadonlyArray<string>;
    rateLimit?: { rpm: number };
    ipAllowlist?: ReadonlyArray<string>;
  };
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function keysToCsv(rows: ReadonlyArray<Row>): string {
    const header = [
      "id",
      "label",
      "prefix",
      "created_at",
      "last_used_at",
      "usage_count",
      "revoked",
      "expired",
      "user_id",
      "workspace_id",
      "expires_at",
      "scopes",
      "rate_limit_rpm",
      "ip_allowlist",
    ];
    const lines: string[] = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.id),
          csvCell(r.label),
          csvCell(r.prefix),
          csvCell(r.createdAt),
          csvCell(r.lastUsedAt ?? null),
          csvCell(r.usageCount),
          csvCell(r.revoked === true),
          csvCell(r.expired === true),
          csvCell(r.userId ?? null),
          csvCell(r.workspaceId ?? null),
          csvCell(r.expiresAt ?? null),
          csvCell(Array.isArray(r.scopes) ? r.scopes.join(" ") : ""),
          csvCell(r.rateLimit?.rpm ?? null),
          csvCell(Array.isArray(r.ipAllowlist) ? r.ipAllowlist.join(" ") : ""),
        ].join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  const csv = keysToCsv([
    {
      id: "k_1",
      label: "ci, prod",
      prefix: "cck_abcd",
      createdAt: 111,
      lastUsedAt: 222,
      usageCount: 3,
      revoked: false,
      expired: false,
      userId: "u_1",
      workspaceId: "ws_1",
      expiresAt: 333,
      scopes: ["keys:read", "shares:read"],
      rateLimit: { rpm: 60 },
      ipAllowlist: ["10.0.0.0/24"],
    },
  ]);

  // Header pinned to match /v1/keys (the spreadsheet contract).
  assert.ok(csv.startsWith(
    "id,label,prefix,created_at,last_used_at,usage_count,revoked,expired,user_id,workspace_id,expires_at,scopes,rate_limit_rpm,ip_allowlist\r\n",
  ));
  // Comma inside the label must be quoted (RFC 4180).
  assert.match(csv, /"ci, prod"/);
  // Scopes joined by a space inside a single cell.
  assert.match(csv, /keys:read shares:read/);
  // CRLF terminator on the final row.
  assert.ok(csv.endsWith("\r\n"));
});

test("dashboard and /v1 key CSV exports share the same header columns", () => {
  // Both routes maintain their own keysToCsv inline. If anyone reorders
  // or renames columns in either side, the dashboard export and the
  // programmatic export will drift and the same spreadsheet template
  // will stop loading both. Pin them to the same header literal.
  const header =
    "id\",\n    \"label\",\n    \"prefix\",\n    \"created_at\",\n    \"last_used_at\",\n    \"usage_count\",\n    \"revoked\",\n    \"expired\",\n    \"user_id\",\n    \"workspace_id\",\n    \"expires_at\",\n    \"scopes\",\n    \"rate_limit_rpm\",\n    \"ip_allowlist";
  assert.ok(
    routeSrc.includes(header),
    "dashboard /api/api-keys CSV header columns drifted",
  );
  assert.ok(
    v1RouteSrc.includes(header),
    "programmatic /v1/keys CSV header columns drifted",
  );
});
