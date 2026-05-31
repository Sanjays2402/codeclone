import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../lib/auth";
import { getWorkspace, canInvite, revokeInvite } from "../../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; inviteId: string }> },
) {
  const { id, inviteId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canInvite(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ok = await revokeInvite(inviteId);
  if (!ok) return NextResponse.json({ error: "not_found_or_consumed" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
