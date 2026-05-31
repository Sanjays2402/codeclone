import { NextRequest, NextResponse } from "next/server";
import { collectRecentFailures } from "../../../../lib/recent-failures";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { getWorkspace, getActiveMember } from "../../../../lib/workspaces";
import { validateWorkspaceId } from "../../../../lib/webhooks";

export const dynamic = "force-dynamic";

/**
 * Workspace-scoped failure aggregation used by the in-app toaster.
 *
 * Returns the most recent failed webhook delivery attempts for the
 * caller's workspace, newest first. Cross-tenant access returns 403.
 *
 * Query params:
 *   workspaceId  required
 *   limit        optional integer, 1..100, default 25
 *   since        optional ms epoch
 */
export async function GET(req: NextRequest) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in to view failures." } },
      { status: 401 },
    );
  }
  const url = new URL(req.url);
  const wsId = validateWorkspaceId(url.searchParams.get("workspaceId"));
  if (!wsId) {
    return NextResponse.json(
      { error: { type: "invalid_workspace", message: "A valid workspaceId query parameter is required." } },
      { status: 400 },
    );
  }
  const ws = await getWorkspace(wsId);
  if (!ws || !getActiveMember(ws, user.id)) {
    return NextResponse.json(
      { error: { type: "forbidden", message: "You are not a member of that workspace." } },
      { status: 403 },
    );
  }
  const limitRaw = url.searchParams.get("limit");
  const sinceRaw = url.searchParams.get("since");
  const limit = limitRaw === null ? undefined : parseInt(limitRaw, 10);
  const since = sinceRaw === null ? undefined : parseInt(sinceRaw, 10);
  const items = await collectRecentFailures({ limit, since, workspaceId: wsId });
  return NextResponse.json({ items, workspaceId: wsId });
}
