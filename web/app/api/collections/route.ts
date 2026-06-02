import { NextResponse } from "next/server";
import {
  createCollection,
  listCollections,
  parseSortKey,
  parseSortDir,
  type CollectionSummary,
} from "../../../lib/collections";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function collectionsToCsv(rows: ReadonlyArray<CollectionSummary>): string {
  // Mirror the column order of /v1/collections?format=csv so the
  // dashboard and the programmatic export drop into the same
  // spreadsheet template. The dashboard export is unscoped (cookie
  // auth, no workspace binding) so workspace_id is left blank, but
  // its slot is preserved so /v1 and /api CSVs share a header row.
  const header = [
    "id",
    "workspace_id",
    "title",
    "description",
    "item_count",
    "created_at",
    "updated_at",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(""),
        csvCell(r.title),
        csvCell(r.description ?? ""),
        csvCell(r.count),
        csvCell(new Date(r.createdAt).toISOString()),
        csvCell(new Date(r.updatedAt).toISOString()),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "format must be 'json' (default) or 'csv'.",
        },
      },
      { status: 400 },
    );
  }

  const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const q = url.searchParams.get("q") ?? "";
  const sort = parseSortKey(url.searchParams.get("sort"));
  const dir = parseSortDir(url.searchParams.get("dir"));

  if (format === "csv") {
    // Pull a full export (capped at the listCollections hard ceiling)
    // so the CSV is a real spreadsheet of the user's library, not a
    // single dashboard page.
    const all = await listCollections({
      limit: 100,
      offset: 0,
      q,
      sort,
      dir,
    });
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    void tryRecordAudit(req, {
      action: "collections.read",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "collection_inventory" },
      status: "ok",
      meta: { count: all.items.length, format },
    });
    const csv = collectionsToCsv(all.items);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-collections.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

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
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    await tryRecordAudit(req, {
      action: "collection.create",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "collection", id: (rec as { id?: string }).id, label: (rec as { title?: string }).title },
      diff: { after: { title: (rec as { title?: string }).title } },
    });
    return NextResponse.json(rec, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to create";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
