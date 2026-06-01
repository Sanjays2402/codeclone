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
import { loadShare, deleteShare, updateShare, type ScopeHint } from "../../../../../lib/share";
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

  // Tenant scope: the calling key must own the share's workspace, or
  // (for legacy single-tenant installs where the key has no workspace)
  // the share must itself be legacy unscoped.
  const scope: ScopeHint = { workspaceId: key.workspaceId ?? null, allowLegacy: !key.workspaceId };

  try {
    const rec = await loadShare(id, scope);
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

/**
 * PATCH /v1/shares/:id
 *
 * Requires the `shares:write` scope. Edits the human-facing metadata
 * (title and/or tags) on a saved comparison without re-running the
 * model or rotating its public id. Security and compliance teams asked
 * for this so they can relabel or retag records to match retention
 * policies, case numbers, or DLP categories without losing the
 * original analysis or its share URL.
 *
 * Body: JSON `{ title?: string | null, tags?: string[] | null }`.
 * Passing `null` (or `""` for title) clears the field. At least one of
 * the two must be present. Validation/normalization is delegated to
 * `lib/share.updateShare` (length cap, dedupe, allowed charset).
 *
 * Tenant scope: the calling key must own the share's workspace, or
 * (for legacy unscoped installs where the key has no workspace) the
 * share must itself be legacy unscoped. Cross-tenant PATCH returns
 * 404 just like cross-tenant GET / DELETE, so tenants cannot probe
 * for the existence of another workspace's share by id.
 *
 * Supports `?dry_run=true` (or `{ dry_run: true }` in the body), which
 * runs every auth / policy / quota check the live call runs and
 * returns the would-be diff without touching storage. Dry-run
 * responses include the `x-codeclone-dry-run: true` header so CI
 * pipelines can wire integrations safely.
 *
 * Every call (live or dry-run) writes an audit entry. Live calls
 * include a before/after diff of title and tags for SOC2 CC6.1 /
 * ISO 27001 A.8.2 change-evidence.
 */
export async function PATCH(
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

  let body: unknown = null;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "Body must be valid JSON." } },
        { status: 400, headers: rl.headers },
      );
    }
  }
  const b = (body ?? {}) as { title?: unknown; tags?: unknown };
  const hasTitle = Object.prototype.hasOwnProperty.call(b, "title");
  const hasTags = Object.prototype.hasOwnProperty.call(b, "tags");
  if (!hasTitle && !hasTags) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Body must contain at least one of: title, tags.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }
  if (hasTitle && b.title !== null && typeof b.title !== "string") {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "title must be a string or null." } },
      { status: 400, headers: rl.headers },
    );
  }
  if (hasTags && b.tags !== null && !Array.isArray(b.tags)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "tags must be an array of strings or null." } },
      { status: 400, headers: rl.headers },
    );
  }
  if (hasTags && Array.isArray(b.tags) && !b.tags.every((t) => typeof t === "string")) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "tags must be an array of strings or null." } },
      { status: 400, headers: rl.headers },
    );
  }

  const scope: ScopeHint = {
    workspaceId: key.workspaceId ?? null,
    allowLegacy: !key.workspaceId,
  };
  const dryRun = isDryRun(req, body);

  try {
    const before = await loadShare(id, scope);
    if (!before) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404, headers: rl.headers },
      );
    }

    const patch: { title?: string | null; tags?: string[] | null } = {};
    if (hasTitle) patch.title = b.title as string | null;
    if (hasTags) patch.tags = b.tags as string[] | null;

    if (dryRun) {
      void tryRecordAudit(req, {
        action: "v1.shares.update.dry_run",
        actorId: key.userId ?? null,
        workspaceId: key.workspaceId,
        target: { type: "share", id: before.id, label: before.title ?? undefined },
        meta: {
          proposed: {
            title: hasTitle ? (b.title as string | null) : undefined,
            tags: hasTags ? (b.tags as string[] | null) : undefined,
          },
        },
      });
      return NextResponse.json(
        {
          dry_run: true,
          would: {
            update_share: true,
            charge_quota: true,
            record_usage: true,
          },
          share: {
            id: before.id,
            title: before.title ?? null,
            tags: before.tags ?? [],
          },
        },
        { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
      );
    }

    const updated = await updateShare(id, patch, scope);
    if (!updated) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404, headers: rl.headers },
      );
    }

    const changed =
      (hasTitle && (before.title ?? null) !== (updated.title ?? null)) ||
      (hasTags &&
        JSON.stringify(before.tags ?? []) !== JSON.stringify(updated.tags ?? []));

    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "PATCH /v1/shares/[id]",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    void tryRecordAudit(req, {
      action: "v1.shares.update",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "share", id: updated.id, label: updated.title ?? undefined },
      diff: {
        before: { title: before.title ?? null, tags: before.tags ?? [] },
        after: { title: updated.title ?? null, tags: updated.tags ?? [] },
      },
      meta: { changed },
    });

    return NextResponse.json(
      {
        share: {
          id: updated.id,
          created_at: updated.createdAt,
          updated_at: updated.updatedAt ?? null,
          language: updated.language,
          title: updated.title ?? null,
          tags: updated.tags ?? [],
          url: `/r/${updated.id}`,
        },
        changed,
      },
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
