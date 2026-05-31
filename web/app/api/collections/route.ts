import { NextResponse } from "next/server";
import {
  createCollection,
  listCollections,
  parseSortKey,
  parseSortDir,
} from "../../../lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const q = url.searchParams.get("q") ?? "";
  const sort = parseSortKey(url.searchParams.get("sort"));
  const dir = parseSortDir(url.searchParams.get("dir"));
  const page = await listCollections({
    limit: Number.isFinite(limit) ? limit : 20,
    offset: Number.isFinite(offset) ? offset : 0,
    q,
    sort,
    dir,
  });
  return NextResponse.json(page);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "request body must be an object." },
      { status: 400 },
    );
  }
  const input = body as {
    title?: unknown;
    description?: unknown;
    shareIds?: unknown;
  };
  try {
    const rec = await createCollection({
      title: input.title as string,
      description:
        typeof input.description === "string" ? input.description : undefined,
      shareIds: Array.isArray(input.shareIds)
        ? (input.shareIds as string[])
        : undefined,
    });
    return NextResponse.json(rec, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to create";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
