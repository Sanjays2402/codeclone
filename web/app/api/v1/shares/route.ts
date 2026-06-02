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
 *   format     'json' (default) or 'csv'. CSV returns an RFC 4180
 *              attachment so a compliance reviewer can open the saved
 *              share inventory in Excel/csvkit without writing a
 *              JSON-to-CSV step.
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
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../lib/dpa-enforce";
import { createShare, listSharesPage, MAX_SNIPPET_BYTES } from "../../../../lib/share";
import { compareCode, alignLines, classifyClone } from "../../../../lib/similarity";
import { logUsage } from "../../../../lib/usage";
import { tryRecordAudit } from "../../../../lib/audit";
import { isDryRun, DRY_RUN_HEADER } from "../../../../lib/dry-run";

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
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/shares" });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const url = new URL(req.url);
  const sp = url.searchParams;
  const formatRaw = sp.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Invalid 'format' value. Use 'json' (default) or 'csv'.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }
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
      // Tenant-scope to the calling key's workspace. Keys with no
      // workspace binding (legacy single-tenant installs) see only
      // legacy unscoped shares so they cannot enumerate any tenant.
      workspaceId: key.workspaceId ?? null,
      allowLegacy: !key.workspaceId,
    });

    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/shares",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });

    if (format === "csv") {
      const filenameWs = key.workspaceId ?? "legacy";
      const csv = sharesToCsv(page.items);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          ...rl.headers,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="codeclone-${filenameWs}-shares.csv"`,
        },
      });
    }

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

/**
 * POST /v1/shares
 *
 * Programmatically create a saved comparison ("share") from CI, an
 * SDK, or any backend pipeline, without going through the /compare
 * UI. The server recomputes scores/alignment/clone classification so
 * the resulting public /r/<id> link can never lie about what the
 * snippets actually compare to.
 *
 * Auth: Bearer token or x-api-key. Required scope: shares:write.
 * Tenant scope: the new record is stamped with the calling key's
 *   workspaceId. Keys with no workspace binding are rejected here,
 *   matching every other mutating /v1 write: cross-tenant or
 *   "global" saved shares are not a real product.
 *
 * Body (application/json):
 *   a        string, required, non-empty, <= MAX_SNIPPET_BYTES utf-8 bytes
 *   b        string, required, non-empty, <= MAX_SNIPPET_BYTES utf-8 bytes
 *   language string, optional, defaults to "auto"
 *   title    string, optional
 *   tags     string[], optional
 *
 * Honors x-codeclone-dry-run (or ?dry_run=true): returns the would-be
 * scores and a preview response with x-codeclone-dry-run: true, and
 * does NOT write a share, does NOT log usage, does NOT emit an audit
 * row. Rate-limit + tenant gates still run so dry-run can't be used
 * to bypass enforcement.
 *
 * Side effects on a real call: bills one /v1 rate-limit slot,
 * records one audit row (v1.shares.create), and logs usage so the
 * call shows up in /usage and /v1/usage. Plan quota is NOT charged:
 * saving an already-computed share is housekeeping, not a billable
 * model call (the underlying /v1/compare call already billed it).
 */
export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }
  if (!hasScope(key, "shares:write")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message:
            "This key is missing the 'shares:write' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "shares:write",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }
  if (!key.workspaceId) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message:
            "This API key is not bound to a workspace. /v1/shares POST requires a workspace-scoped key so the new share has a tenant owner.",
        },
      },
      { status: 400 },
    );
  }

  // Full enforcement chain matches every other mutating /v1 route.
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/shares" });
  if (lockdownBlocked) return lockdownBlocked;
  const wsIpBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsIpBlocked) return wsIpBlocked;
  const keyIpBlocked = await enforceKeyAllowlist(req, key);
  if (keyIpBlocked) return keyIpBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;
  const dpaBlocked = await enforceWorkspaceDpaForKey(req, key, { route: "/v1/shares" });
  if (dpaBlocked) return dpaBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Body must be JSON." } },
      { status: 400, headers: rl.headers },
    );
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const a = typeof body.a === "string" ? body.a : "";
  const b = typeof body.b === "string" ? body.b : "";
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim()
      : "auto";
  const title = typeof body.title === "string" ? body.title : undefined;
  const tags = Array.isArray(body.tags)
    ? (body.tags as unknown[]).filter((t) => typeof t === "string") as string[]
    : undefined;

  if (!a.trim() || !b.trim()) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Both 'a' and 'b' must be non-empty strings.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }
  if (
    Buffer.byteLength(a, "utf-8") > MAX_SNIPPET_BYTES ||
    Buffer.byteLength(b, "utf-8") > MAX_SNIPPET_BYTES
  ) {
    return NextResponse.json(
      {
        error: {
          type: "payload_too_large",
          message: `Each snippet must be at most ${MAX_SNIPPET_BYTES} bytes.`,
        },
      },
      { status: 413, headers: rl.headers },
    );
  }

  // Recompute server-side so the share link cannot lie about scores.
  const started = performance.now();
  const scores = compareCode(a, b);
  const alignment = alignLines(a, b);
  const clone = classifyClone(a, b, scores);
  const latencyMs = performance.now() - started;
  const result = {
    language,
    scores,
    alignment,
    clone,
    bytes: {
      a: Buffer.byteLength(a, "utf-8"),
      b: Buffer.byteLength(b, "utf-8"),
    },
    latency_ms: Number(latencyMs.toFixed(3)),
    method:
      "exact-jaccard+5gram-shingles+line-align+structural-4gram-clone-type",
  };

  // Dry-run: preview only. No write, no audit, no usage.
  if (isDryRun(req, body)) {
    return NextResponse.json(
      {
        dry_run: true,
        would_create: {
          language,
          title: title ?? null,
          tags: tags ?? null,
          workspace_id: key.workspaceId,
          scores,
          clone,
          bytes: result.bytes,
        },
      },
      {
        status: 200,
        headers: { ...rl.headers, ...DRY_RUN_HEADER },
      },
    );
  }

  try {
    const rec = await createShare({
      a,
      b,
      language,
      title,
      tags,
      workspaceId: key.workspaceId,
      result,
    });

    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.shares.create",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "share", id: rec.id, label: rec.title ?? undefined },
      status: "ok",
      meta: {
        prefix: key.prefix,
        language,
        score: scores.shingleJaccard,
        clone_label: clone.label,
        bytes: result.bytes,
        tags: rec.tags ?? null,
      },
    });
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/shares",
      bytes: result.bytes.a + result.bytes.b,
      latencyMs: Number(latencyMs.toFixed(3)),
      workspaceId: key.workspaceId,
    });

    return NextResponse.json(
      {
        id: rec.id,
        url: `/r/${rec.id}`,
        language: rec.language,
        title: rec.title ?? null,
        tags: rec.tags ?? null,
        workspace_id: rec.workspaceId,
        scores,
        clone,
        bytes: result.bytes,
        created_at: rec.createdAt,
      },
      { status: 201, headers: rl.headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void tryRecordAudit(req, {
      action: "v1.shares.create",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "api_key", id: key.id, label: key.label },
      status: "denied",
      meta: { prefix: key.prefix, reason: msg },
    });
    return NextResponse.json(
      { error: { type: "internal_error", message: msg } },
      { status: 500, headers: rl.headers },
    );
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

type ShareCsvRow = {
  id: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  tags?: string[];
  bytes: { a: number; b: number };
  workspaceId: string | null;
};

function sharesToCsv(rows: ReadonlyArray<ShareCsvRow>): string {
  const header = [
    "id",
    "workspace_id",
    "language",
    "clone_label",
    "shingle_jaccard",
    "bytes_a",
    "bytes_b",
    "title",
    "tags",
    "created_at",
    "updated_at",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.workspaceId),
        csvCell(r.language),
        csvCell(r.cloneLabel),
        csvCell(r.shingleJaccard),
        csvCell(r.bytes?.a),
        csvCell(r.bytes?.b),
        csvCell(r.title),
        csvCell((r.tags ?? []).join("|")),
        csvCell(r.createdAt),
        csvCell(r.updatedAt),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
