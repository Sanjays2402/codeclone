/**
 * Programmatic workspace break-glass lockdown.
 *
 *   GET    /v1/lockdown                            read current status
 *   POST   /v1/lockdown  { reason, caseRef? }      engage lockdown
 *   DELETE /v1/lockdown  { confirm: "<slug>" }     release lockdown
 *
 * Why this exists
 * ---------------
 * The dashboard at /workspaces/[id] already lets a workspace owner
 * place a break-glass lockdown by hand. While that lockdown is active,
 * every /v1 endpoint refuses calls bound to the workspace with HTTP
 * 423 `workspace_locked`. That covers the manual case.
 *
 * Enterprise SecOps wires this into a SIEM / SOAR pipeline:
 *
 *   - A Splunk / Sentinel rule fires on a credential-compromise
 *     signal and an automated playbook posts to /v1/lockdown to halt
 *     all programmatic traffic in seconds, no human in the loop.
 *   - A nightly compliance collector pulls GET /v1/lockdown into
 *     SOC2 CC7.3 incident-response evidence.
 *   - After the incident the same playbook posts DELETE to lift the
 *     lockdown with an audit-trail justification.
 *
 * None of that is reachable through the cookie-authenticated dashboard
 * route. This is the same Bearer-token surface every other /v1
 * endpoint uses, and it is tenant-scoped to the calling key's
 * workspace by construction: the workspace id is taken from
 * `key.workspaceId`, never from a query string or body field, so a
 * key in workspace A can never touch workspace B's lockdown state.
 *
 * Deliberate carve-out
 * --------------------
 * This route does NOT run the workspace lockdown enforcement gate that
 * every other /v1 route imports from lib/lockdown-enforce.ts. Every
 * other /v1 route does, and so blocks all traffic while the lockdown
 * is active. If this route did the same, a SOAR playbook could place
 * a lockdown but never lift it programmatically: the workspace would
 * be soft-bricked until an owner logged in through the dashboard.
 * The carve-out is explicit, narrow (this single route, three verbs,
 * all owner-gated, all audited), and is the same trade-off the
 * dashboard route makes for cookie sessions.
 *
 * Auth:  Bearer API key or `x-api-key` header.
 * Scope: `lockdown:read` for GET, `lockdown:write` for POST/DELETE.
 *        Legacy keys with no `scopes` field keep working (full
 *        privileges, matching every other /v1 route).
 * Owner: writes additionally require that the calling key's owning
 *        user is a current owner of the workspace. Keys minted
 *        without a `userId` (legacy / service) cannot write. Reads
 *        are allowed for any active member.
 *
 * Side effects: increments the per-key rate-limit window, writes a
 *        `v1.lockdown.{read,place,release}` audit row with
 *        before/after diffs on writes, and updates the key's
 *        lastUsedAt / recentIps ring. Does not count toward the
 *        monthly /v1 plan quota (this is policy, not a billable
 *        model call).
 *
 * Still enforced (even on this route): revocation, expiry, workspace
 *        IP allowlist, per-key IP allowlist, residency, workspace API
 *        key policy, per-key rate limit. Lockdown enforcement itself
 *        is the only intentional skip.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import {
  getWorkspace,
  canManage,
  getActiveMember,
  isWorkspaceLocked,
  placeLockdown,
  releaseLockdown,
  sanitizeLockdown,
  type WorkspaceRecord,
} from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function insufficientScope(required: string, granted: string[] | null | undefined) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${required}' scope.`,
        required_scope: required,
        granted_scopes: granted ?? null,
      },
    },
    { status: 403 },
  );
}

function tenantRequired() {
  return NextResponse.json(
    {
      error: {
        type: "tenant_required",
        message: "This API key is not bound to a workspace.",
      },
    },
    { status: 403 },
  );
}

function notOwner() {
  return NextResponse.json(
    {
      error: {
        type: "forbidden",
        message:
          "The user that owns this API key is not an active owner of the workspace. Lockdown changes require the same role as the dashboard editor.",
      },
    },
    { status: 403 },
  );
}

function notMember() {
  return NextResponse.json(
    {
      error: {
        type: "forbidden",
        message:
          "The user that owns this API key is not an active member of the workspace.",
      },
    },
    { status: 403 },
  );
}

function notFound() {
  return NextResponse.json(
    { error: { type: "not_found", message: "Workspace not found." } },
    { status: 404 },
  );
}

function publicLockdown(ws: WorkspaceRecord) {
  if (!ws.lockdown) return null;
  return {
    active: true as const,
    reason: ws.lockdown.reason,
    case_ref: ws.lockdown.caseRef ?? null,
    placed_at: ws.lockdown.placedAt,
    placed_by: ws.lockdown.placedBy,
  };
}

interface GateOk {
  key: NonNullable<Awaited<ReturnType<typeof findByPlaintext>>>;
  rlHeaders: Record<string, string>;
  workspaceId: string;
}
type GateResult = { response: Response } | GateOk;

/**
 * Shared auth / scope / policy / residency / allowlist / rate-limit gate.
 * NOTE: deliberately omits the workspace lockdown enforcement gate so
 * that an
 * owner with a write-scoped key can release an active lockdown. See the
 * file header for the rationale.
 */
async function gate(
  req: Request,
  requiredScope: "lockdown:read" | "lockdown:write",
  route: string,
): Promise<GateResult> {
  const token = extractBearer(req);
  if (!token) {
    return {
      response: unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'."),
    };
  }
  const key = await findByPlaintext(token);
  if (!key) return { response: unauthorized("Invalid or revoked API key.") };
  if (!hasScope(key, requiredScope)) {
    return { response: insufficientScope(requiredScope, key.scopes) };
  }
  // No workspace lockdown gate here. See file header.
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return { response: wsBlocked };
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return { response: keyBlocked };
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return { response: residencyBlocked };
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return { response: policyBlocked };
  const rl = await enforceRateLimit(key);
  if (rl.response) return { response: rl.response };
  if (!key.workspaceId) return { response: tenantRequired() };
  void route;
  return { key, rlHeaders: rl.headers, workspaceId: key.workspaceId };
}

async function readJsonBody(
  req: Request,
  rlHeaders: Record<string, string>,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("application/json")) return { ok: true, value: {} };
  let txt: string;
  try {
    txt = await req.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: { type: "invalid_body", message: "Could not read request body." } },
        { status: 400, headers: rlHeaders },
      ),
    };
  }
  if (txt.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { type: "invalid_body", message: "Body must be a JSON object." } },
          { status: 400, headers: rlHeaders },
        ),
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: { type: "invalid_body", message: "Body must be valid JSON when content-type is application/json." } },
        { status: 400, headers: rlHeaders },
      ),
    };
  }
}

export async function GET(req: Request) {
  const g = await gate(req, "lockdown:read", "/v1/lockdown");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const ws = await getWorkspace(workspaceId);
  if (!ws) return notFound();
  if (key.userId && !getActiveMember(ws, key.userId)) {
    return notMember();
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.lockdown.read",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_lockdown", id: workspaceId },
    status: "ok",
    meta: { prefix: key.prefix, locked: isWorkspaceLocked(ws) },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      locked: isWorkspaceLocked(ws),
      lockdown: publicLockdown(ws),
      server_time: Date.now(),
    },
    { headers: rlHeaders },
  );
}

async function requireOwner(g: GateOk): Promise<
  { ok: true; ws: WorkspaceRecord } | { ok: false; response: Response }
> {
  const ws = await getWorkspace(g.workspaceId);
  if (!ws) return { ok: false, response: notFound() };
  if (!g.key.userId || !canManage(ws, g.key.userId)) {
    return { ok: false, response: notOwner() };
  }
  return { ok: true, ws };
}

export async function POST(req: Request) {
  const g = await gate(req, "lockdown:write", "/v1/lockdown");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const owner = await requireOwner(g);
  if (!owner.ok) {
    void tryRecordAudit(req, {
      action: "v1.lockdown.place",
      actorId: key.userId ?? key.id,
      workspaceId,
      target: { type: "workspace_lockdown", id: workspaceId },
      status: "denied",
      meta: { prefix: key.prefix, reason: "owner_required" },
    });
    return owner.response;
  }
  const ws = owner.ws;

  if (isWorkspaceLocked(ws)) {
    return NextResponse.json(
      {
        error: {
          type: "already_locked",
          message: "Workspace is already under an active lockdown.",
        },
        lockdown: publicLockdown(ws),
      },
      { status: 409, headers: rlHeaders },
    );
  }

  const body = await readJsonBody(req, rlHeaders);
  if (!body.ok) return body.response;
  const input = sanitizeLockdown(body.value);
  if (!input) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_input",
          message:
            "reason must be 3 to 500 chars; optional caseRef <= 120 chars [A-Za-z0-9 _-./#:].",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  const updated = await placeLockdown(ws, input, key.userId ?? key.id);

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.lockdown.place",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_lockdown", id: workspaceId },
    diff: {
      before: { lockdown: null },
      after: {
        lockdown: {
          reason: input.reason,
          caseRef: input.caseRef ?? null,
        },
      },
    },
    meta: { prefix: key.prefix },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      locked: true,
      lockdown: publicLockdown(updated),
      server_time: Date.now(),
    },
    { status: 201, headers: rlHeaders },
  );
}

export async function DELETE(req: Request) {
  const g = await gate(req, "lockdown:write", "/v1/lockdown");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const owner = await requireOwner(g);
  if (!owner.ok) {
    void tryRecordAudit(req, {
      action: "v1.lockdown.release",
      actorId: key.userId ?? key.id,
      workspaceId,
      target: { type: "workspace_lockdown", id: workspaceId },
      status: "denied",
      meta: { prefix: key.prefix, reason: "owner_required" },
    });
    return owner.response;
  }
  const ws = owner.ws;

  if (!isWorkspaceLocked(ws)) {
    return NextResponse.json(
      {
        error: {
          type: "not_locked",
          message: "Workspace is not under a lockdown.",
        },
      },
      { status: 409, headers: rlHeaders },
    );
  }

  const body = await readJsonBody(req, rlHeaders);
  if (!body.ok) return body.response;
  const confirm = body.value.confirm;
  if (typeof confirm !== "string" || confirm !== ws.slug) {
    return NextResponse.json(
      {
        error: {
          type: "confirm_required",
          message: `Send {"confirm": "${ws.slug}"} to lift the lockdown.`,
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  const before = {
    reason: ws.lockdown?.reason ?? null,
    caseRef: ws.lockdown?.caseRef ?? null,
    placedAt: ws.lockdown?.placedAt ?? null,
    placedBy: ws.lockdown?.placedBy ?? null,
  };
  const updated = await releaseLockdown(ws);

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.lockdown.release",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_lockdown", id: workspaceId },
    diff: { before: { lockdown: before }, after: { lockdown: null } },
    meta: { prefix: key.prefix },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      locked: false,
      lockdown: publicLockdown(updated),
      server_time: Date.now(),
    },
    { headers: rlHeaders },
  );
}
