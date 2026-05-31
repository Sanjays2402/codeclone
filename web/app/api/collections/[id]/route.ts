import { NextResponse } from "next/server";
import {
  deleteCollection,
  expandCollection,
  updateCollection,
} from "../../../../lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await expandCollection(id);
  if (!rec) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(rec);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "request body must be an object." },
      { status: 400 },
    );
  }
  const input = body as { title?: unknown; description?: unknown };
  try {
    const rec = await updateCollection(id, {
      title: typeof input.title === "string" ? input.title : undefined,
      description:
        input.description === null
          ? null
          : typeof input.description === "string"
            ? input.description
            : undefined,
    });
    if (!rec) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(rec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to update";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await deleteCollection(id);
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
