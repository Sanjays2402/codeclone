import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { loadSnippet } from "../../../../../lib/snippets";
import { listWorkspacesForUser } from "../../../../../lib/workspaces";
import { decideSnippetShare } from "../../../../../lib/snippets-policy";

export const dynamic = "force-dynamic";

/**
 * GET /api/snippets/:id/share-policy
 *
 * Returns the decision (allowed | blocked) for turning this snippet
 * into an outbound share, given the workspace's snippet classification
 * ceiling. The UI calls this to enable/disable the "Share" affordance
 * and to surface the reason inline. Any future server-side share or
 * PDF-export path that originates from a saved snippet MUST consult
 * `decideSnippetShare` directly so the UI cannot be bypassed.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const rec = await loadSnippet(user.id, id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  const workspaces = await listWorkspacesForUser(user.id);
  const decision = decideSnippetShare(rec, workspaces);
  return NextResponse.json({
    snippetId: rec.id,
    title: rec.title,
    ...decision,
  });
}
