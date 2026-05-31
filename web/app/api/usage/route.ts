import { NextResponse } from "next/server";
import { summarize } from "../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("days");
  let windowDays = 30;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 90) windowDays = Math.floor(n);
  }
  try {
    const data = await summarize(windowDays);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal_error",
          message: err instanceof Error ? err.message : "Failed to load usage.",
        },
      },
      { status: 500 },
    );
  }
}
