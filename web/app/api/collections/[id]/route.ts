import { NextResponse } from "next/server";
import {
  deleteCollection,
  expandCollection,
  updateCollection,
  type ExpandedCollectionItem,
} from "../../../../lib/collections";
import { tryRecordAudit } from "../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function itemsToCsv(
  collectionId: string,
  rows: ReadonlyArray<ExpandedCollectionItem>,
): string {
  // Mirror the column order of /v1/collections/:id/items?format=csv so the
  // public dashboard CSV and the programmatic export drop into the same
  // spreadsheet template. The public /c/<id> page has no workspace context
  // (anyone with the link can fetch it), so workspace_id is left blank but
  // its slot is preserved so the two CSVs share a header row.
  const header = [
    "collection_id",
    "workspace_id",
    "share_id",
    "title",
    "language",
    "clone_label",
    "shingle_jaccard",
    "bytes_a",
    "bytes_b",
    "created_at",
    "missing",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(collectionId),
        csvCell(""),
        csvCell(r.id),
        csvCell(r.title ?? ""),
        csvCell(r.language),
        csvCell(r.cloneLabel),
        csvCell(r.shingleJaccard),
        csvCell(r.bytes?.a ?? 0),
        csvCell(r.bytes?.b ?? 0),
        csvCell(r.createdAt ? new Date(r.createdAt).toISOString() : ""),
        csvCell(r.missing ? "true" : "false"),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
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
  const rec = await expandCollection(id);
  if (!rec) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (format === "csv") {
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    void tryRecordAudit(req, {
      action: "collection.read",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "collection", id },
      status: "ok",
      meta: { count: rec.items.length, format },
    });
    const csv = itemsToCsv(id, rec.items);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-collection-${id}-items.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json(rec);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
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
  const input = body as { title?: unknown; description?: unknown };
  try {
    const rec = await updateCollection(id, {
      title: typeof input.title === "string" ? input.title : undefined,
      description:
        input.description === null
          ? null
          : typeof input.description === "string"
            ? input.description
            : undefined,
    });
    if (!rec) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    await tryRecordAudit(req, {
      action: "collection.update",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "collection", id },
      diff: { after: { title: (rec as { title?: string }).title } },
    });
    return NextResponse.json(rec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to update";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await deleteCollection(id);
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  await tryRecordAudit(req, {
    action: "collection.delete",
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    target: { type: "collection", id },
  });
  return NextResponse.json({ ok: true });
}
