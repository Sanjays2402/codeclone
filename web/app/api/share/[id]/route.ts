import { NextResponse } from "next/server";
import { loadShare, updateShare, deleteShare } from "../../../../lib/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await loadShare(id);
  if (!rec) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  return NextResponse.json(rec);
}

interface PatchBody {
  title?: unknown;
  tags?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const patch: { title?: string | null; tags?: string[] | null } = {};
  if ("title" in body) {
    if (body.title === null) patch.title = null;
    else if (typeof body.title === "string") patch.title = body.title;
    else return NextResponse.json({ error: "title must be a string or null." }, { status: 400 });
  }
  if ("tags" in body) {
    if (body.tags === null) patch.tags = null;
    else if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t) => typeof t === "string") as string[];
    else return NextResponse.json({ error: "tags must be an array of strings or null." }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Provide title or tags to update." }, { status: 400 });
  }
  try {
    const rec = await updateShare(id, patch);
    if (!rec) {
      return NextResponse.json({ error: "Share not found." }, { status: 404 });
    }
    return NextResponse.json(rec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await deleteShare(id);
  if (!ok) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
