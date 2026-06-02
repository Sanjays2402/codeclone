import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";
import { enforceMfaEnrollment } from "../../../lib/mfa-enforce";
import {
  enforceSession,
  tooManyRequestsResponse,
} from "../../../lib/session-rate-limit";
import {
  createSnippet,
  listSnippets,
  SnippetError,
  type SnippetRecord,
} from "../../../lib/snippets";

export const dynamic = "force-dynamic";

async function currentUser(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  return currentUserFromCookieHeader(cookieHeader);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function snippetsToCsv(rows: ReadonlyArray<SnippetRecord>): string {
  // Mirror the column order of /v1/snippets?format=csv so a dashboard
  // export and a programmatic export drop into the same template.
  const header = [
    "id",
    "title",
    "language",
    "classification",
    "tags",
    "bytes",
    "created_at",
    "updated_at",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.title),
        csvCell(r.language),
        csvCell(r.classification),
        csvCell((r.tags ?? []).join("|")),
        csvCell(Buffer.byteLength(r.body ?? "", "utf-8")),
        csvCell(new Date(r.createdAt).toISOString()),
        csvCell(new Date(r.updatedAt).toISOString()),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const language = url.searchParams.get("language") ?? undefined;
  const classification = url.searchParams.get("classification") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const items = await listSnippets(user.id, { q, tag, language, classification, limit, offset });
  void tryRecordAudit(req, {
    action: "snippets.read",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "snippet_inventory", id: user.id },
    status: "ok",
    meta: { count: items.length, format },
  });
  if (format === "csv") {
    const csv = snippetsToCsv(items);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-snippets.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ items, count: items.length });
}

export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mfaBlocked = await enforceMfaEnrollment(req, user, "snippet.create");
  if (mfaBlocked) return mfaBlocked;
  const limit = await enforceSession(req, user.id, "snippets-write");
  if (!limit.decision.allowed) {
    await tryRecordAudit(req, {
      action: "snippet.rate_limited",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "snippet" },
      meta: {
        bucket: limit.bucket,
        limit: limit.decision.limit,
        retry_after_seconds: limit.decision.retryAfter,
      },
    });
    return tooManyRequestsResponse(limit);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const rec = await createSnippet(user.id, {
      title: typeof b.title === "string" ? b.title : "",
      language: typeof b.language === "string" ? b.language : "",
      body: typeof b.body === "string" ? b.body : "",
      tags: Array.isArray(b.tags) ? (b.tags as unknown[]) as string[] : [],
      classification:
        typeof b.classification === "string" ? b.classification : undefined,
    });
    await tryRecordAudit(req, {
      action: "snippet.create",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "snippet", id: rec.id, label: rec.title },
      diff: {
        after: {
          title: rec.title,
          language: rec.language,
          tags: rec.tags,
          classification: rec.classification,
        },
      },
    });
    return NextResponse.json({ snippet: rec }, { status: 201, headers: limit.headers });
  } catch (err) {
    if (err instanceof SnippetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

// Silence unused import warning when cookies() helper is added later.
void cookies;
