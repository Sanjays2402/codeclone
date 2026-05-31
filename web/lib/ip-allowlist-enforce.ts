/**
 * Next.js-coupled helper for enforcing a workspace IP allowlist on routes
 * that resolve an API key. Kept separate from lib/ip-allowlist.ts so the
 * pure CIDR module can be unit-tested without pulling next/server.
 */
import { NextResponse } from "next/server";
import { evaluateAllowlist, evaluateKeyAllowlist, clientIpFromRequest } from "./ip-allowlist.ts";
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

/**
 * Per-API-key source IP allowlist. Independent of (and stricter than)
 * the workspace allowlist: even if the workspace is open, a key with
 * its own ipAllowlist set can only be used from those CIDRs. This is
 * what enterprise security teams ask for when they want a specific
 * CI runner or production NAT to be the ONLY caller for a given key.
 *
 * Empty or missing ipAllowlist means the check is skipped (open). The
 * deny path emits an `api_key.ip_block` audit entry so SOC2 reviewers
 * can correlate a 403 to the specific key and source IP.
 */
export async function enforceKeyAllowlist(
  req: Request,
  key: { id: string; userId?: string; workspaceId?: string; label?: string; ipAllowlist?: string[] },
): Promise<Response | null> {
  const list = Array.isArray(key.ipAllowlist) ? key.ipAllowlist : [];
  if (list.length === 0) return null;
  const decision = evaluateKeyAllowlist(req, list);
  if (decision.allowed) return null;
  const ip = decision.ip ?? clientIpFromRequest(req);
  void tryRecordAudit(req, {
    action: "api_key.ip_block",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: { ip, reason: decision.reason, rules: decision.rules },
  });
  return NextResponse.json(
    {
      error: {
        type: "ip_not_allowed",
        message:
          "This API key is locked to a specific source IP allowlist and your IP is not on it. Update the key's allowlist or call from a permitted address.",
        ip,
      },
    },
    { status: 403 },
  );
}
