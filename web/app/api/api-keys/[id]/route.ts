import { NextResponse } from "next/server";
import { deleteKey, loadKey, revokeKey } from "../../../../lib/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await loadKey(id);
  if (!rec) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Never echo the hash to clients.
  const { hash: _hash, ...safe } = rec;
  return NextResponse.json(safe);
}

export async function PATCH(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await revokeKey(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ id, revoked: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ id, deleted: true });
}
