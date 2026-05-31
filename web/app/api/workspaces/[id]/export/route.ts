/**
 * GDPR/DPA: workspace data export.
 *
 *   GET /api/workspaces/:id/export[?format=json|csv]
 *
 * Returns every record bound to the workspace as a single downloadable
 * bundle. Owner role is required. Every request is audited.
 *
 * - format=json (default) returns the full JSON bundle.
 * - format=csv returns a ZIP-free flat CSV of the audit log (the most
 *   common SOC2/DPA artifact request); the JSON bundle still has the rest.
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { toCsv } from "../../../../../lib/audit";
import {
  getWorkspace,
  getActiveMember,
  exportWorkspace,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    await tryRecordAudit(req, {
      action: "workspace.export",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const bundle = await exportWorkspace(ws);
  const stamp = new Date(bundle.exportedAt).toISOString().replace(/[:.]/g, "-");

  await tryRecordAudit(req, {
    action: "workspace.export",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    meta: {
      format,
      counts: {
        invites: bundle.invites.length,
        apiKeys: bundle.apiKeys.length,
        audit: bundle.audit.length,
      },
    },
  });

  if (format === "csv") {
    // Audit log CSV is the most-requested artifact for DPA reviews; the
    // JSON bundle still carries members/invites/keys.
    const csv = toCsv(bundle.audit as unknown as Parameters<typeof toCsv>[0]);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-workspace-${ws.slug}-audit-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const body = JSON.stringify(bundle, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="codeclone-workspace-${ws.slug}-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
