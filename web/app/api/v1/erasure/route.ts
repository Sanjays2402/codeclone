/**
 * Public POST /v1/erasure: programmatic GDPR Article 17 (right to
 * erasure) execution for the calling workspace's saved comparisons.
 *
 * Enterprise privacy and compliance teams need a machine-readable way
 * to fulfill data-subject erasure requests on a schedule (e.g. nightly
 * retention sweeps, DSAR fulfillment runbooks, contractual purge after
 * customer offboarding) without poking the dashboard one row at a
 * time. GET /v1/export already covers Article 20 (portability); this
 * is the symmetric write path: bulk delete saved comparisons in the
 * calling workspace that match a filter, with a dry-run preview, an
 * audit row that doubles as a DPO erasure receipt, and an idempotent
 * id-list mode for DSAR pipelines that already know the exact records
 * to forget.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `erasure:write`. Legacy keys with no `scopes` field keep
 *        working (full privileges, matching every other /v1 route).
 * Tenant scope: erasure is strictly limited to the calling key's
 *        workspaceId. A key minted in workspace A can never delete
 *        workspace B's saved comparisons, even when the request body
 *        contains an explicit id list referencing workspace B records.
 *        Keys with no workspace get 400 (the endpoint is meaningless
 *        without a workspace context, and we refuse to operate on
 *        legacy unscoped records via the public API).
 * Body: JSON. One of:
 *        { "ids": ["abc1234567", ...] }                  — explicit
 *        { "filter": { "tag": "...", "language": "...",
 *                      "created_before": <ms epoch> } }   — bulk
 *        Plus optional "dry_run": true.
 *        Either form may be combined with dry_run for a preview.
 * Side effects (live): permanently deletes each matching share,
 *        increments the per-key rate-limit window, and writes ONE
 *        audit row (`v1.erasure.execute`) with the full list of
 *        erased ids and counts. The audit row is the DPO erasure
 *        receipt and is itself retained under workspace audit
 *        retention policy (the erased payloads are gone, the
 *        attribution survives, matching SOC2 / GDPR guidance).
 * Side effects (dry-run): no deletions, no usage charged, one
 *        audit row (`v1.erasure.dry_run`) so security teams can
 *        attribute every probe.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import {
  effectiveRpm,
  enforce as enforceRateLimit,
} from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { DRY_RUN_HEADER, isDryRun } from "../../../../lib/dry-run";
import {
  deleteShare,
  listShares,
  loadShare,
  type ListSharesOptions,
} from "../../../../lib/share";
import { logUsage } from "../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EXPLICIT_IDS = 500;
const MAX_BULK_ERASE = 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function bad(status: number, type: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json(
    { error: { type, message } },
    { status, headers },
  );
}

interface ErasureFilter {
  tag?: string;
  language?: string;
  created_before?: number;
}

interface ErasureBody {
  ids?: unknown;
  filter?: ErasureFilter;
  dry_run?: unknown;
}

export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }
  if (!hasScope(key, "erasure:write")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message:
            "This key is missing the 'erasure:write' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "erasure:write",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/erasure",
  });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  // Tenant scope: erasure is meaningless for a key with no workspace,
  // and we refuse to operate on legacy unscoped records via /v1.
  if (!key.workspaceId) {
    return bad(
      400,
      "invalid_request",
      "This API key is not bound to a workspace. /v1/erasure requires a workspace-scoped key.",
    );
  }

  // Bulk delete is heavier than most /v1 writes: spend a slot.
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  void effectiveRpm(key);

  // Parse body. JSON required for POST; an empty body is treated as
  // an unbounded request, which we reject so customers cannot
  // accidentally wipe the workspace by curling with no payload.
  let body: ErasureBody = {};
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as ErasureBody;
      }
    } catch {
      return bad(
        400,
        "invalid_request",
        "Request body must be valid JSON.",
        rlHeaders,
      );
    }
  } else {
    return bad(
      400,
      "invalid_request",
      "Request must use Content-Type: application/json.",
      rlHeaders,
    );
  }

  const dryRun = isDryRun(req, body);
  const wsId = key.workspaceId;
  const scope = { workspaceId: wsId, allowLegacy: false } as const;

  // Resolve the candidate id list. Either explicit ids or a filter,
  // not both at once (avoids ambiguous semantics in audit receipts).
  const hasIds = body.ids !== undefined;
  const hasFilter = body.filter !== undefined;
  if (hasIds && hasFilter) {
    return bad(
      400,
      "invalid_request",
      "Provide either 'ids' or 'filter', not both.",
      rlHeaders,
    );
  }
  if (!hasIds && !hasFilter) {
    return bad(
      400,
      "invalid_request",
      "Request body must contain 'ids' (array of share ids) or 'filter' (object).",
      rlHeaders,
    );
  }

  let candidateIds: string[] = [];
  let mode: "ids" | "filter";

  if (hasIds) {
    mode = "ids";
    if (!Array.isArray(body.ids)) {
      return bad(400, "invalid_request", "'ids' must be an array of share id strings.", rlHeaders);
    }
    if (body.ids.length === 0) {
      return bad(400, "invalid_request", "'ids' must contain at least one share id.", rlHeaders);
    }
    if (body.ids.length > MAX_EXPLICIT_IDS) {
      return bad(
        400,
        "invalid_request",
        `'ids' may contain at most ${MAX_EXPLICIT_IDS} entries per call.`,
        rlHeaders,
      );
    }
    const seen = new Set<string>();
    for (const raw of body.ids) {
      if (typeof raw !== "string" || !ID_RE.test(raw)) {
        return bad(400, "invalid_request", "Each id must be an 8-32 char alphanumeric string.", rlHeaders);
      }
      seen.add(raw);
    }
    candidateIds = [...seen];
  } else {
    mode = "filter";
    const f = body.filter as ErasureFilter | undefined;
    if (!f || typeof f !== "object") {
      return bad(400, "invalid_request", "'filter' must be an object.", rlHeaders);
    }
    const opts: ListSharesOptions = { workspaceId: wsId, allowLegacy: false, limit: MAX_BULK_ERASE };
    if (f.tag !== undefined) {
      if (typeof f.tag !== "string" || f.tag.length === 0 || f.tag.length > 64) {
        return bad(400, "invalid_request", "'filter.tag' must be a non-empty string.", rlHeaders);
      }
      opts.tag = f.tag;
    }
    if (f.language !== undefined) {
      if (typeof f.language !== "string" || f.language.length === 0 || f.language.length > 32) {
        return bad(400, "invalid_request", "'filter.language' must be a non-empty string.", rlHeaders);
      }
      opts.language = f.language;
    }
    let createdBefore: number | undefined;
    if (f.created_before !== undefined) {
      if (typeof f.created_before !== "number" || !Number.isFinite(f.created_before) || f.created_before <= 0) {
        return bad(400, "invalid_request", "'filter.created_before' must be a positive epoch-ms number.", rlHeaders);
      }
      createdBefore = f.created_before;
    }
    if (!opts.tag && !opts.language && createdBefore === undefined) {
      return bad(
        400,
        "invalid_request",
        "'filter' must include at least one of tag, language, created_before.",
        rlHeaders,
      );
    }
    const summaries = await listShares(opts);
    const filtered = createdBefore !== undefined
      ? summaries.filter((s) => s.createdAt < createdBefore!)
      : summaries;
    candidateIds = filtered.map((s) => s.id);
  }

  // Tenant gate every candidate. For the explicit-ids path the caller
  // may pass ids from another tenant; loadShare with our workspace
  // scope returns null for foreign records, which we silently drop
  // from the receipt rather than 404 (no cross-tenant existence leak).
  const eligible: string[] = [];
  const skipped: { id: string; reason: "not_found_or_other_tenant" }[] = [];
  for (const id of candidateIds) {
    const rec = await loadShare(id, scope);
    if (rec) {
      eligible.push(rec.id);
    } else {
      skipped.push({ id, reason: "not_found_or_other_tenant" });
    }
  }

  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.erasure.dry_run",
      actorId: key.id,
      workspaceId: wsId,
      target: { type: "workspace", id: wsId },
      status: "ok",
      meta: {
        prefix: key.prefix,
        mode,
        requested: candidateIds.length,
        would_erase: eligible.length,
        skipped: skipped.length,
      },
    });
    return NextResponse.json(
      {
        dry_run: true,
        mode,
        workspace_id: wsId,
        would: {
          erase_share_ids: eligible,
          erase_count: eligible.length,
          skipped,
        },
      },
      { headers: { ...rlHeaders, ...DRY_RUN_HEADER } },
    );
  }

  const erased: string[] = [];
  const failed: string[] = [];
  for (const id of eligible) {
    const ok = await deleteShare(id, scope);
    if (ok) erased.push(id);
    else failed.push(id);
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/erasure",
    bytes: 0,
    latencyMs: 0,
  });

  // The DPO receipt. action id is stable so SIEM rules and DSAR
  // pipelines can grep for it; meta carries the full erased id list
  // plus the skipped/failed counts so a single audit row is enough
  // evidence to close out an Article 17 request.
  void tryRecordAudit(req, {
    action: "v1.erasure.execute",
    actorId: key.id,
    workspaceId: wsId,
    target: { type: "workspace", id: wsId },
    status: failed.length === 0 ? "ok" : "error",
    meta: {
      prefix: key.prefix,
      mode,
      requested: candidateIds.length,
      erased_count: erased.length,
      erased_ids: erased,
      skipped_count: skipped.length,
      failed_count: failed.length,
    },
  });

  return NextResponse.json(
    {
      mode,
      workspace_id: wsId,
      erased: {
        ids: erased,
        count: erased.length,
      },
      skipped,
      failed,
      receipt: {
        action: "v1.erasure.execute",
        actor_key_id: key.id,
        workspace_id: wsId,
        at: Date.now(),
      },
    },
    { headers: rlHeaders },
  );
}
