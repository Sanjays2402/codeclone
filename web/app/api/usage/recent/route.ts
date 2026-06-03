import { NextResponse } from "next/server";
import { recentEvents } from "../../../../lib/usage";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser, getActiveMember, getWorkspace } from "../../../../lib/workspaces";
import { tryRecordAudit } from "../../../../lib/audit";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

interface RecentEventRow {
  ts: number;
  keyId: string;
  endpoint: string;
  bytes?: number;
  latencyMs?: number;
}

function recentToCsv(rows: ReadonlyArray<RecentEventRow>): string {
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage/recent
 *
 * Returns the most recent API calls scoped to workspaces the caller
 * is an active member of. Refuses anonymous callers. Pass
 * ?workspaceId=ws_... to scope to one workspace the caller belongs to.
 */
export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "sign in required" } },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const rawDays = url.searchParams.get("days");

  let limit = 50;
  if (rawLimit) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "limit must be 1..500." } },
        { status: 400 },
      );
    }
    limit = Math.floor(n);
  }

  const formatRaw = url.searchParams.get("format");
  const format = formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "format must be 'json' (default) or 'csv'." } },
      { status: 400 },
    );
  }

  let days = 7;
  if (rawDays) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "days must be 1..90." } },
        { status: 400 },
      );
    }
    days = Math.floor(n);
  }

  const memberWorkspaces = await listWorkspacesForUser(user.id);
  let allowedIds = new Set(memberWorkspaces.map((w) => w.id));

  const requested = url.searchParams.get("workspaceId");
  if (requested) {
    const ws = await getWorkspace(requested);
    const isMember = ws ? !!getActiveMember(ws, user.id) : false;
    if (!isMember) {
      void tryRecordAudit(req, {
        action: "usage.recent.denied",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: requested,
        target: { type: "usage_recent", id: requested },
        status: "denied",
        meta: { reason: "not_a_member" },
      });
      return NextResponse.json(
        { error: { type: "forbidden", message: "not a member of that workspace" } },
        { status: 403 },
      );
    }
    allowedIds = new Set([requested]);
  }

  try {
    const events = await recentEvents(limit, days, Date.now(), allowedIds);
    void tryRecordAudit(req, {
      action: "usage.recent.read",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: requested ?? undefined,
      target: { type: "usage_recent", id: requested ?? "all" },
      status: "ok",
      meta: { windowDays: days, limit, workspaces: Array.from(allowedIds), format },
    });
    if (format === "csv") {
      const csv = recentToCsv(events as RecentEventRow[]);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="codeclone-usage-recent.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      {
        events,
        limit,
        windowDays: days,
        scope: { workspaceIds: Array.from(allowedIds) },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal_error",
          message:
            err instanceof Error ? err.message : "Failed to load recent calls.",
        },
      },
      { status: 500 },
    );
  }
}
