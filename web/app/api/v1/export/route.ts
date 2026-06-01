/**
 * Public GET /v1/export: programmatic GDPR Article 20 portability bundle.
 *
 * Enterprise privacy and compliance teams running CodeClone need a
 * machine-readable way to produce a full data portability artifact
 * for a workspace on demand: DSAR fulfillment, DPA evidence, scheduled
 * SOC2 export-on-request drills, or pre-termination data egress. The
 * dashboard already exposes GET /api/workspaces/:id/export to a logged-in
 * owner via cookie. This is the same bundle, scoped to the calling
 * API key's workspace, callable from a CI job, a privacy ops runbook,
 * or a customer's own DSAR pipeline.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `export:read`. Legacy keys with no `scopes` field keep
 *        working (full privileges, matching every other /v1 route).
 * Tenant scope: the bundle is strictly limited to the calling key's
 *        workspace. A key minted in workspace A can never download
 *        workspace B's bundle, even if both live on the same store.
 *        Keys with no workspace get 400 (the endpoint is meaningless
 *        without a workspace context).
 * Side effects: increments the per-key rate-limit window and writes
 *        one audit row (`v1.export.read`) with the row counts of the
 *        bundle, so a DPO can prove a portability request was served
 *        from the audit log alone. Does not count toward the monthly
 *        /v1 plan quota; portability is a regulatory right, not a
 *        billable model call.
 * Query: ?format=json (default) returns the full bundle; ?format=csv
 *        returns just the audit log flattened to CSV (the most common
 *        DPA artifact request). The JSON bundle still carries the rest.
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
import { toCsv } from "../../../../lib/audit";
import { getWorkspace, exportWorkspace } from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
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

  if (!hasScope(key, "export:read")) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "This key is missing the 'export:read' scope.",
          required_scope: "export:read",
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/export",
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

  // Tenant scope: the endpoint is meaningless for a key with no
  // workspace context, so reject rather than silently 404ing.
  if (!key.workspaceId) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message:
            "This API key is not bound to a workspace. /v1/export requires a workspace-scoped key.",
        },
      },
      { status: 400 },
    );
  }

  // Spend a rate-limit slot. Portability exports are heavier than
  // most /v1 reads (they fan out to invites + keys + audit + SCIM)
  // so the call must count against the key's RPM budget.
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  void effectiveRpm(key);

  const url = new URL(req.url);
  const rawFormat = (url.searchParams.get("format") || "json").toLowerCase();
  const format: "json" | "csv" = rawFormat === "csv" ? "csv" : "json";

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) {
    // The key references a workspace that no longer exists.
    return NextResponse.json(
      {
        error: {
          type: "not_found",
          message: "Workspace not found.",
        },
      },
      { status: 404, headers: rlHeaders },
    );
  }

  const bundle = await exportWorkspace(ws);
  const stamp = new Date(bundle.exportedAt).toISOString().replace(/[:.]/g, "-");

  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.export.read",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace", id: ws.id, label: ws.name },
    status: "ok",
    meta: {
      prefix: key.prefix,
      format,
      counts: {
        invites: bundle.invites.length,
        apiKeys: bundle.apiKeys.length,
        audit: bundle.audit.length,
        scimUsers: bundle.scimUsers.length,
      },
    },
  });

  if (format === "csv") {
    const csv = toCsv(bundle.audit as unknown as Parameters<typeof toCsv>[0]);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rlHeaders,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-workspace-${ws.slug}-audit-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const body = JSON.stringify(bundle, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...rlHeaders,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="codeclone-workspace-${ws.slug}-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
