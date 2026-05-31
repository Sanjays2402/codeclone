/**
 * Runtime enforcement of the workspace break-glass lockdown on /v1.
 *
 * A workspace owner who suspects a key compromise, an active incident,
 * or an investigation requiring an immediate halt of programmatic
 * traffic can place a lockdown via POST /api/workspaces/:id/lockdown.
 * While the lockdown is active, every /v1 endpoint refuses calls whose
 * API key is bound to that workspace with HTTP 423 `workspace_locked`,
 * an audit entry tagged `workspace.lockdown_block`, and a structured
 * payload that names the reason and the recovery path. Dashboard
 * sessions keep working so the owner can lift the lockdown, rotate
 * keys, and inspect the audit trail.
 *
 * Legacy keys with no workspace binding are exempted so single-tenant
 * installs that never adopted workspaces keep working unchanged.
 *
 * Kept separate from lib/workspaces.ts so the pure logic stays free of
 * any next/server imports and remains usable from unit tests.
 */
import { NextResponse } from "next/server";
import { getWorkspace, isWorkspaceLocked } from "./workspaces.ts";
import { tryRecordAudit } from "./audit.ts";

export async function enforceWorkspaceLockdownForKey(
  req: Request,
  key: {
    id: string;
    workspaceId?: string;
    userId?: string;
    label?: string;
  },
  opts?: { route?: string },
): Promise<Response | null> {
  if (!key.workspaceId) return null;
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return null;
  if (!isWorkspaceLocked(ws)) return null;

  void tryRecordAudit(req, {
    action: "workspace.lockdown_block",
    actorId: key.userId ?? null,
    workspaceId: ws.id,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: {
      route: opts?.route ?? null,
      placedAt: ws.lockdown?.placedAt ?? null,
      placedBy: ws.lockdown?.placedBy ?? null,
      caseRef: ws.lockdown?.caseRef ?? null,
    },
  });

  return NextResponse.json(
    {
      error: {
        type: "workspace_locked",
        message:
          "This workspace is under an active break-glass lockdown. " +
          "A workspace owner must lift the lockdown at " +
          `/workspaces/${ws.id} before /v1 calls can proceed.`,
        placed_at: ws.lockdown?.placedAt ?? null,
        case_ref: ws.lockdown?.caseRef ?? null,
      },
    },
    { status: 423, headers: { "Retry-After": "3600" } },
  );
}
