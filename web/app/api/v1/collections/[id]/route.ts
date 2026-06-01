/**
 * Public /v1/collections/:id: programmatic per-collection read,
 * update, and delete.
 *
 * Auth: Bearer token or `x-api-key`.
 * Scopes:
 *   GET    -> collections:read
 *   PATCH  -> collections:write
 *   DELETE -> collections:write
 * Tenant scope: the loaded record must belong to the calling key's
 *   workspace. A record stamped with workspace A is invisible to a
 *   key from workspace B: the response is 404, not 403, so cross-
 *   tenant existence is never leaked. Unscoped legacy records from
 *   the single-tenant dashboard path are also invisible to /v1.
 *
 * Side effects, enforcement chain, and rate limiting match the rest
 * of /v1. Plan quota is not charged.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../../lib/dpa-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../../lib/audit";
import { logUsage } from "../../../../../lib/usage";
import {
  deleteCollection,
  isCollectionId,
  loadCollection,
  updateCollection,
  type CollectionRecord,
} from "../../../../../lib/collections";

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

function notFound() {
  return NextResponse.json(
    { error: { type: "not_found", message: "Collection not found." } },
    { status: 404 },
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

function workspaceOwns(rec: CollectionRecord, workspaceId: string): boolean {
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
  const chain = await enforceChain(req, key, "/v1/collections/:id");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!isCollectionId(id)) return notFound();
  const rec = await loadCollection(id);
  if (!rec || !workspaceOwns(rec, key.workspaceId)) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/collections/:id",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  return NextResponse.json({ collection: present(rec) }, { headers: rl.headers });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "collections:write"))
    return missingScope("collections:write", key);
  const chain = await enforceChain(req, key, "/v1/collections/:id");
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
  const patch: { title?: string; description?: string | null } = {};
  if (typeof b.title === "string") patch.title = b.title;
  if (b.description === null || typeof b.description === "string") {
    patch.description = b.description as string | null;
  }

  try {
    const updated = await updateCollection(id, patch);
    if (!updated) return notFound();
    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.collections.update",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "collection", id: updated.id, label: updated.title },
      status: "ok",
      meta: {
        prefix: key.prefix,
        patched: Object.keys(patch),
      },
    });
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/collections/:id",
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
    return NextResponse.json(
      { error: { type: "invalid_request", message: msg } },
      { status: 400, headers: rl.headers },
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
  const chain = await enforceChain(req, key, "/v1/collections/:id");
  if (chain) return chain;
  if (!key.workspaceId) return notBoundToWorkspace();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!isCollectionId(id)) return notFound();
  const existing = await loadCollection(id);
  if (!existing || !workspaceOwns(existing, key.workspaceId)) return notFound();

  const ok = await deleteCollection(id);
  if (!ok) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.collections.delete",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "collection", id, label: existing.title },
    status: "ok",
    meta: { prefix: key.prefix },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/collections/:id",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  return NextResponse.json({ deleted: true }, { headers: rl.headers });
}
