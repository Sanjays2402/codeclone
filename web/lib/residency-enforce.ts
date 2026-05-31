/**
 * Per-workspace data residency enforcement for the public /v1 API.
 *
 * When a workspace owner pins their data to a region (us / eu / apac) and
 * flips the policy to `enforced: true`, any request served by a node whose
 * CODECLONE_REGION env does not match must be refused. We return HTTP 451
 * (Unavailable For Legal Reasons) which is the closest standard status to
 * "we are deliberately not serving this from here for compliance reasons"
 * and write a `workspace.residency_block` audit entry so the workspace
 * owner can see who tried, from which key, and which region pair.
 *
 * Non-enforced mismatches are still recorded as a `workspace.residency_warn`
 * audit so ops can see drift before flipping the policy to enforced.
 */
import { getWorkspace, residencyDecision, currentServingRegion } from "./workspaces.ts";
import { tryRecordAudit } from "./audit.ts";

export async function enforceWorkspaceResidencyForKey(
  req: Request,
  key: { id: string; workspaceId?: string; userId?: string; label?: string },
): Promise<Response | null> {
  if (!key.workspaceId) return null;
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return null;
  const decision = residencyDecision(ws);
  if (decision.match) return null;

  if (decision.enforced) {
    void tryRecordAudit(req, {
      action: "workspace.residency_block",
      actorId: key.userId ?? null,
      workspaceId: ws.id,
      target: { type: "api_key", id: key.id, label: key.label },
      status: "denied",
      meta: { pinned: decision.pinned, serving: decision.serving },
    });
    return new Response(
      JSON.stringify({
        error: {
          type: "residency_violation",
          message:
            `This workspace is pinned to region "${decision.pinned}" but the request hit a "${decision.serving}" node. Route traffic through the matching regional endpoint, or have a workspace owner widen the residency policy.`,
          pinned_region: decision.pinned,
          serving_region: decision.serving,
        },
      }),
      { status: 451, headers: { "content-type": "application/json" } },
    );
  }

  // Non-enforced mismatch: allow, but record a warning so the owner can see
  // drift in the audit log before they flip enforcement on.
  void tryRecordAudit(req, {
    action: "workspace.residency_warn",
    actorId: key.userId ?? null,
    workspaceId: ws.id,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "ok",
    meta: { pinned: decision.pinned, serving: decision.serving, enforced: false },
  });
  return null;
}

export { currentServingRegion };
