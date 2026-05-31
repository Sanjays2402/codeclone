/**
 * JSON snapshot of in-process metrics for the /status UI. Same numbers as
 * /api/metrics but in a shape that's friendly to render.
 */
import { NextResponse } from "next/server";
import { instrument } from "../../../../lib/instrument";
import { snapshot } from "../../../../lib/observability";

export const dynamic = "force-dynamic";

export const GET = instrument("/api/observability/snapshot", async () => {
  return NextResponse.json(snapshot(), { headers: { "cache-control": "no-store" } });
});
