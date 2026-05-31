import { NextResponse } from "next/server";
import { currentUserFromCookieHeader, normalizeEmail } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  canInvite,
  issueInvite,
  listInvitesForWorkspace,
  publicInvite,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/invites" });
  if (__ipBlock) return __ipBlock;
  if (!canInvite(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const items = (await listInvitesForWorkspace(id)).map(publicInvite);
  return NextResponse.json({ items });
}

interface CreateInviteBody {
  email?: unknown;
  role?: unknown;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/invites" });
  if (__ipBlock) return __ipBlock;
  if (!canInvite(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.invite_create",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: CreateInviteBody = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const role = body.role === "editor" || body.role === "viewer" ? body.role : "viewer";

  const origin = new URL(req.url).origin;
  try {
    const issued = await issueInvite({
      workspace: ws,
      email,
      role,
      invitedBy: user.id,
      origin,
    });
    await tryRecordAudit(req, {
      action: "workspace.invite_create",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_invite", id: issued.record.id, label: email },
      diff: { after: { email, role } },
    });
    return NextResponse.json(
      {
        invite: publicInvite(issued.record),
        url: issued.url,
        token: issued.token,
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "invite_domain_not_allowed") {
      await tryRecordAudit(req, {
        action: "workspace.invite_create",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace", id: ws.id, label: ws.name },
        status: "denied",
        diff: { after: { email, role, reason: "invite_domain_not_allowed" } },
      });
      return NextResponse.json(
        {
          error: "invite_domain_not_allowed",
          message:
            "This workspace restricts member email domains. The invitee's domain is not on the allowlist.",
        },
        { status: 403 },
      );
    }
    const status = msg === "already_member" || msg === "invalid_role" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
