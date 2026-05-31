import { NextResponse } from "next/server";
import { deleteKey, loadKey, revokeKey } from "../../../../lib/api-keys";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage API keys." } },
    { status: 401 },
  );
}

function notFound() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const rec = await loadKey(id);
  if (!rec) return notFound();
  if (rec.userId && rec.userId !== user.id) return notFound();
  const { hash: _hash, ...safe } = rec;
  return NextResponse.json(safe);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const ok = await revokeKey(id, user.id);
  if (!ok) return notFound();
  await tryRecordAudit(req, {
    action: "api_key.revoke",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "api_key", id },
  });
  return NextResponse.json({ id, revoked: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const ok = await deleteKey(id, user.id);
  if (!ok) return notFound();
  await tryRecordAudit(req, {
    action: "api_key.delete",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "api_key", id },
  });
  return NextResponse.json({ id, deleted: true });
}
