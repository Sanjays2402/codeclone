import { NextResponse } from "next/server";
import { addItem, removeItem } from "../../../../../lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
  const shareId =
    body && typeof body === "object" && "shareId" in body
      ? (body as { shareId?: unknown }).shareId
      : undefined;
  if (typeof shareId !== "string") {
    return NextResponse.json(
      { error: "shareId must be a string." },
      { status: 400 },
    );
  }
  try {
    const rec = await addItem(id, shareId);
    if (!rec) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(rec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to add";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const shareId = url.searchParams.get("shareId");
  if (!shareId) {
    return NextResponse.json(
      { error: "shareId query param required." },
      { status: 400 },
    );
  }
  const rec = await removeItem(id, shareId);
  if (!rec) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(rec);
}
