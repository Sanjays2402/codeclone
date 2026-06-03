import { NextResponse } from "next/server";
import { loadRun } from "../../../../lib/data";

export const dynamic = "force-dynamic";

// Return the full run record (metrics, params, eval report) as JSON so the
// /eval/[runId] page can wire a one-click "Download JSON" against an actual
// endpoint instead of stringifying on the client. Matches the shape of
// /api/pairs/[id]: 200 with the raw record, 404 with an error envelope.
export async function GET(
  _: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const run = await loadRun(decodeURIComponent(runId));
  if (!run) {
    return NextResponse.json(
      {
        error: {
          type: "not_found",
          message: `run '${runId}' not found.`,
        },
      },
      { status: 404 },
    );
  }
  return NextResponse.json(run);
}
