/**
 * PATCH  /api/notifications/<id>  body { read: boolean } toggle read state
 * DELETE /api/notifications/<id>  remove a single notification
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { deleteNotification, isNotificationId, markRead } from "../../../../lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  read?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!isNotificationId(id)) {
    return NextResponse.json({ error: "Invalid notification id." }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const read = body.read === true;
  try {
    const rec = await markRead(user.id, id, read);
    if (!rec) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ item: rec });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!isNotificationId(id)) {
    return NextResponse.json({ error: "Invalid notification id." }, { status: 400 });
  }
  try {
    const ok = await deleteNotification(user.id, id);
    if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
