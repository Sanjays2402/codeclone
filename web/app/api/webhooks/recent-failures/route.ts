import { NextRequest, NextResponse } from "next/server";
import { collectRecentFailures } from "../../../../lib/recent-failures";

export const dynamic = "force-dynamic";

/**
 * Lightweight aggregation endpoint used by the in-app toaster.
 *
 * Returns the most recent failed webhook delivery attempts across all
 * webhooks, newest first. A delivery counts as "failed" when status >= 400
 * or status === 0 (network error).
 *
 * Query params:
 *   limit  optional integer, 1..100, default 25
 *   since  optional ms epoch; only return failures attempted at or after this
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const sinceRaw = url.searchParams.get("since");
  const limit = limitRaw === null ? undefined : parseInt(limitRaw, 10);
  const since = sinceRaw === null ? undefined : parseInt(sinceRaw, 10);
  const items = await collectRecentFailures({ limit, since });
  return NextResponse.json({ items });
}
