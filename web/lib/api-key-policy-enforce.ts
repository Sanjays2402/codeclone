/**
 * Runtime enforcement of the workspace API key max-age policy.
 *
 * A workspace owner can require that every API key created in the
 * workspace expires within N days of its creation. We clamp the
 * `expiresAt` field at key creation time (lib/api-keys.ts#createKey), but
 * legacy keys minted before the policy was set, or keys that pre-date a
 * tightening of the policy, can still satisfy the regular
 * `isExpired(createdAt+expiresAt)` check while violating the workspace
 * rule. This module is the second line of defence: every /v1 request
 * resolves the workspace and refuses keys older than the policy
 * deadline, with HTTP 401 `api_key_policy_expired` and an audit entry so
 * owners can see exactly which key tripped the rule.
 *
 * Kept separate from lib/api-keys.ts so the key store stays free of any
 * next/server imports and remains usable from unit tests.
 */
import { NextResponse } from "next/server";
import { getWorkspace, apiKeyPolicyDeadline } from "./workspaces.ts";
import { tryRecordAudit } from "./audit.ts";

export async function enforceWorkspaceApiKeyPolicyForKey(
  req: Request,
  key: {
    id: string;
    workspaceId?: string;
    userId?: string;
    label?: string;
    createdAt: number;
  },
): Promise<Response | null> {
  if (!key.workspaceId) return null;
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return null;
  const deadline = apiKeyPolicyDeadline(ws, key.createdAt);
  if (deadline === null) return null;
  if (deadline > Date.now()) return null;

  const ageDays = Math.floor((Date.now() - key.createdAt) / (24 * 60 * 60 * 1000));
  void tryRecordAudit(req, {
    action: "workspace.api_key_policy_block",
    actorId: key.userId ?? null,
    workspaceId: ws.id,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: {
      ageDays,
      maxAgeDays: ws.apiKeyPolicy?.maxAgeDays,
      deadline,
    },
  });

  return NextResponse.json(
    {
      error: {
        type: "api_key_policy_expired",
        message:
          "This API key has exceeded the workspace maximum age policy. " +
          "Ask a workspace owner to rotate it (POST /api/api-keys/<id>/rotate) or issue a new one.",
        max_age_days: ws.apiKeyPolicy?.maxAgeDays ?? null,
        age_days: ageDays,
      },
    },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}
