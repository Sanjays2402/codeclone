import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { listAudit, toCsv, tryRecordAudit, MAX_LIST } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/audit
 *
 * Read the audit log. Signed-in users only. Supports filters by actor,
 * workspace, action, target, status, and a since/until time window.
 * Pass ?format=csv for a CSV export download.
 *
 * Query params:
 *   actorId, workspaceId, action, targetType, targetId, status
 *   since, until           ISO 8601 or ms epoch
 *   limit                  1..500 (default 100)
 *   format                 json (default) | csv
 *
 * Reading the log is itself audited so any export leaves a trail.
 */
export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;

  const parseTime = (raw: string | null): number | undefined => {
    if (!raw) return undefined;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    const d = new Date(raw).getTime();
    return Number.isFinite(d) ? d : undefined;
  };

  const limitRaw = Number(sp.get("limit") ?? "100");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIST)
    : 100;

  const status = sp.get("status");
  const validStatus =
    status === "ok" || status === "denied" || status === "error" ? status : undefined;

  const entries = await listAudit({
    actorId: sp.get("actorId") ?? undefined,
    workspaceId: sp.get("workspaceId") ?? undefined,
    action: sp.get("action") ?? undefined,
    targetType: sp.get("targetType") ?? undefined,
    targetId: sp.get("targetId") ?? undefined,
    status: validStatus,
    since: parseTime(sp.get("since")),
    until: parseTime(sp.get("until")),
    limit,
  });

  const format = (sp.get("format") || "json").toLowerCase();

  if (format === "csv") {
    await tryRecordAudit(req, {
      action: "audit.export",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "audit_log" },
      meta: { rows: entries.length, format: "csv" },
    });
    return new NextResponse(toCsv(entries), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${Date.now()}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  await tryRecordAudit(req, {
    action: "audit.read",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "audit_log" },
    meta: { rows: entries.length, filters: Object.fromEntries(sp.entries()) },
  });

  return NextResponse.json({ items: entries, count: entries.length, limit });
}
