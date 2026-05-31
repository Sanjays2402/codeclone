/**
 * Workspace SSO (OIDC) configuration.
 *
 * GET  /api/workspaces/:id/sso
 *   Members read the redacted config (clientSecret is never returned;
 *   only `clientSecretSet: boolean`). Plus `canEdit` and the start URL.
 *
 * PUT  /api/workspaces/:id/sso
 *   Owner only. Body: { issuer, clientId, clientSecret?, allowedDomain,
 *   enforced } - clientSecret is optional on update (kept if omitted).
 *   The issuer must publish /.well-known/openid-configuration; we fetch
 *   and validate it before saving so admins fail fast on typos.
 *
 * DELETE /api/workspaces/:id/sso
 *   Owner only. Clears the config and disables enforcement.
 *
 * Every mutation lands in the audit log; the clientSecret is redacted
 * out of diffs.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getMember,
  canManage,
  setSsoConfig,
  type WorkspaceRecord,
} from "../../../../../lib/workspaces";
import {
  publicSsoConfig,
  normalizeIssuer,
  normalizeDomain,
  discover,
} from "../../../../../lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function startUrl(origin: string, wsId: string): string {
  return `${origin}/api/auth/sso/${wsId}/start`;
}
function callbackUrl(origin: string, wsId: string): string {
  return `${origin}/api/auth/sso/${wsId}/callback`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!getMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const origin = new URL(req.url).origin;
  return NextResponse.json({
    sso: publicSsoConfig(ws),
    canEdit: canManage(ws, user.id),
    startUrl: ws.sso ? startUrl(origin, ws.id) : null,
    callbackUrl: callbackUrl(origin, ws.id),
  });
}

interface PutBody {
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  allowedDomain?: unknown;
  enforced?: unknown;
}

function diffForAudit(before: WorkspaceRecord["sso"], after: WorkspaceRecord["sso"]) {
  function redact(c: WorkspaceRecord["sso"]) {
    if (!c) return null;
    return { ...c, clientSecret: c.clientSecret ? "[redacted]" : "" };
  }
  return { before: redact(before), after: redact(after) };
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.sso_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PutBody = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const issuer = normalizeIssuer(body.issuer);
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const allowedDomain = normalizeDomain(body.allowedDomain);
  const enforced = Boolean(body.enforced);
  const incomingSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";

  if (!issuer) return NextResponse.json({ error: "invalid_issuer" }, { status: 400 });
  if (!clientId || clientId.length > 256) return NextResponse.json({ error: "invalid_client_id" }, { status: 400 });
  if (!allowedDomain) return NextResponse.json({ error: "invalid_domain" }, { status: 400 });

  const clientSecret = incomingSecret || ws.sso?.clientSecret || "";
  if (!clientSecret || clientSecret.length > 1024) {
    return NextResponse.json({ error: "client_secret_required" }, { status: 400 });
  }

  // Validate the issuer publishes a usable discovery doc before saving.
  // Allow a skip flag for tests / offline / dev fakes.
  if (process.env.CODECLONE_SSO_SKIP_DISCOVERY !== "1") {
    try { await discover(issuer); }
    catch (e) {
      const msg = e instanceof Error ? e.message : "discovery_failed";
      return NextResponse.json({ error: "discovery_failed", detail: msg }, { status: 400 });
    }
  }

  const before = ws.sso ?? null;
  const after: WorkspaceRecord["sso"] = {
    provider: "oidc",
    issuer,
    clientId,
    clientSecret,
    allowedDomain,
    enforced,
    updatedAt: Date.now(),
    updatedBy: user.id,
  };
  await setSsoConfig(ws, after);
  await tryRecordAudit(req, {
    action: "workspace.sso_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: diffForAudit(before, after),
  });
  const origin = new URL(req.url).origin;
  return NextResponse.json({
    sso: publicSsoConfig(ws),
    startUrl: startUrl(origin, ws.id),
    callbackUrl: callbackUrl(origin, ws.id),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.sso_delete",
      actorId: user.id, actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.sso ?? null;
  await setSsoConfig(ws, null);
  await tryRecordAudit(req, {
    action: "workspace.sso_delete",
    actorId: user.id, actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: diffForAudit(before, null),
  });
  return NextResponse.json({ ok: true });
}
