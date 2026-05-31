import { NextResponse } from "next/server";
import { loadEvalHealth } from "../../../lib/data";
import { instrument } from "../../../lib/instrument";

export const dynamic = "force-dynamic";

export const GET = instrument("/api/health", async () => {
  const base = process.env.CODECLONE_SERVE_URL || "http://127.0.0.1:7461";
  const health = await loadEvalHealth();
  let serve: { status: string; model?: string } = { status: "down" };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch(`${base}/healthz`, { signal: ac.signal, cache: "no-store" });
    clearTimeout(t);
    if (r.ok) serve = await r.json();
  } catch {}
  return NextResponse.json({ ...health, serve });
});
