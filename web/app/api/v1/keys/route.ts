/**
 * Public GET /v1/keys: programmatic workspace API key inventory.
 *
 * SOC2 CC6.1 + CC6.3 require evidence that API keys are inventoried
 * and rotated on a defined cadence (commonly 90 days). Doing that by
 * hand through the dashboard does not scale past the first audit;
 * security teams want to wire CodeClone into the same SOAR/IGA
 * pipelines they already use for cloud IAM keys.
 *
 * This endpoint is the read side of that automation. Combined with
 * POST /v1/keys/:id/rotate and DELETE /v1/keys/:id (see the [id]
 * route), it lets a customer's compliance bot enumerate every key in
 * a workspace, detect keys past their rotation SLA, and rotate or
 * revoke them without a human in the loop.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `keys:read`. Legacy keys with no `scopes` field keep working
 *        (full privileges, matching every other /v1 route).
 * Tenant scope: results are strictly limited to the calling key's
 *        workspace. A key minted in workspace A can never enumerate
 *        keys from workspace B even if both live on the same store.
 *        Keys with no workspaceId get 403 (the endpoint is meaningless
 *        without a workspace context).
 *
 * Returned summaries never include hashes or plaintext secrets, only
 * the metadata the dashboard already exposes (id, label, prefix,
 * scopes, rate limit, expiry, last-used, usage count, recent IPs).
 *
 * Query: ?format=json|csv (default json). CSV returns an RFC 4180
 *        inventory download (id,label,prefix,created_at,last_used_at,
 *        usage_count,revoked,expired,user_id,workspace_id,expires_at,
 *        scopes,rate_limit_rpm,ip_allowlist) so SOC2 reviewers and
 *        FinOps can pipe the workspace key inventory straight into
 *        Excel, csvkit, or a SOAR rotation runbook without a JSON
 *        decode step. Unknown formats return 400.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown,
 * per-key rate limit.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  listKeysForWorkspace,
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
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { logUsage } from "../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function insufficientScope(required: string, granted: string[] | null | undefined) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${required}' scope. Rotate it with the scope enabled or issue a new key.`,
        required_scope: required,
        granted_scopes: granted ?? null,
      },
    },
    { status: 403 },
  );
}

function tenantRequired() {
  return NextResponse.json(
    {
      error: {
        type: "tenant_required",
        message:
          "This API key is not bound to a workspace. Programmatic key inventory is only available to workspace-scoped keys.",
      },
    },
    { status: 403 },
  );
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "keys:read")) return insufficientScope("keys:read", key.scopes);

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/keys" });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();

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

  try {
    const items = await listKeysForWorkspace(key.workspaceId);
    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/keys",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    void tryRecordAudit(req, {
      action: "v1.keys.read",
      actorId: key.id,
      workspaceId: key.workspaceId,
      target: { type: "workspace", id: key.workspaceId },
      status: "ok",
      meta: { count: items.length, format },
    });
    if (format === "csv") {
      const csv = keysToCsv(items);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          ...rl.headers,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="codeclone-${key.workspaceId}-keys.csv"`,
        },
      });
    }
    return NextResponse.json(
      {
        workspace_id: key.workspaceId,
        count: items.length,
        items,
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

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

type KeyRow = {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  usageCount: number;
  revoked?: boolean;
  expired?: boolean;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
  scopes?: ReadonlyArray<string>;
  rateLimit?: { rpm: number };
  ipAllowlist?: ReadonlyArray<string>;
};

function keysToCsv(rows: ReadonlyArray<KeyRow>): string {
  const header = [
    "id",
    "label",
    "prefix",
    "created_at",
    "last_used_at",
    "usage_count",
    "revoked",
    "expired",
    "user_id",
    "workspace_id",
    "expires_at",
    "scopes",
    "rate_limit_rpm",
    "ip_allowlist",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.label),
        csvCell(r.prefix),
        csvCell(r.createdAt),
        csvCell(r.lastUsedAt ?? null),
        csvCell(r.usageCount),
        csvCell(r.revoked === true),
        csvCell(r.expired === true),
        csvCell(r.userId ?? null),
        csvCell(r.workspaceId ?? null),
        csvCell(r.expiresAt ?? null),
        csvCell(Array.isArray(r.scopes) ? r.scopes.join(" ") : ""),
        csvCell(r.rateLimit?.rpm ?? null),
        csvCell(Array.isArray(r.ipAllowlist) ? r.ipAllowlist.join(" ") : ""),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
