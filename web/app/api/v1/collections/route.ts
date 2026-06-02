/**
 * Public /v1/collections: programmatic share-collection management.
 *
 * Collections group public /r/<id> shares into a single /c/<id> URL.
 * Customers wiring CodeClone into release engineering pipelines want
 * to assemble these from CI ("here is every near-duplicate we flagged
 * in this sprint, in one link") rather than clicking through the
 * dashboard. This route exposes list/create over the same store the
 * /collections UI uses.
 *
 * Auth: Bearer token or `x-api-key`, identical to the rest of /v1.
 * Scopes:
 *   GET  -> collections:read
 *   POST -> collections:write
 * Tenant scope: every operation is hard-bound to `key.workspaceId`.
 *   A key minted in workspace A can never read, create, mutate, or
 *   enumerate workspace B's collections, even though both live on
 *   the same underlying store. Keys with no workspace binding are
 *   rejected: collections are per-workspace by design and a global
 *   listing across tenants is not a real product.
 * Side effects: bills one /v1 rate-limit slot per call, records one
 *   audit row (`v1.collections.list` / `v1.collections.create`), and
 *   logs usage so the call shows up in /usage and /v1/usage. Plan
 *   quota is not charged: collection housekeeping is not a billable
 *   model call.
 *
 * Standard enforcement chain (lockdown, workspace + key IP allowlists,
 * residency, workspace API key policy, DPA) runs before any side
 * effect, matching every other /v1 route.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../lib/dpa-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { logUsage } from "../../../../lib/usage";
import {
  createCollection,
  listCollections,
  parseSortKey,
  parseSortDir,
} from "../../../../lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function missingScope(scope: string, key: { scopes?: string[] | null }) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${scope}' scope. Rotate it with the scope enabled or issue a new key.`,
        required_scope: scope,
        granted_scopes: key.scopes ?? null,
      },
    },
    { status: 403 },
  );
}

function notBoundToWorkspace() {
  return NextResponse.json(
    {
      error: {
        type: "invalid_request",
        message:
          "This API key is not bound to a workspace. /v1/collections requires a workspace-scoped key.",
      },
    },
    { status: 400 },
  );
}

async function authenticate(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return {
      error: unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'."),
    } as const;
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return { error: unauthorized("Invalid or revoked API key.") } as const;
  }
  return { key } as const;
}

async function enforceChain(
  req: Request,
  key: Awaited<ReturnType<typeof findByPlaintext>>,
  route: string,
) {
  if (!key) return null;
  const lockdown = await enforceWorkspaceLockdownForKey(req, key, { route });
  if (lockdown) return lockdown;
  const wsIp = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsIp) return wsIp;
  const keyIp = await enforceKeyAllowlist(req, key);
  if (keyIp) return keyIp;
  const residency = await enforceWorkspaceResidencyForKey(req, key);
  if (residency) return residency;
  const policy = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policy) return policy;
  const dpa = await enforceWorkspaceDpaForKey(req, key, { route });
  if (dpa) return dpa;
  return null;
}

function parsePositiveInt(raw: string | null, fallback: number, max: number) {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, n);
}

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:read"))
    return missingScope("collections:read", key);
  const chain = await enforceChain(req, key, "/v1/collections");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
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
  const limit = parsePositiveInt(sp.get("limit"), 25, 100);
  const offset = parsePositiveInt(sp.get("offset"), 0, 1_000_000);
  const q = sp.get("q") ?? "";
  const sort = parseSortKey(sp.get("sort"));
  const dir = parseSortDir(sp.get("dir"));

  const started = performance.now();
  const page = await listCollections({
    limit,
    offset,
    q,
    sort,
    dir,
    // Tenant-scope to the calling key's workspace. allowLegacy is
    // false so unscoped records from the single-tenant dashboard
    // path are never visible to a /v1 caller.
    workspaceId: key.workspaceId,
    allowLegacy: false,
  });
  const latencyMs = performance.now() - started;

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.collections.list",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: page.items.length,
      total: page.total,
      filters: { q: q || null, sort, dir },
      limit,
      offset,
      format,
    },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/collections",
    bytes: 0,
    latencyMs: Number(latencyMs.toFixed(3)),
    workspaceId: key.workspaceId,
  });

  if (format === "csv") {
    const filenameWs = key.workspaceId ?? "legacy";
    const csv = collectionsToCsv(page.items, key.workspaceId ?? null);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rl.headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-${filenameWs}-collections.csv"`,
      },
    });
  }

  return NextResponse.json(
    {
      items: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      next_offset:
        page.offset + page.items.length < page.total
          ? page.offset + page.items.length
          : null,
    },
    { headers: rl.headers },
  );
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

type CollectionCsvRow = {
  id: string;
  title: string;
  description?: string;
  count: number;
  createdAt: number;
  updatedAt: number;
};

function collectionsToCsv(
  rows: ReadonlyArray<CollectionCsvRow>,
  workspaceId: string | null,
): string {
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
        csvCell(workspaceId),
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


export async function POST(req: Request) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:write"))
    return missingScope("collections:write", key);
  const chain = await enforceChain(req, key, "/v1/collections");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
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
  const b = (raw ?? {}) as Record<string, unknown>;
  const started = performance.now();
  try {
    const rec = await createCollection({
      title: typeof b.title === "string" ? b.title : "",
      description: typeof b.description === "string" ? b.description : undefined,
      shareIds: Array.isArray(b.shareIds) ? (b.shareIds as unknown[] as string[]) : [],
      // Stamp the calling workspace on creation so subsequent reads
      // through /v1 stay isolated.
      workspaceId: key.workspaceId,
    });
    const latencyMs = performance.now() - started;
    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.collections.create",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "collection", id: rec.id, label: rec.title },
      status: "ok",
      meta: {
        prefix: key.prefix,
        title: rec.title,
        items: rec.shareIds.length,
      },
    });
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/collections",
      bytes: 0,
      latencyMs: Number(latencyMs.toFixed(3)),
      workspaceId: key.workspaceId,
    });
    return NextResponse.json(
      {
        collection: {
          id: rec.id,
          title: rec.title,
          ...(rec.description ? { description: rec.description } : {}),
          shareIds: rec.shareIds,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        },
      },
      { status: 201, headers: rl.headers },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void tryRecordAudit(req, {
      action: "v1.collections.create",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "api_key", id: key.id, label: key.label },
      status: "denied",
      meta: { prefix: key.prefix, reason: msg },
    });
    return NextResponse.json(
      { error: { type: "invalid_request", message: msg } },
      { status: 400, headers: rl.headers },
    );
  }
}
