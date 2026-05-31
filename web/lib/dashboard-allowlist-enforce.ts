/**
 * Dashboard / session-authenticated IP allowlist enforcement.
 *
 * Workspaces can pin a CIDR allowlist via Settings -> IP allowlist. Prior to
 * this module, that list was only enforced on API key traffic, leaving the
 * cookie-authenticated dashboard wide open. This module closes that gap so
 * an enterprise buyer can enforce "this workspace is only reachable from our
 * corporate egress" for the UI and for session-backed workspace management
 * endpoints, not just programmatic API key calls.
 *
 * Behavior:
 *   - If the workspace has no allowlist, allow.
 *   - If the request IP matches the allowlist, allow.
 *   - Otherwise, write a `workspace.ip_block` audit entry (channel:
 *     "dashboard") and return a 403 NextResponse the caller can short-circuit
 *     with.
 *
 * Lockout safety:
 *   - We never block the workspace allowlist edit endpoint itself. An owner
 *     who accidentally pins themselves out can still rewrite the list from
 *     wherever they happen to be (with audit trail intact). The endpoint is
 *     identified by the caller passing `kind: "allowlist_edit"`.
 */
import { evaluateAllowlist } from "./ip-allowlist.ts";
import { tryRecordAudit } from "./audit.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

export interface SessionGateOptions {
  /**
   * Stable label for the resource being accessed; surfaces in the audit
   * meta so owners can tell "blocked from the dashboard" apart from
   * "blocked from /api/workspaces/<id>/members".
   */
  surface: string;
  /**
   * When true, skip enforcement. Set this on the allowlist edit endpoint
   * itself so owners are never permanently locked out.
   */
  bypass?: boolean;
}

export interface SessionGateActor {
  id: string;
  email?: string | null;
}

export async function enforceWorkspaceAllowlistForSession(
  req: Request,
  ws: WorkspaceRecord,
  actor: SessionGateActor,
  opts: SessionGateOptions,
): Promise<Response | null> {
  if (opts.bypass) return null;
  const rules = Array.isArray(ws.ipAllowlist) ? ws.ipAllowlist : [];
  if (rules.length === 0) return null;
  const decision = evaluateAllowlist(req, rules);
  if (decision.allowed) return null;
  await tryRecordAudit(req, {
    action: "workspace.ip_block",
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    status: "denied",
    meta: {
      channel: "dashboard",
      surface: opts.surface,
      ip: decision.ip,
      reason: decision.reason,
      rules: decision.rules,
    },
  });
  return Response.json(
    {
      error: {
        type: "ip_not_allowed",
        message:
          "Your current IP is not on this workspace's allowlist. Ask an owner to add it, or connect from an approved network.",
        ip: decision.ip,
      },
    },
    { status: 403 },
  );
}
