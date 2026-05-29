import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.CODECLONE_SERVE_URL || "http://127.0.0.1:7461";
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${base}/healthz`, { signal: ac.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok) {
      return NextResponse.json({ status: "down", base }, { status: 200 });
    }
    const body = await r.json();
    return NextResponse.json({ status: "ok", base, ...body });
  } catch (e) {
    return NextResponse.json(
      { status: "down", base, error: String(e instanceof Error ? e.message : e) },
      { status: 200 }
    );
  }
}
