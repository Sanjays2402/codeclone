import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { listAudit, toCsv, tryRecordAudit, MAX_LIST } from "../../../lib/audit";
import { listWorkspacesForUser, getWorkspace, getActiveMember, retentionCutoffMs } from "../../../lib/workspaces";

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
 *   requestId              exact-match X-Request-Id from a prior response
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

  // Tenant scoping: a signed-in caller may only read audit entries from
  // workspaces they are a member of, plus their own null-workspace events
  // (for example sign-in / session events). If a specific workspaceId is
  // requested it must be one they belong to; otherwise refuse with 403 and
  // record a denied audit entry so the attempt itself is auditable.
  const memberWorkspaces = await listWorkspacesForUser(user.id);
  const allowedWorkspaceIds = new Set(memberWorkspaces.map((w) => w.id));

  // Build the per-workspace retention cutoff map. listAudit applies this
  // to drop entries older than the owner-configured retention window for
  // each workspace the caller can see. Workspaces without a policy are
  // omitted so their entries are returned unfiltered.
  const retentionCutoffByWorkspace = new Map<string, number>();
  for (const w of memberWorkspaces) {
    const cutoff = retentionCutoffMs(w);
    if (cutoff != null) retentionCutoffByWorkspace.set(w.id, cutoff);
  }

  const requestedWorkspaceId = sp.get("workspaceId") ?? undefined;
  if (requestedWorkspaceId) {
    const ws = await getWorkspace(requestedWorkspaceId);
    const isMember = ws ? !!getActiveMember(ws, user.id) : false;
    if (!isMember) {
      await tryRecordAudit(req, {
        action: "audit.read.denied",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: requestedWorkspaceId,
        target: { type: "audit_log", id: requestedWorkspaceId },
        status: "denied",
        meta: { reason: "not_a_member" },
      });
      return NextResponse.json(
        { error: "forbidden", message: "not a member of that workspace" },
        { status: 403 },
      );
    }
  }

  const entries = await listAudit({
    actorId: sp.get("actorId") ?? undefined,
    workspaceId: requestedWorkspaceId,
    allowedWorkspaceIds,
    selfActorId: user.id,
    retentionCutoffByWorkspace,
    action: sp.get("action") ?? undefined,
    targetType: sp.get("targetType") ?? undefined,
    targetId: sp.get("targetId") ?? undefined,
    requestId: sp.get("requestId") ?? undefined,
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
