import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";
import {
  createWorkspace,
  listWorkspacesForUser,
  normalizeName,
  type WorkspaceRecord,
} from "../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function workspacesToCsv(
  userId: string,
  rows: ReadonlyArray<WorkspaceRecord>,
): string {
  const header = [
    "id",
    "name",
    "slug",
    "my_role",
    "member_count",
    "created_at",
  ];
  const lines: string[] = [header.join(",")];
  for (const w of rows) {
    const myRole = w.members.find((m) => m.userId === userId)?.role ?? "";
    lines.push(
      [
        csvCell(w.id),
        csvCell(w.name),
        csvCell(w.slug),
        csvCell(myRole),
        csvCell(w.members.length),
        csvCell(new Date(w.createdAt).toISOString()),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
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
  const items = await listWorkspacesForUser(user.id);
  if (format === "csv") {
    void tryRecordAudit(req, {
      action: "workspaces.read",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "workspace_inventory" },
      status: "ok",
      meta: { count: items.length, format },
    });
    const csv = workspacesToCsv(user.id, items);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-workspaces.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({
    items: items.map((w: WorkspaceRecord) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      createdAt: w.createdAt,
      memberCount: w.members.length,
      myRole: w.members.find((m) => m.userId === user.id)?.role ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  let body: { name?: unknown } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const name = normalizeName(body.name);
  if (!name) {
    return NextResponse.json(
      { error: "invalid_name", message: "Name must be 1-64 chars and start with a letter or number." },
      { status: 400 },
    );
  }
  try {
    const ws = await createWorkspace({ name, ownerId: user.id, ownerEmail: user.email });
    await tryRecordAudit(req, {
      action: "workspace.create",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { name: ws.name, slug: ws.slug } },
    });
    return NextResponse.json({ workspace: ws }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
