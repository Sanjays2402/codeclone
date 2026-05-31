import { NextResponse } from "next/server";
import {
  createCollection,
  listCollections,
} from "../../../lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const page = await listCollections({
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
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
