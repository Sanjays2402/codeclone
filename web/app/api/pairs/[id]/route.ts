import { NextResponse } from "next/server";
import { loadPair } from "../../../../lib/data";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pair = await loadPair(id);
  if (!pair) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(pair);
}
