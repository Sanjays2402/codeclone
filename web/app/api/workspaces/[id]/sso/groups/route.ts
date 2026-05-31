/**
 * Workspace SSO group-to-role mapping.
 *
 * GET    /api/workspaces/:id/sso/groups
 *   Members read the configured groupClaim + mappings (whatever
 *   publicSsoConfig exposes). Plus canEdit so the UI can render a
 *   read-only view for non-owners.
 *
 * PUT    /api/workspaces/:id/sso/groups
 *   Owner only. Body: { groupClaim: string, groupMappings: [{group, role}] }.
 *   The SSO config itself must already exist; the group policy lives on
 *   top of it. Each mutation is audited with a before/after diff so a
 *   procurement reviewer can reconstruct exactly which IdP group ever
 *   mapped to which codeclone role.
 *
 * DELETE /api/workspaces/:id/sso/groups
 *   Owner only. Clears the group policy (claim + mappings). The SSO
 *   sign-in flow keeps working; no role sync happens after this.
 *
 * RBAC is enforced via canManage; IP allowlist via the dashboard
 * enforcer that wraps every workspace surface. The same actor + diff
 * conventions used by the parent SSO route are reused here.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setSsoGroupMappings,
  SSO_GROUP_MAPPINGS_MAX,
  SSO_GROUP_NAME_MAX,
  SSO_GROUP_CLAIM_MAX,
  type WorkspaceRecord,
} from "../../../../../../lib/workspaces";
import { publicSsoConfig } from "../../../../../../lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PutBody {
  groupClaim?: unknown;
  groupMappings?: unknown;
}

function snapshot(cfg: WorkspaceRecord["sso"]) {
  if (!cfg) return null;
  return {
    groupClaim: cfg.groupClaim ?? "",
    groupMappings: Array.isArray(cfg.groupMappings)
      ? cfg.groupMappings.map((m) => ({ group: m.group, role: m.role }))
      : [],
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/sso/groups" },
  );
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sso = publicSsoConfig(ws);
  return NextResponse.json({
    sso,
    canEdit: canManage(ws, user.id),
    ssoConfigured: Boolean(ws.sso),
    limits: {
      maxMappings: SSO_GROUP_MAPPINGS_MAX,
      maxGroupNameLength: SSO_GROUP_NAME_MAX,
      maxClaimNameLength: SSO_GROUP_CLAIM_MAX,
    },
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/sso/groups" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.sso_groups_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!ws.sso) {
    return NextResponse.json({ error: "sso_not_configured" }, { status: 409 });
  }
  let body: PutBody = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const claim = typeof body.groupClaim === "string" ? body.groupClaim : "";
  const mappings = Array.isArray(body.groupMappings) ? body.groupMappings : [];
  if (mappings.length > SSO_GROUP_MAPPINGS_MAX) {
    return NextResponse.json(
      { error: "too_many_mappings", maxMappings: SSO_GROUP_MAPPINGS_MAX },
      { status: 400 },
    );
  }
  const before = snapshot(ws.sso);
  let updated: WorkspaceRecord;
  try {
    updated = await setSsoGroupMappings(ws, {
      groupClaim: claim,
      groupMappings: mappings as Array<{ group: unknown; role: unknown }>,
      actorId: user.id,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "save_failed";
    return NextResponse.json({ error: reason }, { status: 400 });
  }
  const after = snapshot(updated.sso);
  await tryRecordAudit(req, {
    action: "workspace.sso_groups_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before, after },
  });
  return NextResponse.json({ sso: publicSsoConfig(updated) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/sso/groups" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.sso_groups_delete",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!ws.sso) {
    return NextResponse.json({ error: "sso_not_configured" }, { status: 409 });
  }
  const before = snapshot(ws.sso);
  const updated = await setSsoGroupMappings(ws, {
    groupClaim: "",
    groupMappings: [],
    actorId: user.id,
  });
  const after = snapshot(updated.sso);
  await tryRecordAudit(req, {
    action: "workspace.sso_groups_delete",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before, after },
  });
  return NextResponse.json({ ok: true, sso: publicSsoConfig(updated) });
}
