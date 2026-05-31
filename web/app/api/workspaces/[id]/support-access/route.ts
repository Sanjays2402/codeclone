/**
 * Just-in-time support access grants.
 *
 *   GET    /api/workspaces/:id/support-access         any active member
 *   POST   /api/workspaces/:id/support-access         owner + MFA step-up
 *                                                     body: { email, minutes, reason, caseRef? }
 *   DELETE /api/workspaces/:id/support-access?userId  owner + MFA step-up
 *
 * Each grant adds a viewer-role member with `status: "support"` and a hard
 * `expiresAt` (capped at 24h). The existing access gate `getActiveMember`
 * consults `isMemberActive` which honours the expiry, so support access
 * falls off automatically without a background job. Owners can revoke at
 * any time.
 *
 * Every placement, replacement, and revocation is recorded in the
 * tamper-evident audit chain so the workspace produces a defensible
 * "who entered our data, when, and why" timeline for SOC2 and DPA review.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  currentUserFromCookieHeader,
  currentSessionFromCookieHeader,
  findOrCreateUser,
  normalizeEmail,
} from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { requireStepUp } from "../../../../../lib/mfa";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  listSupportGrants,
  createSupportGrant,
  revokeSupportGrant,
  sanitizeSupportGrantInput,
  publicSupportGrant,
  SUPPORT_GRANT_MIN_MINUTES,
  SUPPORT_GRANT_MAX_MINUTES,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/support-access" },
  );
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    grants: listSupportGrants(ws),
    canEdit: canManage(ws, user.id),
    limits: {
      minMinutes: SUPPORT_GRANT_MIN_MINUTES,
      maxMinutes: SUPPORT_GRANT_MAX_MINUTES,
    },
  });
}

async function gateOwnerWithMfa(
  req: NextRequest,
  ws: { id: string; name: string },
  action: "workspace.support_grant_create" | "workspace.support_grant_revoke",
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  if (!canManage(ws as never, user.id)) {
    await tryRecordAudit(req, {
      action,
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return {
      user,
      error: NextResponse.json(
        { error: "forbidden", message: "Owner role required." },
        { status: 403 },
      ),
    };
  }
  const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, sess?.jti ?? null);
  if (!gate.allowed) {
    return {
      user,
      error: NextResponse.json(
        { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
        { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
      ),
    };
  }
  return { user };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/support-access" },
  );
  if (ipBlock) return ipBlock;
  // canManage + step-up gate. canManage also runs inside the helper but we
  // re-check up front so the 403 path doesn't waste an MFA round trip.
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.support_grant_create",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }
  const gated = await gateOwnerWithMfa(req, ws, "workspace.support_grant_create");
  if (gated.error) return gated.error;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // Normalize email up front so the sanitizer sees the same string we
  // persist; this also rejects malformed addresses with a precise error.
  const rawEmail = (body as { email?: unknown })?.email;
  const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : null;
  if (!email) {
    return NextResponse.json(
      { error: "invalid_input", message: "email is required and must be a valid address" },
      { status: 400 },
    );
  }
  const input = sanitizeSupportGrantInput({ ...(body as object), email });
  if (!input) {
    return NextResponse.json(
      {
        error: "invalid_input",
        message: `reason 3-500 chars, minutes ${SUPPORT_GRANT_MIN_MINUTES}-${SUPPORT_GRANT_MAX_MINUTES}, caseRef [A-Za-z0-9._-] up to 64 chars`,
      },
      { status: 400 },
    );
  }
  // Resolve the engineer's userId. findOrCreateUser is idempotent and only
  // creates the account row; it does not grant any access on its own.
  const target = await findOrCreateUser(email);
  if (target.id === user.id) {
    return NextResponse.json(
      { error: "self_grant", message: "Cannot grant support access to yourself." },
      { status: 400 },
    );
  }
  let result;
  try {
    result = await createSupportGrant(ws, { userId: target.id, email: target.email }, input, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "already_member") {
      return NextResponse.json(
        { error: "already_member", message: "That email already belongs to a permanent workspace member." },
        { status: 409 },
      );
    }
    throw e;
  }
  const grant = publicSupportGrant(result.member)!;
  await tryRecordAudit(req, {
    action: "workspace.support_grant_create",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "user", id: target.id, label: target.email },
    diff: {
      after: {
        email: target.email,
        expiresAt: grant.expiresAt,
        reason: grant.reason,
        caseRef: grant.caseRef,
        replaced: result.replaced,
      },
    },
  });
  return NextResponse.json({ grant }, { status: result.replaced ? 200 : 201 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/support-access" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.support_grant_revoke",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }
  const gated = await gateOwnerWithMfa(req, ws, "workspace.support_grant_revoke");
  if (gated.error) return gated.error;

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "invalid_input", message: "userId query param required" }, { status: 400 });
  }
  let removed;
  try {
    removed = (await revokeSupportGrant(ws, userId)).removed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "not_support_grant") {
      return NextResponse.json(
        { error: "not_support_grant", message: "Refusing to revoke a permanent member via the support console." },
        { status: 409 },
      );
    }
    throw e;
  }
  if (!removed) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await tryRecordAudit(req, {
    action: "workspace.support_grant_revoke",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "user", id: removed.userId, label: removed.email },
    diff: {
      before: {
        email: removed.email,
        expiresAt: removed.expiresAt ?? null,
        reason: removed.grantReason ?? "",
        caseRef: removed.grantCaseRef ?? null,
      },
    },
  });
  return NextResponse.json({ ok: true });
}
