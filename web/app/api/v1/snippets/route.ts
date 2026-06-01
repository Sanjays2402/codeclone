/**
 * Public /v1/snippets: programmatic snippet corpus management.
 *
 * Enterprise customers need to bulk-load a baseline corpus (canonical
 * implementations, internal templates, "known good" reference code)
 * from CI pipelines, migration scripts, and IDE plugins instead of
 * pasting snippets through the /snippets UI one at a time. This route
 * exposes list/create over the same store the dashboard uses, so a
 * snippet POSTed here shows up immediately under /snippets and is
 * usable as a baseline in /compare.
 *
 * Auth: Bearer token or `x-api-key`, identical to the rest of /v1.
 * Scopes:
 *   GET  -> snippets:read
 *   POST -> snippets:write
 * Tenant scope: every operation is hard-bound to `key.userId` (the
 *   identity that owns the API key). A key minted by user A can never
 *   read, create, mutate, or enumerate user B's snippets, even if both
 *   live on the same store. Keys with no userId binding (legacy /
 *   unbound) are rejected: snippets are per-identity by design.
 * Side effects: bills one /v1 rate-limit slot per call, records one
 *   audit row (`v1.snippets.list` / `v1.snippets.create`), and logs
 *   usage so the call shows up in /usage and /v1/usage.
 *
 * Standard enforcement chain (lockdown, workspace + key IP allowlists,
 * residency, workspace API key policy, DPA) runs before any side
 * effect, matching every other /v1 route. Workspace plan quota is
 * NOT charged: snippet management is corpus housekeeping, not a
 * billable model call.
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
  createSnippet,
  listSnippets,
  SnippetError,
  type SnippetRecord,
} from "../../../../lib/snippets";

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

function parsePositiveInt(raw: string | null, fallback: number, max: number) {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, n);
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

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "snippets:read")) return missingScope("snippets:read", key);
  const chain = await enforceChain(req, key, "/v1/snippets");
  if (chain) return chain;
  if (!key.userId) return notBoundToUser();
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const language = url.searchParams.get("language") ?? undefined;
  const classification = url.searchParams.get("classification") ?? undefined;
  const limit = parsePositiveInt(url.searchParams.get("limit"), 25, 100);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 1_000_000);

  const started = performance.now();
  const items = await listSnippets(key.userId, {
    q,
    tag,
    language,
    classification,
    limit,
    offset,
  });
  const latencyMs = performance.now() - started;

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.snippets.list",
    actorId: key.userId,
    workspaceId: key.workspaceId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: items.length,
      filters: { q: q ?? null, tag: tag ?? null, language: language ?? null, classification: classification ?? null },
      limit,
      offset,
    },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/snippets",
    bytes: 0,
    latencyMs: Number(latencyMs.toFixed(3)),
    workspaceId: key.workspaceId,
  });

  return NextResponse.json(
    {
      count: items.length,
      limit,
      offset,
      items: items.map(presentSnippet),
    },
    { headers: rl.headers },
  );
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;
  const { key } = auth;
  if (!hasScope(key, "snippets:write")) return missingScope("snippets:write", key);
  const chain = await enforceChain(req, key, "/v1/snippets");
  if (chain) return chain;
  if (!key.userId) return notBoundToUser();
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
    const rec = await createSnippet(key.userId, {
      title: typeof b.title === "string" ? b.title : "",
      language: typeof b.language === "string" ? b.language : "",
      body: typeof b.body === "string" ? b.body : "",
      tags: Array.isArray(b.tags) ? (b.tags as unknown[] as string[]) : [],
      classification:
        typeof b.classification === "string" ? b.classification : undefined,
    });
    const latencyMs = performance.now() - started;
    void recordUse(key.id, clientIpFromRequest(req));
    void tryRecordAudit(req, {
      action: "v1.snippets.create",
      actorId: key.userId,
      workspaceId: key.workspaceId ?? null,
      target: { type: "snippet", id: rec.id, label: rec.title },
      status: "ok",
      meta: {
        prefix: key.prefix,
        language: rec.language,
        classification: rec.classification,
        tags: rec.tags,
        bytes: Buffer.byteLength(rec.body, "utf-8"),
      },
    });
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/snippets",
      bytes: Buffer.byteLength(rec.body, "utf-8"),
      latencyMs: Number(latencyMs.toFixed(3)),
      workspaceId: key.workspaceId,
    });
    return NextResponse.json(
      { snippet: presentSnippet(rec) },
      { status: 201, headers: rl.headers },
    );
  } catch (err) {
    if (err instanceof SnippetError) {
      void tryRecordAudit(req, {
        action: "v1.snippets.create",
        actorId: key.userId,
        workspaceId: key.workspaceId ?? null,
        target: { type: "api_key", id: key.id, label: key.label },
        status: "denied",
        meta: { prefix: key.prefix, reason: err.message, http_status: err.status },
      });
      return NextResponse.json(
        { error: { type: "invalid_request", message: err.message } },
        { status: err.status, headers: rl.headers },
      );
    }
    throw err;
  }
}
