/**
 * Workspace webhook destination domain allowlist management.
 *
 * GET  /api/workspaces/:id/webhook-domains
 *   Returns { entries: string[], canEdit: boolean }.
 *   Any workspace member can read. Surfaces the current rules to the UI.
 *
 * PUT  /api/workspaces/:id/webhook-domains
 *   Body: { entries: string[] }
 *   Owner / editor (manage rights) only. Replaces the entire allowlist
 *   atomically. Returns the sanitised list plus any rejected raw inputs.
 *   Empty array disables enforcement.
 *
 * Every change is recorded in the audit log with before/after diffs.
 * Enforced at webhook create time (lib/webhooks.ts: createWebhook) AND
 * at delivery time (lib/webhooks.ts: deliverOnce) so a policy that
 * tightens after a webhook was registered immediately blocks delivery to
 * a now-disallowed host.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setWebhookDomainAllowlist,
} from "../../../../../lib/workspaces";
import { sanitizeWebhookDomainList } from "../../../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!getActiveMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({
    entries: Array.isArray(ws.webhookDomainAllowlist) ? ws.webhookDomainAllowlist : [],
    canEdit: canManage(ws, user.id),
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.webhook_domains_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { entries?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body => clear */ }
  const { ok, rejected } = sanitizeWebhookDomainList(body.entries ?? []);
  const before = Array.isArray(ws.webhookDomainAllowlist) ? ws.webhookDomainAllowlist.slice() : [];
  await setWebhookDomainAllowlist(ws, ok);
  await tryRecordAudit(req, {
    action: "workspace.webhook_domains_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { webhookDomainAllowlist: before }, after: { webhookDomainAllowlist: ok } },
    meta: rejected.length ? { rejected } : null,
  });
  return NextResponse.json({ entries: ok, rejected });
}
