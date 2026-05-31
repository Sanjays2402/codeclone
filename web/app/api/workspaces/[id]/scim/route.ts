/**
 * SCIM provisioning admin endpoints for a workspace.
 *
 * GET    returns whether SCIM is enabled, the token prefix + last-used,
 *        and a summary of provisioned users (owner only).
 * POST   { action: "issue" | "rotate" | "revoke" }
 *        Issues / rotates / revokes the per-workspace SCIM bearer token.
 *        Owner only. Plaintext token is returned exactly once on issue
 *        and rotate; revoke and subsequent GETs never return it again.
 *
 * Every action is audit-logged. Denied requests are logged too so an
 * owner reviewing the audit trail sees rejected admin attempts.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { getWorkspace, getActiveMember, canManage } from "../../../../../lib/workspaces";
import {
  issueScimToken,
  rotateScimToken,
  revokeScimToken,
  getScimTokenMeta,
} from "../../../../../lib/scim";
import fs from "node:fs/promises";
import path from "node:path";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCIM_DIR = process.env.CODECLONE_SCIM_DIR
  ? path.resolve(process.cwd(), process.env.CODECLONE_SCIM_DIR)
  : path.resolve(process.cwd(), "..", "scim");

async function countProvisionedUsers(workspaceId: string): Promise<number> {
  try {
    const names = await fs.readdir(path.join(SCIM_DIR, "users", workspaceId));
    return names.filter((n) => n.endsWith(".json")).length;
  } catch { return 0; }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/scim" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const meta = await getScimTokenMeta(id);
  const provisioned = await countProvisionedUsers(id);
  return NextResponse.json({
    enabled: !!meta,
    canEdit: canManage(ws, user.id),
    token: meta,
    provisionedUserCount: provisioned,
    endpoint: `/scim/v2/${id}`,
  });
}

interface PostBody { action?: unknown }

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/scim" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "scim.token_change",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PostBody = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "issue") {
    const existed = await getScimTokenMeta(id);
    if (existed) {
      return NextResponse.json({ error: "already_issued", hint: "use action=rotate" }, { status: 409 });
    }
    const issued = await issueScimToken({ workspaceId: id, createdBy: user.id });
    await tryRecordAudit(req, {
      action: "scim.token_issue",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { prefix: issued.record.prefix } },
    });
    return NextResponse.json({
      token: issued.plaintext,
      prefix: issued.record.prefix,
      createdAt: issued.record.createdAt,
    });
  }

  if (action === "rotate") {
    const rotated = await rotateScimToken({ workspaceId: id, rotatedBy: user.id });
    if (!rotated) return NextResponse.json({ error: "not_issued" }, { status: 404 });
    await tryRecordAudit(req, {
      action: "scim.token_rotate",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { prefix: rotated.record.prefix } },
    });
    return NextResponse.json({
      token: rotated.plaintext,
      prefix: rotated.record.prefix,
      createdAt: rotated.record.createdAt,
      rotatedAt: rotated.record.rotatedAt,
    });
  }

  if (action === "revoke") {
    const removed = await revokeScimToken(id);
    await tryRecordAudit(req, {
      action: "scim.token_revoke",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: removed ? "ok" : "error",
    });
    return NextResponse.json({ removed });
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}
