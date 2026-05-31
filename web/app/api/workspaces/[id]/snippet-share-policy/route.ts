/**
 * Workspace snippet-share classification policy.
 *
 * GET  /api/workspaces/:id/snippet-share-policy
 *   Any active member: returns the current ceiling, the available
 *   levels, and whether the caller may edit it.
 *
 * PUT  /api/workspaces/:id/snippet-share-policy
 *   Owner / admin only. Body: { level: "public" | "internal" |
 *   "confidential" | "restricted" }. The level is the most-permissive
 *   classification that may be turned into an outbound share.
 *
 * DELETE /api/workspaces/:id/snippet-share-policy
 *   Owner / admin only. Clears the policy (falls back to the global
 *   default of "internal").
 *
 * Every mutation is audit-logged with a before/after diff. Runtime
 * enforcement happens via `decideSnippetShare` in
 * `lib/snippets-policy.ts`, consumed by /api/snippets/[id]/share-policy
 * and the snippets UI.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setSnippetMaxShareClassification,
} from "../../../../../lib/workspaces";
import {
  SNIPPET_CLASSIFICATIONS,
  SnippetClassification,
} from "../../../../../lib/snippets";
import {
  workspaceMaxShareClassification,
  DEFAULT_MAX_SHARE_CLASSIFICATION,
} from "../../../../../lib/snippets-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeLevel(input: unknown): SnippetClassification | null {
  if (typeof input !== "string") return null;
  const v = input.trim().toLowerCase();
  return (SNIPPET_CLASSIFICATIONS as readonly string[]).includes(v)
    ? (v as SnippetClassification)
    : null;
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
    { surface: "workspaces/snippet-share-policy" },
  );
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    level: workspaceMaxShareClassification(ws),
    defaultLevel: DEFAULT_MAX_SHARE_CLASSIFICATION,
    levels: SNIPPET_CLASSIFICATIONS,
    canEdit: canManage(ws, user.id),
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
    { surface: "workspaces/snippet-share-policy" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.snippet_share_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body treated as invalid */
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const level = sanitizeLevel(b.level);
  if (!level) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_policy",
          message: `Body must be { level: ${SNIPPET_CLASSIFICATIONS.map((m) => JSON.stringify(m)).join(" | ")} }.`,
        },
      },
      { status: 400 },
    );
  }
  const before = workspaceMaxShareClassification(ws);
  const updated = await setSnippetMaxShareClassification(ws, level);
  await tryRecordAudit(req, {
    action: "workspace.snippet_share_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { snippetMaxShareClassification: before },
      after: { snippetMaxShareClassification: level },
    },
  });
  return NextResponse.json({
    level: workspaceMaxShareClassification(updated),
    defaultLevel: DEFAULT_MAX_SHARE_CLASSIFICATION,
    levels: SNIPPET_CLASSIFICATIONS,
    canEdit: true,
  });
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
    { surface: "workspaces/snippet-share-policy" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = workspaceMaxShareClassification(ws);
  const updated = await setSnippetMaxShareClassification(ws, null);
  await tryRecordAudit(req, {
    action: "workspace.snippet_share_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { snippetMaxShareClassification: before },
      after: { snippetMaxShareClassification: DEFAULT_MAX_SHARE_CLASSIFICATION },
    },
  });
  return NextResponse.json({
    level: workspaceMaxShareClassification(updated),
    defaultLevel: DEFAULT_MAX_SHARE_CLASSIFICATION,
    levels: SNIPPET_CLASSIFICATIONS,
    canEdit: true,
  });
}
