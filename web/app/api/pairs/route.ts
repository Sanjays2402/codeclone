import { NextResponse } from "next/server";
import { loadPairsList } from "../../../lib/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const q = url.searchParams.get("q") ?? undefined;
  const lang = url.searchParams.get("lang") ?? undefined;
  const data = await loadPairsList({ limit, offset, q, lang });
  return NextResponse.json(data);
}
