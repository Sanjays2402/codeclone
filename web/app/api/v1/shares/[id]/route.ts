/**
 * Public /v1/shares/[id] endpoint.
 *
 * Authenticated via Bearer token (or x-api-key header). Requires the
 * `shares:read` scope. Returns the full saved comparison record,
 * including both snippets, scores, alignment, and clone classification,
 * so customers can render their own diff views or pipe results into
 * code-review tooling.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../../lib/ip-allowlist-enforce";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { loadShare } from "../../../../../lib/share";
import { logUsage } from "../../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }
  if (!hasScope(key, "shares:read")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message:
            "This key is missing the 'shares:read' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "shares:read",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await ctx.params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid share id." } },
      { status: 400 },
    );
  }

  try {
    const rec = await loadShare(id);
    if (!rec) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Share not found." } },
        { status: 404 },
      );
    }

    void recordUse(key.id);
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/shares/[id]",
      bytes: 0,
      latencyMs: 0,
    });

    return NextResponse.json({
      id: rec.id,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt ?? null,
      language: rec.language,
      title: rec.title ?? null,
      tags: rec.tags ?? [],
      a: rec.a,
      b: rec.b,
      result: rec.result,
      url: `/r/${rec.id}`,
    }, { headers: rl.headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "internal_error", message: msg } },
      { status: 500 },
    );
  }
}
