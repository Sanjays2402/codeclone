/**
 * Workspace payload size policy enforcement for /v1 routes.
 *
 * Looked up via the API key's workspace binding. If the workspace has a
 * `payloadPolicy.maxBodyBytes` set, we check two things:
 *
 *   1. The inbound `Content-Length` header (when present). If it claims
 *      a body larger than the policy we 413 before parsing JSON, so the
 *      server never has to hold the payload in memory.
 *   2. The actual serialized byte size of the parsed JSON payload, as a
 *      defence-in-depth check for chunked requests where Content-Length
 *      is missing or understated.
 *
 * Both paths write a `v1.payload_blocked` audit entry tagged with the
 * route, claimed bytes, and the enforced limit so security teams can
 * spot abuse patterns. Returns a NextResponse on block, null on pass.
 */
import { NextResponse } from "next/server";
import { tryRecordAudit } from "./audit.ts";
import { getWorkspace, payloadPolicyLimit } from "./workspaces.ts";
import type { ApiKeyRecord } from "./api-keys.ts";

export interface PayloadPolicyContext {
  /** The route being protected, used as audit `meta.route`. */
  route: string;
}

/**
 * Pre-parse check using the inbound `Content-Length` header. Returns a
 * 413 response if the workspace policy is violated, otherwise null.
 * The `limit` is also returned so callers can run the post-parse check
 * without re-reading the workspace record.
 */
export async function enforcePayloadPolicyHeaderForKey(
  req: Request,
  key: ApiKeyRecord,
  ctx: PayloadPolicyContext,
): Promise<{ response: NextResponse | null; limit: number | null }> {
  if (!key.workspaceId) return { response: null, limit: null };
  const ws = await getWorkspace(key.workspaceId);
  const limit = payloadPolicyLimit(ws);
  if (!limit) return { response: null, limit: null };

  const cl = req.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > limit) {
      void tryRecordAudit(req, {
        action: "v1.payload_blocked",
        actorId: key.userId ?? null,
        workspaceId: key.workspaceId,
        target: { type: "api_key", id: key.id, label: key.label },
        status: "denied",
        meta: {
          route: ctx.route,
          claimedBytes: n,
          limitBytes: limit,
          source: "content-length",
        },
      });
      return { response: payloadTooLarge(limit, n), limit };
    }
  }
  return { response: null, limit };
}

/**
 * Post-parse check against the actual JSON body byte size. Call after
 * `enforcePayloadPolicyHeaderForKey` returned `{ response: null, limit }`
 * with the SAME `limit`. No-op when `limit` is null.
 */
export async function enforcePayloadPolicyBodyForKey(
  req: Request,
  key: ApiKeyRecord,
  body: unknown,
  limit: number | null,
  ctx: PayloadPolicyContext,
): Promise<NextResponse | null> {
  if (!limit) return null;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body) ?? "", "utf-8");
  } catch {
    return null;
  }
  if (bytes <= limit) return null;
  void tryRecordAudit(req, {
    action: "v1.payload_blocked",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "denied",
    meta: {
      route: ctx.route,
      claimedBytes: bytes,
      limitBytes: limit,
      source: "parsed-body",
    },
  });
  return payloadTooLarge(limit, bytes);
}

function payloadTooLarge(limit: number, claimed: number): NextResponse {
  return NextResponse.json(
    {
      error: {
        type: "payload_too_large",
        message:
          `Request body of ${claimed} bytes exceeds the workspace payload policy of ${limit} bytes. ` +
          `Ask a workspace owner to raise the limit in workspace settings, or split the request.`,
        limit_bytes: limit,
        claimed_bytes: claimed,
      },
    },
    { status: 413 },
  );
}
