import { NextResponse } from "next/server";
import { createKey, listKeys, type ApiKeySummary } from "../../../lib/api-keys";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";
import { enforceMfaEnrollment } from "../../../lib/mfa-enforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage API keys." } },
    { status: 401 },
  );
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function keysToCsv(rows: ReadonlyArray<ApiKeySummary>): string {
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

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();

  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "format must be 'json' (default) or 'csv'.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const all = await listKeys(user.id);

    // Apply the same q / status filters the dashboard exposes so a CSV pulled
    // from /api-keys?status=revoked (or a free-text label/prefix search) gives
    // the auditor exactly the slice they see on screen, not the full inventory.
    const qRaw = url.searchParams.get("q");
    const q = typeof qRaw === "string" ? qRaw.trim().toLowerCase() : "";
    const statusRaw = url.searchParams.get("status");
    const statusFilter =
      statusRaw === "active" || statusRaw === "revoked" || statusRaw === "expired"
        ? statusRaw
        : "all";
    const items = all.filter((k) => {
      if (statusFilter === "revoked" && k.revoked !== true) return false;
      if (statusFilter === "expired" && !(k.expired === true && k.revoked !== true)) return false;
      if (statusFilter === "active" && (k.revoked === true || k.expired === true)) return false;
      if (q) {
        const hay = ((k.label ?? "") + " " + (k.prefix ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    void tryRecordAudit(req, {
      action: "api_keys.read",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "api_key_inventory", id: user.id },
      status: "ok",
      meta: { count: items.length, total: all.length, format, q: q || undefined, status_filter: statusFilter === "all" ? undefined : statusFilter },
    });
    if (format === "csv") {
      const csv = keysToCsv(items);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="codeclone-api-keys.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ items, count: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface CreateBody {
  label?: unknown;
  expiresInDays?: unknown;
  scopes?: unknown;
  rpm?: unknown;
  workspaceId?: unknown;
  ipAllowlist?: unknown;
}

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const mfaBlocked = await enforceMfaEnrollment(req, user, "api_key.create");
  if (mfaBlocked) return mfaBlocked;
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    // empty body is fine; we'll default the label
  }
  try {
    const { record, plaintext } = await createKey(body.label, {
      userId: user.id,
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
      expiresInDays: body.expiresInDays,
      scopes: body.scopes,
      rpm: body.rpm,
      ipAllowlist: body.ipAllowlist,
    });
    await tryRecordAudit(req, {
      action: "api_key.create",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "api_key", id: record.id, label: record.label },
      diff: { after: { label: record.label, scopes: record.scopes, expiresAt: record.expiresAt, rateLimit: record.rateLimit, ipAllowlist: record.ipAllowlist } },
    });
    return NextResponse.json({ key: record, plaintext }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
