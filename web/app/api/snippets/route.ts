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
} from "../../../lib/snippets";

export const dynamic = "force-dynamic";

async function currentUser(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  return currentUserFromCookieHeader(cookieHeader);
}

export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const language = url.searchParams.get("language") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const items = await listSnippets(user.id, { q, tag, language, limit, offset });
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
    });
    await tryRecordAudit(req, {
      action: "snippet.create",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "snippet", id: rec.id, label: rec.title },
      diff: { after: { title: rec.title, language: rec.language, tags: rec.tags } },
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
