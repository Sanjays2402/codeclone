/**
 * Workspace invite-domain allowlist policy.
 *
 * GET  /api/workspaces/:id/invite-domain-allowlist
 *   Members can read. Returns { domains, canEdit }.
 *
 * PUT  /api/workspaces/:id/invite-domain-allowlist
 *   Owner / editor (manage rights) only. Body: { domains: string[] }.
 *   Replaces the policy atomically. Returns the sanitised list plus any
 *   rejected raw inputs. Empty array disables enforcement. Every change
 *   is recorded in the audit log with before / after diff.
 *
 * Runtime enforcement happens in lib/workspaces.ts at:
 *   - issueInvite          (manual + API invites)
 *   - acceptInvite         (catches stale invites after policy tightens)
 *   - applyAutoJoinForUser (domain auto-join candidates)
 *   - lib/scim.ts createUser (SCIM provisioning from IdPs)
 *
 * Existing members are never evicted by a policy change; the allowlist
 * gates only NEW members joining the workspace.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  sanitizeInviteDomainAllowlist,
  setInviteDomainAllowlist,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/invite-domain-allowlist" },
  );
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    domains: Array.isArray(ws.inviteDomainAllowlist) ? ws.inviteDomainAllowlist : [],
    canEdit: canManage(ws, user.id),
  });
}

interface PutBody {
  domains?: unknown;
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/invite-domain-allowlist" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.invite_domain_allowlist_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PutBody = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { ok, rejected } = sanitizeInviteDomainAllowlist(body.domains);

  const before = Array.isArray(ws.inviteDomainAllowlist) ? ws.inviteDomainAllowlist.slice() : [];
  await setInviteDomainAllowlist(ws, ok);

  await tryRecordAudit(req, {
    action: "workspace.invite_domain_allowlist_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { domains: before }, after: { domains: ok } },
  });

  return NextResponse.json({ domains: ok, rejected });
}
