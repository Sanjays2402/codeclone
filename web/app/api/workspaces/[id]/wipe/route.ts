/**
 * GDPR/DPA: workspace hard-delete.
 *
 *   POST /api/workspaces/:id/wipe   { confirm: "<workspace slug>" }
 *
 * Permanently removes the workspace and every record bound to it
 * (invites, scoped API keys, membership index entries). Audit history is
 * preserved (immutable storage); the wipe itself is recorded.
 *
 * Requires:
 *   - authenticated session
 *   - owner role on the target workspace
 *   - MFA step-up (verify at /api/auth/mfa/challenge first)
 *   - body.confirm exactly matches the workspace slug
 */
import { NextRequest, NextResponse } from "next/server";
import {
  currentUserFromCookieHeader,
  currentSessionFromCookieHeader,
} from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { requireStepUp } from "../../../../../lib/mfa";
import {
  getWorkspace,
  getMember,
  deleteWorkspace,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  confirm?: unknown;
  dry_run?: unknown;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const member = getMember(ws, user.id);
  if (!member || member.role !== "owner") {
    await tryRecordAudit(req, {
      action: "workspace.wipe",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body */
  }

  const url = new URL(req.url);
  const dryRun =
    body.dry_run === true ||
    body.dry_run === "true" ||
    url.searchParams.get("dry_run") === "true";

  if (typeof body.confirm !== "string" || body.confirm !== ws.slug) {
    return NextResponse.json(
      {
        error: "confirm_required",
        message: `Send {"confirm": "${ws.slug}"} to proceed.`,
      },
      { status: 400 },
    );
  }

  // MFA step-up gate (skipped for dry-run preview).
  if (!dryRun) {
    const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
    const gate = await requireStepUp(user.id, sess?.jti ?? null);
    if (!gate.allowed) {
      await tryRecordAudit(req, {
        action: "workspace.wipe",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace", id: ws.id, label: ws.name },
        status: "denied",
        meta: { reason: "mfa_required" },
      });
      return NextResponse.json(
        {
          error: "mfa_required",
          message: "Verify your MFA code at /api/auth/mfa/challenge first.",
        },
        { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
      );
    }
  }

  if (dryRun) {
    // Don't touch disk; report what would happen.
    const preview = {
      workspaceId: ws.id,
      wouldRemove: {
        members: ws.members.length,
        // We don't pre-count invites / keys here to keep the dry-run cheap;
        // the destructive call below returns exact counts when run for real.
      },
    };
    await tryRecordAudit(req, {
      action: "workspace.wipe",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      meta: { dry_run: true, preview },
    });
    return NextResponse.json({ ok: true, dry_run: true, ...preview });
  }

  const result = await deleteWorkspace(ws);

  await tryRecordAudit(req, {
    action: "workspace.wipe",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { name: ws.name, slug: ws.slug, members: ws.members.length } },
    meta: result,
  });

  return NextResponse.json({ ok: true, ...result });
}
