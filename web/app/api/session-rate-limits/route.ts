/**
 * Introspect the per-user session rate limits in effect for the current
 * deployment. Used by Settings -> Security so customers can see what
 * ceiling applies to browser-driven compares and writes before they
 * hit it in production.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { bucketLimit, type SessionBucket } from "../../../lib/session-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKETS: { key: SessionBucket; label: string; description: string }[] = [
  {
    key: "compare",
    label: "Compare requests",
    description: "POST /api/compare from the web UI",
  },
  {
    key: "snippets-write",
    label: "Snippet writes",
    description: "POST /api/snippets from the web UI",
  },
  {
    key: "default",
    label: "Default session bucket",
    description: "Fallback for routes that opt in without a custom bucket",
  },
];

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const buckets = BUCKETS.map((b) => ({
    bucket: b.key,
    label: b.label,
    description: b.description,
    limit_rpm: bucketLimit(b.key),
    window_seconds: 60,
  }));
  return NextResponse.json({ buckets });
}
