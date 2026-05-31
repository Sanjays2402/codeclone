/**
 * Next.js-coupled helper for enforcing a workspace IP allowlist on routes
 * that resolve an API key. Kept separate from lib/ip-allowlist.ts so the
 * pure CIDR module can be unit-tested without pulling next/server.
 */
import { NextResponse } from "next/server";
import { evaluateAllowlist } from "./ip-allowlist.ts";
import { getWorkspace } from "./workspaces.ts";
import { tryRecordAudit } from "./audit.ts";

/**
 * If the API key is bound to a workspace, enforce that workspace's IP
 * allowlist. Returns a NextResponse to short-circuit on deny, or null
 * when the request is allowed (or the key has no workspace binding).
 *
 * On denial, writes a `workspace.ip_block` audit entry so the workspace
 * owner can see who was blocked, from which IP, and which key tried.
 */
export async function enforceWorkspaceAllowlistForKey(
  req: Request,
  key: { id: string; workspaceId?: string; userId?: string; label?: string },
): Promise<Response | null> {
  if (!key.workspaceId) return null;
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return null;
  const decision = evaluateAllowlist(req, ws.ipAllowlist);
  if (decision.allowed) return null;
  void tryRecordAudit(req, {
    action: "workspace.ip_block",
    actorId: key.userId ?? null,
    workspaceId: ws.id,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: { ip: decision.ip, reason: decision.reason, rules: decision.rules },
  });
  return NextResponse.json(
    {
      error: {
        type: "ip_not_allowed",
        message:
          "Your IP is not on this workspace's allowlist. Ask a workspace owner to add it under Settings.",
        ip: decision.ip,
      },
    },
    { status: 403 },
  );
}
