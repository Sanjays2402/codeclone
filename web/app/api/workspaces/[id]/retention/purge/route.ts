/**
 * Workspace audit retention purge preview.
 *
 * POST /api/workspaces/:id/retention/purge
 *
 * Returns a dry-run report of how many audit entries for this workspace
 * fall outside the current retention window. Useful for compliance
 * reviewers and owners who want to see the access-layer hide blast
 * radius before changing the policy.
 *
 * Body (optional):
 *   { auditDays?: number }   override the policy for this preview only.
 *                            When omitted the workspace's current policy
 *                            is used.
 *
 * Note on physical deletion: the underlying audit log is a sha256
 * hash-chained JSONL file (see lib/audit#verifyAuditChain). Physically
 * rewriting it would break the chain and invalidate the tamper-evident
 * guarantee that SOC2 reviewers depend on. Retention is enforced at the
 * read layer in lib/audit#listAudit instead, which both satisfies GDPR
 * data minimisation for the workspace owner and keeps the chain
 * verifiable end to end. This endpoint reports the access-layer effect.
 *
 * Owner only. The preview itself is recorded in the audit log.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../lib/auth";
import { previewWorkspaceRetention, tryRecordAudit } from "../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  canManage,
  sanitizeRetention,
  retentionCutoffMs,
} from "../../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/retention/purge" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.retention_purge_preview",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  // Determine the cutoff. If the body supplies a valid override, prefer
  // it; otherwise fall back to the workspace's saved policy. If neither
  // exists, return a no-op report.
  let cutoff = retentionCutoffMs(ws);
  const override = sanitizeRetention(body);
  if (override && override.auditDays > 0) {
    cutoff = Date.now() - override.auditDays * 86400 * 1000;
  } else if (override && override.auditDays === 0) {
    cutoff = null;
  }

  if (cutoff == null) {
    await tryRecordAudit(req, {
      action: "workspace.retention_purge_preview",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      meta: { affectedEntries: 0, reason: "no_policy" },
    });
    return NextResponse.json({
      dryRun: true,
      cutoffMs: null,
      affectedEntries: 0,
      affectedFiles: [],
      scannedFiles: 0,
      scannedEntries: 0,
      oldestAffectedTs: null,
      newestAffectedTs: null,
      note: "no retention policy set; nothing would be hidden",
    });
  }

  const preview = await previewWorkspaceRetention(ws.id, cutoff);

  await tryRecordAudit(req, {
    action: "workspace.retention_purge_preview",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    meta: {
      affectedEntries: preview.affectedEntries,
      cutoffMs: cutoff,
      override: override?.auditDays ?? null,
    },
  });

  return NextResponse.json({
    dryRun: true,
    cutoffMs: cutoff,
    affectedEntries: preview.affectedEntries,
    affectedFiles: preview.affectedFiles,
    scannedFiles: preview.scannedFiles,
    scannedEntries: preview.scannedEntries,
    oldestAffectedTs: preview.oldestAffectedTs,
    newestAffectedTs: preview.newestAffectedTs,
    note:
      "Entries are hidden from every read path (listAudit, CSV export, the /audit UI). " +
      "The underlying JSONL files are not modified so the tamper-evident hash chain stays verifiable.",
  });
}
