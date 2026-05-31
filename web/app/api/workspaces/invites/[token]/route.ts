import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { acceptInvite, lookupInvite } from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET previews the invite (does not consume). Used by the public accept page.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const looked = await lookupInvite(token);
  if (!looked) return NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  return NextResponse.json({
    workspace: { id: looked.workspace.id, name: looked.workspace.name },
    invite: {
      email: looked.invite.email,
      role: looked.invite.role,
      expiresAt: looked.invite.expiresAt,
    },
    viewer: user ? { id: user.id, email: user.email } : null,
    emailMatches: user ? user.email === looked.invite.email : null,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await acceptInvite({ token, userId: user.id, userEmail: user.email });
  if (!ws) return NextResponse.json({ error: "invalid_or_email_mismatch" }, { status: 400 });
  return NextResponse.json({ workspaceId: ws.id });
}
