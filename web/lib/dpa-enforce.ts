/**
 * Runtime enforcement of the workspace DPA acceptance gate on /v1.
 *
 * A workspace must have a current-version DPA acceptance recorded
 * before any /v1 endpoint that processes customer code will run. We
 * resolve the workspace from the presented API key, evaluate the
 * acceptance against `DPA_CURRENT_VERSION`, and on miss return HTTP 403
 * with a structured `dpa_required` error and an audit entry so the
 * customer's security team can see exactly which key tripped the rule.
 *
 * Legacy keys with no workspace binding are exempted so single-tenant
 * installs that never adopted workspaces keep working unchanged.
 *
 * Kept separate from lib/dpa.ts so the pure logic stays free of any
 * next/server imports and remains usable from unit tests.
 */
import { NextResponse } from "next/server";
import { getWorkspace } from "./workspaces.ts";
import { evaluateDpa, DPA_CURRENT_VERSION } from "./dpa.ts";
import { tryRecordAudit } from "./audit.ts";

export async function enforceWorkspaceDpaForKey(
  req: Request,
  key: {
    id: string;
    workspaceId?: string;
    userId?: string;
    label?: string;
  },
  opts?: { route?: string },
): Promise<Response | null> {
  if (!key.workspaceId) return null;
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return null;
  const status = evaluateDpa(ws);
  if (!status.required) return null;

  void tryRecordAudit(req, {
    action: "workspace.dpa_block",
    actorId: key.userId ?? null,
    workspaceId: ws.id,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: {
      route: opts?.route ?? null,
      currentVersion: DPA_CURRENT_VERSION,
      pinnedVersion: status.acceptance?.version ?? null,
      stale: status.stale,
    },
  });

  return NextResponse.json(
    {
      error: {
        type: "dpa_required",
        message:
          "This workspace has not accepted the current Data Processing " +
          "Agreement. A workspace owner must accept version " +
          `${DPA_CURRENT_VERSION} at /workspaces/${ws.id}/dpa before /v1 ` +
          "calls can proceed.",
        current_version: DPA_CURRENT_VERSION,
        pinned_version: status.acceptance?.version ?? null,
      },
    },
    { status: 403 },
  );
}
