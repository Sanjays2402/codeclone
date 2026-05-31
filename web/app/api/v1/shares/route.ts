/**
 * Public /v1/shares list endpoint.
 *
 * Authenticated via Bearer token (or x-api-key header). Requires the
 * `shares:read` scope. Returns a paginated list of saved comparison
 * summaries so customers can build dashboards or sync their history
 * into other systems.
 *
 * Query params:
 *   limit      1..100 (default 25)
 *   offset     >= 0   (default 0)
 *   q          free text search over title/tags/snippet
 *   tag        filter by exact tag
 *   language   filter by language id
 *   label      clone label (e.g. "near-duplicate")
 *   minScore   0..1
 *   maxScore   0..1
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { listSharesPage } from "../../../../lib/share";
import { logUsage } from "../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function parseScore(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }
  if (!hasScope(key, "shares:read")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message:
            "This key is missing the 'shares:read' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "shares:read",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const url = new URL(req.url);
  const sp = url.searchParams;
  const limitParam = sp.get("limit");
  const offsetParam = sp.get("offset");
  let limit = 25;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0 && n <= 100) limit = n;
  }
  let offset = 0;
  if (offsetParam) {
    const n = Number.parseInt(offsetParam, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) offset = n;
  }

  try {
    const page = await listSharesPage({
      limit,
      offset,
      q: sp.get("q") ?? undefined,
      tag: sp.get("tag") ?? undefined,
      language: sp.get("language") ?? undefined,
      cloneLabel: sp.get("label") ?? undefined,
      minScore: parseScore(sp.get("minScore")),
      maxScore: parseScore(sp.get("maxScore")),
    });

    void recordUse(key.id);
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/shares",
      bytes: 0,
      latencyMs: 0,
    });

    return NextResponse.json({
      items: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      next_offset:
        page.offset + page.items.length < page.total
          ? page.offset + page.items.length
          : null,
    }, { headers: rl.headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "internal_error", message: msg } },
      { status: 500 },
    );
  }
}
