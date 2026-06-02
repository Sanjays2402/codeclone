/**
 * Programmatic workspace IP allowlist management.
 *
 *   GET    /v1/allowlist                    read the current CIDR list
 *   PUT    /v1/allowlist  { entries: [] }   replace the entire list
 *   POST   /v1/allowlist  { entries: [] }   append entries to the list
 *   DELETE /v1/allowlist                    clear the list (open access)
 *
 * Why this exists
 * ---------------
 * The dashboard already lets a workspace owner edit the IP allowlist by
 * hand at /workspaces/[id], but enterprise SecOps wires this into a
 * SOAR / IGA pipeline:
 *
 *   - Block an attacker IP within seconds of a SIEM alert (POST one CIDR).
 *   - Sync the corporate VPN egress block on a nightly cron (PUT the full
 *     authoritative list).
 *   - Take a workspace off the allowlist (DELETE) at the end of a
 *     red-team window so access falls back to open default.
 *   - Pull the current state into a compliance evidence collector
 *     (GET) for SOC2 CC6.6 quarterly review.
 *
 * None of that is reachable through the cookie-authenticated dashboard
 * route. This is the same Bearer-token surface every other /v1 endpoint
 * uses, and it is tenant-scoped to the calling key's workspace by
 * construction: the workspace id is taken from `key.workspaceId`, never
 * from a query string or body field, so a key in workspace A can never
 * touch workspace B's allowlist.
 *
 * Auth:  Bearer API key or `x-api-key` header.
 * Scope: `allowlist:read` for GET, `allowlist:write` for PUT/POST/DELETE.
 *        Legacy keys with no `scopes` field keep working (full
 *        privileges, matching every other /v1 route).
 * Owner: writes additionally require that the calling key's owning user
 *        is a current owner of the workspace. Keys minted without a
 *        `userId` (legacy or service keys) cannot write. This mirrors
 *        the dashboard rule (`canManage`) so SOAR scripts cannot privilege-
 *        escalate past the human policy. Reads are allowed for any
 *        active member.
 * Limits: at most 64 CIDR entries (matches `setIpAllowlist`). The
 *        sanitiser dedupes and rejects malformed inputs; rejected raw
 *        strings are echoed back so the SOAR script can alert on them
 *        instead of silently dropping rules. POST that would push the
 *        list past 64 returns 400 with `entries_over_limit`.
 *
 * Side effects: increments the per-key rate-limit window, writes a
 *        `v1.allowlist.{read,replace,append,clear}` audit row with
 *        before/after diffs, and updates the key's lastUsedAt /
 *        recentIps ring. Does not count toward the monthly /v1 plan
 *        quota (this is policy, not a billable model call).
 *
 * Still enforced: revocation, expiry, lockdown, workspace IP allowlist
 *        (yes, even on this route - if the caller is on a network the
 *        current allowlist blocks, they cannot get back in via the API),
 *        per-key IP allowlist, residency, workspace API key policy.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest, sanitizeCidrList, MAX_CIDR_ENTRIES } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import {
  getWorkspace,
  canManage,
  getActiveMember,
  setIpAllowlist,
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
          "The user that owns this API key is not an active owner of the workspace. Workspace IP allowlist changes require the same role as the dashboard editor.",
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

interface GateOk {
  key: Awaited<ReturnType<typeof findByPlaintext>> & object;
  rlHeaders: Record<string, string>;
  workspaceId: string;
}
type GateResult = { response: Response } | GateOk;

/**
 * Shared auth / scope / policy / residency / lockdown / allowlist / rate-limit
 * gate. `requiredScope` is either `allowlist:read` or `allowlist:write`. On
 * success returns the matched key plus rate-limit headers; on failure
 * returns a Response that the caller should hand back verbatim.
 */
async function gate(req: Request, requiredScope: "allowlist:read" | "allowlist:write"): Promise<GateResult> {
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
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/allowlist",
  });
  if (lockdownBlocked) return { response: lockdownBlocked };
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
  return { key, rlHeaders: rl.headers, workspaceId: key.workspaceId };
}

async function readJsonBody(req: Request, rlHeaders: Record<string, string>): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("application/json")) {
    // Empty body is acceptable for POST/PUT and treated as "no entries".
    return { ok: true, value: {} };
  }
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
    return { ok: true, value: JSON.parse(txt) };
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

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function allowlistToCsv(
  entries: ReadonlyArray<string>,
  workspaceId: string,
  enforced: boolean,
  generatedAt: number,
): string {
  // One row per CIDR entry. workspace_id + generated_at stamps every
  // row so a SOC2 reviewer collating quarterly evidence across many
  // workspaces can grep one column and a SIEM can ingest the file
  // without an out-of-band manifest. position preserves the order
  // the allowlist was configured in, which matters for downstream
  // diff tools comparing nightly snapshots.
  const header = [
    "workspace_id",
    "position",
    "cidr",
    "enforced",
    "generated_at",
  ];
  const lines: string[] = [header.join(",")];
  const stamp = new Date(generatedAt).toISOString();
  if (entries.length === 0) {
    // Empty allowlist is still meaningful evidence: it means open
    // access is in effect. Emit a single placeholder row so the file
    // is never silently empty when imported into Excel.
    lines.push(
      [
        csvCell(workspaceId),
        csvCell(0),
        csvCell(""),
        csvCell(enforced),
        csvCell(stamp),
      ].join(","),
    );
  } else {
    entries.forEach((cidr, i) => {
      lines.push(
        [
          csvCell(workspaceId),
          csvCell(i),
          csvCell(cidr),
          csvCell(enforced),
          csvCell(stamp),
        ].join(","),
      );
    });
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const g = await gate(req, "allowlist:read");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const url = new URL(req.url);
  const sp = url.searchParams;
  const formatRaw = sp.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Invalid 'format' value. Use 'json' (default) or 'csv'.",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) return notFound();
  // Membership check: reads are open to any active member, not just owners.
  // Keys without an owning user (legacy / service) still get read access
  // because they have already proven workspace binding via key.workspaceId.
  if (key.userId && !getActiveMember(ws, key.userId)) {
    return notOwner();
  }

  const entries = Array.isArray(ws.ipAllowlist) ? [...ws.ipAllowlist] : [];
  const enforced = entries.length > 0;

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.allowlist.read",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_ip_allowlist", id: workspaceId },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: entries.length,
      format,
    },
  });

  if (format === "csv") {
    const filenameWs = workspaceId;
    const csv = allowlistToCsv(entries, workspaceId, enforced, Date.now());
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rlHeaders,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-${filenameWs}-allowlist.csv"`,
      },
    });
  }

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      entries,
      count: entries.length,
      max_entries: MAX_CIDR_ENTRIES,
      enforced,
      server_time: Date.now(),
    },
    { headers: rlHeaders },
  );
}

async function requireOwner(req: Request, g: GateOk): Promise<{ ok: true; ws: NonNullable<Awaited<ReturnType<typeof getWorkspace>>> } | { ok: false; response: Response }> {
  const ws = await getWorkspace(g.workspaceId);
  if (!ws) return { ok: false, response: notFound() };
  // Writes mirror the dashboard rule: must be an active owner. A key
  // minted without a userId can never write, which is by design - SOAR
  // service keys should be created against an owner identity.
  if (!g.key.userId || !canManage(ws, g.key.userId)) {
    return { ok: false, response: notOwner() };
  }
  return { ok: true, ws };
}

function sanitizeOrError(raw: unknown, rlHeaders: Record<string, string>): { ok: true; clean: string[]; rejected: string[] } | { ok: false; response: Response } {
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: { type: "invalid_request", message: "`entries` must be an array of CIDR strings." } },
        { status: 400, headers: rlHeaders },
      ),
    };
  }
  const { ok, rejected } = sanitizeCidrList(raw ?? []);
  return { ok: true, clean: ok, rejected };
}

export async function PUT(req: Request) {
  const g = await gate(req, "allowlist:write");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const owner = await requireOwner(req, g);
  if (!owner.ok) return owner.response;
  const ws = owner.ws;

  const body = await readJsonBody(req, rlHeaders);
  if (!body.ok) return body.response;
  const input = (body.value as { entries?: unknown }).entries;
  const cleaned = sanitizeOrError(input, rlHeaders);
  if (!cleaned.ok) return cleaned.response;

  const before = Array.isArray(ws.ipAllowlist) ? [...ws.ipAllowlist] : [];
  await setIpAllowlist(ws, cleaned.clean);

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.allowlist.replace",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_ip_allowlist", id: workspaceId },
    diff: { before: { entries: before }, after: { entries: cleaned.clean } },
    meta: { prefix: key.prefix, rejected_count: cleaned.rejected.length },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      entries: cleaned.clean,
      count: cleaned.clean.length,
      max_entries: MAX_CIDR_ENTRIES,
      enforced: cleaned.clean.length > 0,
      rejected: cleaned.rejected,
      server_time: Date.now(),
    },
    { headers: rlHeaders },
  );
}

export async function POST(req: Request) {
  const g = await gate(req, "allowlist:write");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const owner = await requireOwner(req, g);
  if (!owner.ok) return owner.response;
  const ws = owner.ws;

  const body = await readJsonBody(req, rlHeaders);
  if (!body.ok) return body.response;
  const input = (body.value as { entries?: unknown }).entries;
  const cleaned = sanitizeOrError(input, rlHeaders);
  if (!cleaned.ok) return cleaned.response;

  const before = Array.isArray(ws.ipAllowlist) ? [...ws.ipAllowlist] : [];
  // Append, dedupe against existing, preserve existing order. We let the
  // sanitiser do per-batch dedupe; this loop handles cross-batch dedupe.
  const seen = new Set(before);
  const added: string[] = [];
  for (const cidr of cleaned.clean) {
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    added.push(cidr);
  }
  const merged = [...before, ...added];
  if (merged.length > MAX_CIDR_ENTRIES) {
    return NextResponse.json(
      {
        error: {
          type: "entries_over_limit",
          message: `Appending these entries would exceed the per-workspace limit of ${MAX_CIDR_ENTRIES}.`,
          current_count: before.length,
          would_add: added.length,
          max_entries: MAX_CIDR_ENTRIES,
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  await setIpAllowlist(ws, merged);

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.allowlist.append",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_ip_allowlist", id: workspaceId },
    diff: { before: { entries: before }, after: { entries: merged } },
    meta: { prefix: key.prefix, added_count: added.length, rejected_count: cleaned.rejected.length },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      entries: merged,
      count: merged.length,
      added,
      rejected: cleaned.rejected,
      max_entries: MAX_CIDR_ENTRIES,
      enforced: merged.length > 0,
      server_time: Date.now(),
    },
    { status: 201, headers: rlHeaders },
  );
}

export async function DELETE(req: Request) {
  const g = await gate(req, "allowlist:write");
  if ("response" in g) return g.response;
  const { key, rlHeaders, workspaceId } = g;

  const owner = await requireOwner(req, g);
  if (!owner.ok) return owner.response;
  const ws = owner.ws;

  const before = Array.isArray(ws.ipAllowlist) ? [...ws.ipAllowlist] : [];
  await setIpAllowlist(ws, []);

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.allowlist.clear",
    actorId: key.userId ?? key.id,
    workspaceId,
    target: { type: "workspace_ip_allowlist", id: workspaceId },
    diff: { before: { entries: before }, after: { entries: [] } },
    meta: { prefix: key.prefix, removed_count: before.length },
  });

  return NextResponse.json(
    {
      workspace_id: workspaceId,
      entries: [],
      count: 0,
      max_entries: MAX_CIDR_ENTRIES,
      enforced: false,
      server_time: Date.now(),
    },
    { headers: rlHeaders },
  );
}
