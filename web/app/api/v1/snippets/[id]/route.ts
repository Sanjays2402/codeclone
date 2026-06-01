/**
 * Public /v1/snippets/:id: read, update, delete a single snippet.
 *
 * Tenant scope: every operation calls into the snippets lib with the
 * calling key's userId, which the lib uses to derive both the on-disk
 * directory AND a defensive `rec.userId === userId` recheck on every
 * load. A snippet that exists for user A is unreachable through a key
 * minted by user B - the route returns 404 with no distinction
 * between "doesn't exist" and "isn't yours".
 *
 * Scopes:
 *   GET    -> snippets:read
 *   PATCH  -> snippets:write
 *   DELETE -> snippets:write
 *
 * Every method bills one rate-limit slot, records one audit row, and
 * logs usage. The standard /v1 enforcement chain runs before any side
 * effect.
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
  deleteSnippet,
  loadSnippet,
  SnippetError,
  type SnippetRecord,
  updateSnippet,
} from "../../../../../lib/snippets";

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
        message: `This key is missing the '${scope}' scope.`,
        required_scope: scope,
        granted_scopes: key.scopes ?? null,
      },
    },
    { status: 403 },
  );
}

function notBoundToUser() {
  return NextResponse.json(
    {
      error: {
        type: "invalid_request",
        message:
          "This API key is not bound to a user. /v1/snippets requires a user-scoped key.",
      },
    },
    { status: 400 },
  );
}

function notFound() {
  return NextResponse.json(
    { error: { type: "not_found", message: "Snippet not found." } },
    { status: 404 },
  );
}

function presentSnippet(rec: SnippetRecord) {
  return {
    id: rec.id,
    title: rec.title,
    language: rec.language,
    body: rec.body,
    tags: rec.tags,
    classification: rec.classification,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

async function authenticate(req: Request) {
  const token = extractBearer(req);
  if (!token) return { error: unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.") } as const;
  const key = await findByPlaintext(token);
  if (!key) return { error: unauthorized("Invalid or revoked API key.") } as const;
  return { key } as const;
}

async function enforceChain(req: Request, key: Awaited<ReturnType<typeof findByPlaintext>>, route: string) {
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

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "snippets:read")) return missingScope("snippets:read", key);
  const chain = await enforceChain(req, key, "/v1/snippets/:id");
  if (chain) return chain;
  if (!key.userId) return notBoundToUser();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
  const started = performance.now();
  const rec = await loadSnippet(key.userId, id);
  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/snippets/:id",
    bytes: 0,
    latencyMs: Number((performance.now() - started).toFixed(3)),
    workspaceId: key.workspaceId,
  });
  if (!rec) {
    void tryRecordAudit(req, {
      action: "v1.snippets.read",
      actorId: key.userId,
      workspaceId: key.workspaceId ?? null,
      target: { type: "snippet", id },
      status: "denied",
      meta: { prefix: key.prefix, reason: "not_found_or_cross_tenant" },
    });
    return notFound();
  }
  void tryRecordAudit(req, {
    action: "v1.snippets.read",
    actorId: key.userId,
    workspaceId: key.workspaceId ?? null,
    target: { type: "snippet", id: rec.id, label: rec.title },
    status: "ok",
    meta: { prefix: key.prefix },
  });
  return NextResponse.json({ snippet: presentSnippet(rec) }, { headers: rl.headers });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "snippets:write")) return missingScope("snippets:write", key);
  const chain = await enforceChain(req, key, "/v1/snippets/:id");
  if (chain) return chain;
  if (!key.userId) return notBoundToUser();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
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
  const patch: Record<string, unknown> = {};
  if (typeof b.title === "string") patch.title = b.title;
  if (typeof b.language === "string") patch.language = b.language;
  if (typeof b.body === "string") patch.body = b.body;
  if (Array.isArray(b.tags)) patch.tags = b.tags as string[];
  if (typeof b.classification === "string") patch.classification = b.classification;

  try {
    const rec = await updateSnippet(key.userId, id, patch);
    if (!rec) {
      void tryRecordAudit(req, {
        action: "v1.snippets.update",
        actorId: key.userId,
        workspaceId: key.workspaceId ?? null,
        target: { type: "snippet", id },
        status: "denied",
        meta: { prefix: key.prefix, reason: "not_found_or_cross_tenant" },
      });
      return notFound();
    }
    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.snippets.update",
      actorId: key.userId,
      workspaceId: key.workspaceId ?? null,
      target: { type: "snippet", id: rec.id, label: rec.title },
      status: "ok",
      meta: { prefix: key.prefix, fields: Object.keys(patch) },
    });
    return NextResponse.json({ snippet: presentSnippet(rec) }, { headers: rl.headers });
  } catch (err) {
    if (err instanceof SnippetError) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: err.message } },
        { status: err.status, headers: rl.headers },
      );
    }
    throw err;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "snippets:write")) return missingScope("snippets:write", key);
  const chain = await enforceChain(req, key, "/v1/snippets/:id");
  if (chain) return chain;
  if (!key.userId) return notBoundToUser();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
  const removed = await deleteSnippet(key.userId, id);
  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.snippets.delete",
    actorId: key.userId,
    workspaceId: key.workspaceId ?? null,
    target: { type: "snippet", id },
    status: removed ? "ok" : "denied",
    meta: { prefix: key.prefix, removed, reason: removed ? null : "not_found_or_cross_tenant" },
  });
  if (!removed) return notFound();
  return NextResponse.json({ ok: true, id }, { headers: rl.headers });
}
