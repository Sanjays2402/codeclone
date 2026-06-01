/**
 * Public /v1/shares/[id] endpoint.
 *
 * Authenticated via Bearer token (or x-api-key header). Requires the
 * `shares:read` scope. Returns the full saved comparison record,
 * including both snippets, scores, alignment, and clone classification,
 * so customers can render their own diff views or pipe results into
 * code-review tooling.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { loadShare, deleteShare } from "../../../../../lib/share";
import { logUsage } from "../../../../../lib/usage";
import { tryRecordAudit } from "../../../../../lib/audit";
import { isDryRun, DRY_RUN_HEADER } from "../../../../../lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
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
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/shares/[id]" });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid share id." } },
      { status: 400 },
    );
  }

  try {
    const rec = await loadShare(id);
    if (!rec) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404 },
      );
    }

    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/shares/[id]",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });

    return NextResponse.json({
      id: rec.id,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt ?? null,
      language: rec.language,
      title: rec.title ?? null,
      tags: rec.tags ?? [],
      a: rec.a,
      b: rec.b,
      result: rec.result,
      url: `/r/${rec.id}`,
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
 * DELETE /v1/shares/:id
 *
 * Requires the `shares:write` scope. Permanently removes a saved
 * comparison record. Supports `?dry_run=true` (or `{ dry_run: true }`
 * in a JSON body) which runs every auth/policy/quota check the live
 * call runs, returns a preview of what would be deleted, and exits
 * without touching storage. Dry-run responses include the
 * `x-codeclone-dry-run: true` header and the same rate-limit headers a
 * live call would emit so customers can wire integrations in CI without
 * mutating production data.
 *
 * Every call (live or dry-run) is recorded to the audit log so security
 * teams can attribute every probe and every actual deletion to a
 * specific API key, actor, and IP.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
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

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/shares/[id]" });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid share id." } },
      { status: 400, headers: rl.headers },
    );
  }

  // Allow `dry_run=true` from query string or an optional JSON body.
  let body: unknown = null;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  const dryRun = isDryRun(req, body);

  try {
    const rec = await loadShare(id);
    if (!rec) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404, headers: rl.headers },
      );
    }

    if (dryRun) {
      void tryRecordAudit(req, {
        action: "v1.shares.delete.dry_run",
        actorId: key.userId ?? null,
        target: { type: "share", id: rec.id, label: rec.title ?? undefined },
        meta: { language: rec.language, created_at: rec.createdAt },
      });
      return NextResponse.json(
        {
          dry_run: true,
          would: {
            delete_share: true,
            charge_quota: true,
            record_usage: true,
          },
          share: {
            id: rec.id,
            language: rec.language,
            title: rec.title ?? null,
            tags: rec.tags ?? [],
            created_at: rec.createdAt,
            updated_at: rec.updatedAt ?? null,
          },
        },
        { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
      );
    }

    const ok = await deleteShare(id);
    if (!ok) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404, headers: rl.headers },
      );
    }

    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "DELETE /v1/shares/[id]",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    void tryRecordAudit(req, {
      action: "v1.shares.delete",
      actorId: key.userId ?? null,
      target: { type: "share", id: rec.id, label: rec.title ?? undefined },
      meta: { language: rec.language, created_at: rec.createdAt },
    });

    return NextResponse.json(
      { deleted: true, id: rec.id },
      { headers: rl.headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "internal_error", message: msg } },
      { status: 500 },
    );
  }
}
