import { NextResponse } from "next/server";
import { recentEvents } from "../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const rawDays = url.searchParams.get("days");

  let limit = 50;
  if (rawLimit) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "limit must be 1..500." } },
        { status: 400 },
      );
    }
    limit = Math.floor(n);
  }

  let days = 7;
  if (rawDays) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "days must be 1..90." } },
        { status: 400 },
      );
    }
    days = Math.floor(n);
  }

  try {
    const events = await recentEvents(limit, days);
    return NextResponse.json(
      { events, limit, windowDays: days },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal_error",
          message:
            err instanceof Error ? err.message : "Failed to load recent calls.",
        },
      },
      { status: 500 },
    );
  }
}
