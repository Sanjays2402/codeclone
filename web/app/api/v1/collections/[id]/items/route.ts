/**
 * Public /v1/collections/:id/items: programmatic membership edits for
 * a collection. Adds and removes share references on a workspace-
 * scoped collection so CI pipelines, content librarians, and curation
 * bots can keep collections current without driving the dashboard.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: collections:read for GET (list), collections:write for POST
 *        (add) and DELETE (remove). Read-only callers can audit
 *        membership but cannot mutate it.
 * Tenant scope: both the target collection AND the referenced share
 *        must belong to the calling key's workspace. A workspace A
 *        key cannot link a workspace B share into a workspace A
 *        collection, and cannot edit a workspace B collection. Cross
 *        -tenant attempts return 404, never 403, so existence is not
 *        leaked.
 * Side effects: increments per-key rate limit, logs one usage row,
 *        writes a `v1.collections.item_add` or `v1.collections.
 *        item_remove` audit event, and updates the key's
 *        `lastUsedAt`/`recentIps` ring.
 * Errors: structured `{ error: { type, message } }` envelope, matching
 *        the rest of /v1. 400 for malformed body, 401 missing key,
 *        403 missing scope, 404 unknown collection or cross-tenant,
 *        429 rate-limited (with `Retry-After` + `X-RateLimit-*`).
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../../../lib/dpa-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../../../lib/audit";
import { logUsage } from "../../../../../../lib/usage";
import {
  addItem,
  removeItem,
  isCollectionId,
  loadCollection,
  listItems,
  type CollectionRecord,
} from "../../../../../../lib/collections";

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

function notFound(message = "Collection not found.") {
  return NextResponse.json(
    { error: { type: "not_found", message } },
    { status: 404 },
  );
}

async function authenticate(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return {
      error: unauthorized(
        "Missing API key. Pass 'Authorization: Bearer <key>'.",
      ),
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

function present(rec: CollectionRecord) {
  return {
    id: rec.id,
    title: rec.title,
    ...(rec.description ? { description: rec.description } : {}),
    shareIds: rec.shareIds,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function workspaceOwns(
  rec: CollectionRecord,
  workspaceId: string,
): boolean {
  return rec.workspaceId === workspaceId;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:read"))
    return missingScope("collections:read", key);
  const chain = await enforceChain(req, key, "/v1/collections/:id/items");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!isCollectionId(id)) return notFound();
  const existing = await loadCollection(id);
  if (!existing || !workspaceOwns(existing, key.workspaceId)) return notFound();

  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
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
  const rawLimit = url.searchParams.get("limit");
  let limit = 25;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message: "limit must be an integer in [1,100].",
          },
        },
        { status: 400, headers: rl.headers },
      );
    }
    limit = n;
  }
  const cursor = url.searchParams.get("cursor");

  const page = await listItems(id, {
    limit,
    cursor,
    // Defence in depth: even if a cross-tenant shareId somehow ended up in
    // a collection (it cannot via POST, but old data, manual edits, or
    // future bugs are real), do not leak the other workspace's snippet.
    shareScope: { workspaceId: key.workspaceId },
  });
  if (!page) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.collections.item_list",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "collection", id: page.collectionId },
    status: "ok",
    meta: {
      prefix: key.prefix,
      limit,
      cursor: cursor ?? null,
      returned: page.items.length,
      total: page.total,
      format,
    },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/collections/:id/items",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });

  if (format === "csv") {
    const filenameWs = key.workspaceId ?? "legacy";
    const csv = itemsToCsv(
      page.collectionId,
      key.workspaceId ?? null,
      page.items,
    );
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rl.headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-${filenameWs}-collection-${page.collectionId}-items.csv"`,
      },
    });
  }

  return NextResponse.json(
    {
      collection_id: page.collectionId,
      items: page.items,
      total: page.total,
      next_cursor: page.nextCursor,
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

type ItemCsvRow = {
  id: string;
  title?: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  bytes: { a: number; b: number };
  missing?: boolean;
};

function itemsToCsv(
  collectionId: string,
  workspaceId: string | null,
  rows: ReadonlyArray<ItemCsvRow>,
): string {
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
        csvCell(workspaceId),
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

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:write"))
    return missingScope("collections:write", key);
  const chain = await enforceChain(req, key, "/v1/collections/:id/items");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!isCollectionId(id)) return notFound();
  const existing = await loadCollection(id);
  if (!existing || !workspaceOwns(existing, key.workspaceId)) return notFound();

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
  const shareId = b.shareId;
  if (typeof shareId !== "string" || shareId.length === 0) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "shareId (string) is required.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  try {
    const updated = await addItem(id, shareId, {
      shareScope: { workspaceId: key.workspaceId },
    });
    if (!updated) return notFound();
    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.collections.item_add",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "collection", id: updated.id, label: shareId },
      status: "ok",
      meta: { prefix: key.prefix, shareId },
    });
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/collections/:id/items",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    return NextResponse.json(
      { collection: present(updated) },
      { headers: rl.headers },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // share-not-found can mean cross-tenant; return 404 to avoid leaking
    // existence of a share owned by another workspace.
    const status = /share not found/i.test(msg) ? 404 : 400;
    const type = status === 404 ? "not_found" : "invalid_request";
    return NextResponse.json(
      { error: { type, message: msg } },
      { status, headers: rl.headers },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:write"))
    return missingScope("collections:write", key);
  const chain = await enforceChain(req, key, "/v1/collections/:id/items");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!isCollectionId(id)) return notFound();
  const existing = await loadCollection(id);
  if (!existing || !workspaceOwns(existing, key.workspaceId)) return notFound();

  const url = new URL(req.url);
  const shareId = url.searchParams.get("shareId");
  if (!shareId) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "shareId query param required.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  const updated = await removeItem(id, shareId);
  if (!updated) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.collections.item_remove",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "collection", id: updated.id, label: shareId },
    status: "ok",
    meta: { prefix: key.prefix, shareId },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/collections/:id/items",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  return NextResponse.json(
    { collection: present(updated) },
    { headers: rl.headers },
  );
}
