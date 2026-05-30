import { NextResponse } from "next/server";
import { loadRun } from "../../../../lib/data";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await loadRun(runId);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(run);
}
