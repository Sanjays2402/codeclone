import { NextResponse } from "next/server";
import { loadShare } from "../../../../lib/share";

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
