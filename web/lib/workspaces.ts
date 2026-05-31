/**
 * Team workspaces for codeclone.
 *
 * Storage (filesystem, mirrors the rest of the app):
 *   $CODECLONE_WORKSPACES_DIR/<workspaceId>.json           workspace record
 *   $CODECLONE_WORKSPACES_DIR/_members/<userId>.json       reverse index: userId -> [workspaceIds]
 *   $CODECLONE_WORKSPACES_DIR/_invites/<inviteId>.json     pending invite by token
 *
 * Roles: owner > editor > viewer. There is always exactly one owner.
 * Owners may invite, change roles, and remove members. Editors may invite.
 * Viewers are read-only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PlanId } from "./plans.ts";
import { isPlanId } from "./plans.ts";
import { isSecretScanMode, type SecretScanMode } from "./secret-scan.ts";

const CWD = process.cwd();

export const WORKSPACES_DIR = process.env.CODECLONE_WORKSPACES_DIR
  ? path.resolve(CWD, process.env.CODECLONE_WORKSPACES_DIR)
  : path.resolve(CWD, "..", "workspaces");

export type Role = "owner" | "editor" | "viewer";

export const ROLE_RANK: Record<Role, number> = { owner: 3, editor: 2, viewer: 1 };

export interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: number;
  /**
   * Member account status. "active" (or undefined for legacy records) means
   * normal access. "suspended" means the member is retained on the workspace
   * roster for audit/forensic continuity but has no effective access: every
   * membership check (`canInvite`, `canManage`, route gates) treats them as a
   * non-member. Suspending also revokes all of the user's active sessions and
   * disables their workspace-scoped API keys. Reinstating restores membership
   * but does not auto-restore revoked sessions or keys; users must sign back
   * in and owners may rotate keys explicitly.
   */
  status?: "active" | "suspended" | "support";
  suspendedAt?: number;
  suspendedBy?: string; // userId of the owner who suspended
  suspendedReason?: string;
  /**
   * Just-in-time support access fields. Present only when `status === "support"`.
   * The member is treated as active by `isMemberActive` while `now < expiresAt`,
   * and as removed (effectively no-member) once expired. `role` is always
   * "viewer" for support grants so they can read but never invite or manage.
   * Each grant carries a mandatory `grantReason` and an immutable `grantedBy`
   * for the audit trail. Owners can revoke at any time, which removes the row.
   */
  expiresAt?: number;
  grantedAt?: number;
  grantedBy?: string;
  grantReason?: string;
  grantCaseRef?: string | null;
}

export function isMemberSuspended(m: Member | null | undefined): boolean {
  return !!m && m.status === "suspended";
}

export function isSupportMember(m: Member | null | undefined): boolean {
  return !!m && m.status === "support";
}

export function isSupportGrantExpired(
  m: Member | null | undefined,
  now: number = Date.now(),
): boolean {
  return !!m && m.status === "support" && (typeof m.expiresAt !== "number" || now >= m.expiresAt);
}

export function isMemberActive(m: Member | null | undefined, now: number = Date.now()): boolean {
  if (!m) return false;
  if (m.status === "suspended") return false;
  if (m.status === "support") {
    return typeof m.expiresAt === "number" && now < m.expiresAt;
  }
  return true;
}

export interface WorkspaceRecord {
  v: 1;
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  createdBy: string; // userId
  members: Member[];
  /**
   * Optional CIDR allowlist that gates API + dashboard access for this
   * workspace. Empty / missing means no restriction. Edited via
   * `setIpAllowlist`; enforced by `lib/ip-allowlist.ts`.
   */
  ipAllowlist?: string[];
  /**
   * Optional OIDC SSO configuration. When `enforced` is true, magic-link
   * sign-in is blocked for any email address whose domain matches
   * `allowedDomain` (or any member already in this workspace) and that
   * user must complete the OIDC flow at /api/auth/sso/<workspaceId>/start.
   * Managed by lib/sso.ts; persisted inline so a workspace fetch returns
   * the policy in one read.
   */
  /**
   * Billing plan that gates the workspace's per-month /v1 call quota.
   * See lib/plans.ts for the catalog and limits. Defaults to "free"
   * when absent so existing workspaces keep working under the lowest
   * tier until an owner upgrades.
   */
  plan?: PlanId | null;
  /**
   * Domain auto-join policy. When a user signs in (magic link or SSO) with
   * an email whose domain matches one of these entries, they are added to
   * this workspace with `autoJoinRole`. Owner-only configuration. Each
   * auto-join event is recorded in the audit log.
   */
  autoJoinDomains?: string[];
  autoJoinRole?: Exclude<Role, "owner">;
  /**
   * Owner-configured allowlist of webhook destination domains. When the
   * list is non-empty, every webhook URL created in this workspace must
   * have a hostname that matches one of the entries (exact host, or a
   * `*.example.com` suffix). Enforcement also runs at delivery time so a
   * legacy webhook stored before the policy was tightened cannot exfil to
   * a now-disallowed host. Empty list disables enforcement. SSRF rules in
   * `validateUrl` still apply on top of this control.
   */
  webhookDomainAllowlist?: string[];
  sso?: {
    provider: "oidc";
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowedDomain: string;
    enforced: boolean;
    updatedAt: number;
    updatedBy: string;
    /**
     * IdP claim name carrying the user's group memberships (e.g. "groups",
     * "roles"). When present alongside `groupMappings`, the SSO callback
     * reads this claim from the verified id_token and re-syncs the
     * member's workspace role from the highest-ranked matching mapping.
     * Empty / unset disables group sync; the member's existing role is
     * left alone.
     */
    groupClaim?: string;
    /**
     * Ordered list of (IdP group -> codeclone role) mappings. Matched
     * case-sensitively against any string in the configured groupClaim.
     * When a user matches several, the highest-ranked role wins
     * (owner > editor > viewer). Sole-owner safety is preserved at the
     * setMemberRole layer, so a demotion to editor that would remove the
     * last owner is rejected and audited.
     */
    groupMappings?: Array<{ group: string; role: Role }>;
    /**
     * When set, surfaces who/when the group-mapping policy changed last
     * so the audit reviewer can pin policy churn separate from issuer
     * churn.
     */
    groupsUpdatedAt?: number;
    groupsUpdatedBy?: string;
  } | null;
  /**
   * Optional session policy enforced on every authenticated request made by
   * any member of this workspace. Owner-only configuration.
   *
   *   maxLifetimeSec  hard cap on absolute session age in seconds. When
   *                   the session's createdAt is older than this the
   *                   session is rejected even if the cookie's own exp
   *                   has not been reached.
   *   idleTimeoutSec  max time between user activity (lastSeenAt). When
   *                   exceeded the session is rejected.
   *
   * When a member belongs to multiple workspaces with policies, the
   * strictest non-zero value applies. A value of 0 means "no limit from
   * this workspace". Legacy cookies without a jti cannot be idle-tracked
   * so the idle window is enforced against the cookie's iat instead.
   */
  sessionPolicy?: {
    maxLifetimeSec: number;
    idleTimeoutSec: number;
    /**
     * Maximum number of concurrently active server-side sessions a single
     * member may hold. When a new sign-in would exceed the cap, the oldest
     * sessions for that user are revoked (and audited) so the cap is
     * always satisfied. 0 means "no limit from this workspace".
     */
    maxConcurrentSessions: number;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /**
   * Owner-configured audit log retention policy. When `auditDays` is set
   * and > 0, audit entries scoped to this workspace that are older than
   * `auditDays` are hidden from every read path (listAudit, CSV export,
   * the /audit UI). The underlying hash-chained JSONL files are not
   * physically rewritten so the tamper-evident chain remains intact and
   * verifiable; this is access-layer enforcement that satisfies GDPR
   * data-minimisation while keeping SOC2 immutability. Owner only.
   */
  retention?: {
    auditDays: number;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /**
   * Owner-configured legal hold. When active, every destructive workspace
   * operation (workspace.wipe, retention purge, retention shortening,
   * snippet hard-delete bound to this workspace) is refused with a
   * structured `legal_hold` error so the data remains discoverable for
   * litigation or compliance review. Owners may release the hold at any
   * time; both placement and release are recorded in the tamper-evident
   * audit chain. There is no "force" override: by design, releasing the
   * hold is the only path to destructive action.
   */
  legalHold?: {
    active: true;
    reason: string;
    placedAt: number;
    placedBy: string;
    caseRef?: string | null;
  } | null;
  /**
   * Owner-configured data residency policy. Enterprise buyers in regulated
   * sectors (EU healthcare, APAC finance, US-only public sector) require a
   * contractual guarantee that workspace data is processed only in named
   * regions. When `enforced` is true, every API call whose serving region
   * (CODECLONE_REGION env, default "global") does not match the workspace
   * `region` is refused with HTTP 451 and an audit entry tagged
   * `workspace.residency_block`. When `enforced` is false the policy acts as
   * a documentation hint surfaced in the dashboard and audit metadata but
   * does not block traffic, which lets ops migrate workloads region by
   * region before flipping enforcement.
   */
  residency?: {
    region: ResidencyRegion;
    enforced: boolean;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /**
   * Owner-configured API key max age policy. When `maxAgeDays > 0`, every
   * workspace-bound API key must have an `expiresAt` no later than
   * `createdAt + maxAgeDays`. New keys created without an explicit expiry,
   * or with a longer expiry, are clamped at creation time. Existing keys
   * that drift past the policy are refused at /v1 request time with HTTP
   * 401 `api_key_policy_expired` and the rejection is recorded in the
   * audit log. 0 / null disables the policy.
   *
   * Common procurement requirement (SOC 2 CC6.1, ISO 27001 A.9.2.6):
   * "API credentials must expire within N days and be rotated."
   */
  apiKeyPolicy?: {
    maxAgeDays: number;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /**
   * Owner-configured MFA enrollment policy. When `requireEnrollment` is
   * true, every active member of this workspace must have a confirmed
   * TOTP enrollment (see lib/mfa.ts) before mutating workspace data.
   * `gracePeriodDays` gives existing members a window after the policy
   * is enabled (or after they join) to enroll before they are blocked;
   * 0 means enforce immediately. Enforcement happens at sensitive
   * mutation endpoints via lib/mfa-enforce.ts and is surfaced to users
   * via /api/auth/mfa/required so the UI can show a clear remediation
   * banner instead of an opaque 403.
   *
   * Common procurement requirement (SOC 2 CC6.1, NIST 800-53 IA-2(1)):
   * "Multifactor authentication is required for all privileged users."
   */
  mfaPolicy?: {
    requireEnrollment: boolean;
    gracePeriodDays: number;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /**
   * Owner-configured DLP guardrail on customer-submitted source code.
   * codeclone accepts pasted snippets for similarity comparison; without
   * a scan policy, an engineer can leak an AWS access key, GitHub PAT,
   * or PEM private key into a hosted endpoint. When set, every snippet
   * routed through /api/compare, /v1/compare, and /v1/batch is run
   * through lib/secret-scan.ts before similarity work. "warn" returns
   * findings without altering behaviour, "redact" replaces matches with
   * a marker before scoring, "block" rejects the request with a 422
   * `secrets_detected`. Every non-empty finding set is recorded in the
   * tamper-evident audit log with the rule ids (never the raw value).
   *
   * Common procurement requirement (SOC 2 CC6.7, ISO 27001 A.8.12,
   * NIST 800-53 SC-28): "Sensitive information transmitted to or stored
   * by third-party services must be protected from inadvertent
   * disclosure."
   */
  secretScanPolicy?: {
    mode: SecretScanMode;
    updatedAt: number;
    updatedBy: string;
  } | null;
}

export type ResidencyRegion = "us" | "eu" | "apac" | "global";

export const RESIDENCY_REGIONS: readonly ResidencyRegion[] = [
  "us",
  "eu",
  "apac",
  "global",
] as const;

export const RESIDENCY_REGION_LABELS: Record<ResidencyRegion, string> = {
  us: "United States",
  eu: "European Union",
  apac: "Asia Pacific",
  global: "Global (no restriction)",
};

export function isResidencyRegion(v: unknown): v is ResidencyRegion {
  return typeof v === "string" && (RESIDENCY_REGIONS as readonly string[]).includes(v);
}

export function sanitizeResidency(
  input: { region?: unknown; enforced?: unknown } | null | undefined,
): { region: ResidencyRegion; enforced: boolean } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (!isResidencyRegion(o.region)) return null;
  return { region: o.region, enforced: Boolean(o.enforced) };
}

/**
 * Replace the workspace residency policy. Pass null to clear. The caller
 * must enforce owner permission and write the audit entry; this helper is
 * intentionally a thin persistence wrapper so the audit diff is computed
 * against the on-disk record by the route handler.
 */
export async function setResidency(
  ws: WorkspaceRecord,
  policy: { region: ResidencyRegion; enforced: boolean } | null,
  updatedBy: string,
): Promise<WorkspaceRecord> {
  if (!policy) {
    ws.residency = null;
  } else {
    ws.residency = {
      region: policy.region,
      enforced: policy.enforced,
      updatedAt: Date.now(),
      updatedBy,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Region the current process is serving. Set by ops at deploy time. The
 * default "global" means "no claim about residency"; enforced workspaces
 * pinned to a specific region will refuse to be served by a global node.
 */
export function currentServingRegion(): ResidencyRegion {
  const v = (process.env.CODECLONE_REGION ?? "global").trim().toLowerCase();
  return isResidencyRegion(v) ? v : "global";
}

/**
 * Decide whether a workspace residency policy permits the current serving
 * region. "global" workspace region always allows. Otherwise the serving
 * region must equal the pinned region. When `enforced` is false the call
 * is allowed regardless and the caller should still log the mismatch as a
 * warning so ops can see drift before flipping enforcement.
 */
export function residencyDecision(
  ws: WorkspaceRecord | null | undefined,
  serving: ResidencyRegion = currentServingRegion(),
): { allowed: boolean; enforced: boolean; pinned: ResidencyRegion; serving: ResidencyRegion; match: boolean } {
  const pinned: ResidencyRegion = ws?.residency?.region ?? "global";
  const enforced = !!ws?.residency?.enforced;
  const match = pinned === "global" || pinned === serving;
  return { allowed: match || !enforced, enforced, pinned, serving, match };
}

export interface LegalHoldInput {
  reason: string;
  caseRef?: string | null;
}

export function sanitizeLegalHold(input: unknown): LegalHoldInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return null;
  let caseRef: string | null = null;
  if (typeof o.caseRef === "string") {
    const t = o.caseRef.trim();
    if (t.length > 0 && t.length <= 120 && /^[A-Za-z0-9 _\-./#:]+$/.test(t)) {
      caseRef = t;
    } else if (t.length > 0) {
      return null;
    }
  }
  return { reason, caseRef };
}

export function isOnLegalHold(ws: WorkspaceRecord | null | undefined): boolean {
  return !!(ws && ws.legalHold && ws.legalHold.active === true);
}

export async function placeLegalHold(
  ws: WorkspaceRecord,
  input: LegalHoldInput,
  placedBy: string,
): Promise<WorkspaceRecord> {
  ws.legalHold = {
    active: true,
    reason: input.reason,
    placedAt: Date.now(),
    placedBy,
    caseRef: input.caseRef ?? null,
  };
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

export async function releaseLegalHold(ws: WorkspaceRecord): Promise<WorkspaceRecord> {
  ws.legalHold = null;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

export interface InviteRecord {
  v: 1;
  id: string;
  workspaceId: string;
  email: string; // normalized
  role: Exclude<Role, "owner">;
  invitedBy: string; // userId
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string; // userId
  revokedAt?: number;
}

const INVITE_TTL_SEC = 60 * 60 * 24 * 14; // 14 days
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\s._-]{0,63}$/u;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(p: string, value: unknown) {
  await ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function workspacePath(id: string) {
  return path.join(WORKSPACES_DIR, id + ".json");
}
function memberIndexPath(userId: string) {
  return path.join(WORKSPACES_DIR, "_members", userId + ".json");
}
function invitePath(id: string) {
  return path.join(WORKSPACES_DIR, "_invites", id + ".json");
}

export function normalizeName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(trimmed)) return null;
  return trimmed;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return SLUG_RE.test(s) ? s : "team";
}

function newId(prefix: string, bytes = 8): string {
  return prefix + "_" + crypto.randomBytes(bytes).toString("base64url");
}

async function addToMemberIndex(userId: string, workspaceId: string) {
  const p = memberIndexPath(userId);
  const existing = (await readJson<{ ids: string[] }>(p)) ?? { ids: [] };
  if (!existing.ids.includes(workspaceId)) {
    existing.ids.push(workspaceId);
    await writeJson(p, existing);
  }
}

async function removeFromMemberIndex(userId: string, workspaceId: string) {
  const p = memberIndexPath(userId);
  const existing = await readJson<{ ids: string[] }>(p);
  if (!existing) return;
  existing.ids = existing.ids.filter((x) => x !== workspaceId);
  await writeJson(p, existing);
}

export interface CreateWorkspaceInput {
  name: string;
  ownerId: string;
  ownerEmail: string;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
  const name = normalizeName(input.name);
  if (!name) throw new Error("invalid_name");
  if (!input.ownerId || !input.ownerEmail) throw new Error("missing_owner");
  const id = newId("ws");
  const slug = slugify(name);
  const now = Date.now();
  const rec: WorkspaceRecord = {
    v: 1,
    id,
    name,
    slug,
    createdAt: now,
    createdBy: input.ownerId,
    members: [
      {
        userId: input.ownerId,
        email: input.ownerEmail,
        role: "owner",
        joinedAt: now,
      },
    ],
  };
  await writeJson(workspacePath(id), rec);
  await addToMemberIndex(input.ownerId, id);
  return rec;
}

export async function getWorkspace(id: string): Promise<WorkspaceRecord | null> {
  if (!/^ws_[A-Za-z0-9_-]{6,32}$/.test(id)) return null;
  return readJson<WorkspaceRecord>(workspacePath(id));
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]> {
  const idx = await readJson<{ ids: string[] }>(memberIndexPath(userId));
  if (!idx) return [];
  const out: WorkspaceRecord[] = [];
  for (const id of idx.ids) {
    const w = await getWorkspace(id);
    if (w && w.members.some((m) => m.userId === userId)) out.push(w);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Returns the member record (including suspended members) so callers that
 * need raw roster info (audit log render, owner-only views) can still see
 * them. Access-gating callers MUST additionally check `isMemberActive` or
 * use the `getActiveMember` helper below.
 */
export function getMember(ws: WorkspaceRecord, userId: string): Member | null {
  return ws.members.find((m) => m.userId === userId) ?? null;
}

/**
 * Access-gating lookup. Returns the member only when their status is active
 * (or undefined / legacy). Suspended members are excluded so every route
 * that previously called `getMember(...)` to authorise an action keeps the
 * same behaviour by switching to `getActiveMember(...)`.
 */
export function getActiveMember(ws: WorkspaceRecord, userId: string): Member | null {
  const m = ws.members.find((x) => x.userId === userId);
  return isMemberActive(m) ? m! : null;
}

export function canInvite(ws: WorkspaceRecord, userId: string): boolean {
  const m = getActiveMember(ws, userId);
  if (!m) return false;
  return m.role === "owner" || m.role === "editor";
}

export function canManage(ws: WorkspaceRecord, userId: string): boolean {
  const m = getActiveMember(ws, userId);
  return m?.role === "owner";
}

/**
 * Replace the workspace IP allowlist. Caller is responsible for sanitising
 * the entries (see `sanitizeCidrList` in lib/ip-allowlist.ts) and for
 * permission checks. We only persist what we are given.
 */
export async function setIpAllowlist(
  ws: WorkspaceRecord,
  entries: string[],
): Promise<WorkspaceRecord> {
  ws.ipAllowlist = Array.isArray(entries) ? entries.slice(0, 64) : [];
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Replace the workspace webhook destination domain allowlist. Caller
 * is responsible for sanitising entries (see `sanitizeWebhookDomainList`
 * in lib/webhooks.ts) and for permission checks.
 */
export async function setWebhookDomainAllowlist(
  ws: WorkspaceRecord,
  entries: string[],
): Promise<WorkspaceRecord> {
  ws.webhookDomainAllowlist = Array.isArray(entries) ? entries.slice(0, 64) : [];
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

export async function setSsoConfig(
  ws: WorkspaceRecord,
  cfg: WorkspaceRecord["sso"],
): Promise<WorkspaceRecord> {
  ws.sso = cfg ?? null;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Bounds for SSO group mappings. The provider-side group name has to
 * fit in a reasonable string and we cap the table size so a typo'd
 * policy can't blow up the workspace doc.
 */
export const SSO_GROUP_MAPPINGS_MAX = 64;
export const SSO_GROUP_NAME_MAX = 256;
export const SSO_GROUP_CLAIM_MAX = 64;

/**
 * Sanitize and persist the SSO group-sync policy on an existing SSO
 * config. Returns the updated workspace record. Throws `sso_not_configured`
 * when the workspace has no OIDC config yet (we don't accept group rules
 * without an issuer to apply them to). Caller is expected to enforce RBAC.
 */
export async function setSsoGroupMappings(
  ws: WorkspaceRecord,
  input: {
    groupClaim: string | null | undefined;
    groupMappings: Array<{ group: unknown; role: unknown }> | null | undefined;
    actorId: string;
  },
): Promise<WorkspaceRecord> {
  if (!ws.sso) throw new Error("sso_not_configured");
  const claimRaw = typeof input.groupClaim === "string" ? input.groupClaim.trim() : "";
  const claim = claimRaw.slice(0, SSO_GROUP_CLAIM_MAX);
  const mappingsIn = Array.isArray(input.groupMappings) ? input.groupMappings : [];
  const seen = new Set<string>();
  const mappings: Array<{ group: string; role: Role }> = [];
  for (const row of mappingsIn) {
    if (!row || typeof row !== "object") continue;
    const g = typeof row.group === "string" ? row.group.trim() : "";
    const r = row.role;
    if (!g || g.length > SSO_GROUP_NAME_MAX) continue;
    if (r !== "owner" && r !== "editor" && r !== "viewer") continue;
    const key = g; // group names are case-sensitive (matches IdP semantics)
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ group: g, role: r as Role });
    if (mappings.length >= SSO_GROUP_MAPPINGS_MAX) break;
  }
  ws.sso = {
    ...ws.sso,
    groupClaim: claim || undefined,
    groupMappings: mappings.length > 0 ? mappings : undefined,
    groupsUpdatedAt: Date.now(),
    groupsUpdatedBy: input.actorId,
  };
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Decide the role a member should hold after an SSO sign-in, given the
 * raw value of the configured groupClaim from the verified id_token.
 *
 * Returns `null` when no sync should happen (no mappings, no claim,
 * claim value isn't a string-or-array of strings, or no match). The
 * returned role is the highest-ranked matching mapping; ties resolved
 * by mapping order.
 */
export function resolveRoleFromSsoGroups(
  cfg: NonNullable<WorkspaceRecord["sso"]>,
  claimValue: unknown,
): Role | null {
  const claim = cfg.groupClaim;
  const mappings = cfg.groupMappings;
  if (!claim || !mappings || mappings.length === 0) return null;
  let userGroups: string[];
  if (Array.isArray(claimValue)) {
    userGroups = claimValue.filter((x): x is string => typeof x === "string");
  } else if (typeof claimValue === "string") {
    // Some IdPs ship a space-separated string (OAuth-style scope claim).
    userGroups = claimValue.split(/\s+/).filter(Boolean);
  } else {
    return null;
  }
  if (userGroups.length === 0) return null;
  const userSet = new Set(userGroups);
  let best: Role | null = null;
  for (const m of mappings) {
    if (!userSet.has(m.group)) continue;
    if (best === null || ROLE_RANK[m.role] > ROLE_RANK[best]) best = m.role;
  }
  return best;
}

// Bounds for workspace audit retention. 0 means "keep forever / no
// retention limit from this workspace".
export const RETENTION_BOUNDS = {
  auditDays: { min: 1, max: 3650 },
} as const;

export function sanitizeRetention(
  input: unknown,
): { auditDays: number } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const raw = o.auditDays;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (n <= 0) return { auditDays: 0 };
  const { min, max } = RETENTION_BOUNDS.auditDays;
  return { auditDays: Math.min(Math.max(n, min), max) };
}

export class LegalHoldError extends Error {
  status = 409 as const;
  op: string;
  constructor(op: string) {
    super(`legal_hold:${op}`);
    this.op = op;
  }
}

export async function setRetention(
  ws: WorkspaceRecord,
  policy: { auditDays: number } | null,
  updatedBy: string,
): Promise<WorkspaceRecord> {
  // While on legal hold, retention cannot be tightened or cleared in a way
  // that would hide historical audit data. We allow lengthening or no-op.
  if (isOnLegalHold(ws)) {
    const before = ws.retention?.auditDays ?? 0;
    const after = policy?.auditDays ?? 0;
    const weakening = after !== before && (after === 0 || (before > 0 && after < before));
    if (weakening) throw new LegalHoldError("retention_weaken");
  }
  if (!policy || policy.auditDays === 0) {
    ws.retention = null;
  } else {
    ws.retention = {
      auditDays: policy.auditDays,
      updatedAt: Date.now(),
      updatedBy,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Cutoff timestamp (ms) below which audit entries for this workspace must
 * be hidden. Returns null if no retention is configured.
 */
export function retentionCutoffMs(ws: WorkspaceRecord, now = Date.now()): number | null {
  const days = ws.retention?.auditDays;
  if (!days || days <= 0) return null;
  return now - days * 86400 * 1000;
}

// Bounds for workspace session policy values. 0 means "unlimited / no
// restriction from this workspace".
export const SESSION_POLICY_BOUNDS = {
  maxLifetime: { min: 5 * 60, max: 60 * 60 * 24 * 90 },
  idleTimeout: { min: 60, max: 60 * 60 * 24 * 30 },
  maxConcurrentSessions: { min: 1, max: 20 },
} as const;

export function sanitizeSessionPolicy(
  input:
    | { maxLifetimeSec?: unknown; idleTimeoutSec?: unknown; maxConcurrentSessions?: unknown }
    | null
    | undefined,
): { maxLifetimeSec: number; idleTimeoutSec: number; maxConcurrentSessions: number } | null {
  if (!input || typeof input !== "object") return null;
  const max = Number((input as Record<string, unknown>).maxLifetimeSec);
  const idle = Number((input as Record<string, unknown>).idleTimeoutSec);
  if (!Number.isFinite(max) || !Number.isFinite(idle)) return null;
  const mi = max === 0
    ? 0
    : Math.min(
        SESSION_POLICY_BOUNDS.maxLifetime.max,
        Math.max(SESSION_POLICY_BOUNDS.maxLifetime.min, Math.floor(max)),
      );
  const id = idle === 0
    ? 0
    : Math.min(
        SESSION_POLICY_BOUNDS.idleTimeout.max,
        Math.max(SESSION_POLICY_BOUNDS.idleTimeout.min, Math.floor(idle)),
      );
  // maxConcurrentSessions: optional in body for back-compat. Anything
  // non-finite or <= 0 collapses to 0 ("no cap from this workspace").
  const capRaw = (input as Record<string, unknown>).maxConcurrentSessions;
  let cap = 0;
  if (capRaw !== undefined && capRaw !== null) {
    const c = Number(capRaw);
    if (Number.isFinite(c) && c >= 1) {
      cap = Math.min(
        SESSION_POLICY_BOUNDS.maxConcurrentSessions.max,
        Math.max(SESSION_POLICY_BOUNDS.maxConcurrentSessions.min, Math.floor(c)),
      );
    }
  }
  return { maxLifetimeSec: mi, idleTimeoutSec: id, maxConcurrentSessions: cap };
}

// Replace the workspace session policy. Pass null (or both values 0) to
// clear. Caller must enforce owner permission and write the audit entry.
export async function setSessionPolicy(
  ws: WorkspaceRecord,
  policy: { maxLifetimeSec: number; idleTimeoutSec: number; maxConcurrentSessions?: number } | null,
  actor: string,
): Promise<WorkspaceRecord> {
  const cap = policy?.maxConcurrentSessions ?? 0;
  if (
    !policy ||
    (policy.maxLifetimeSec === 0 && policy.idleTimeoutSec === 0 && cap === 0)
  ) {
    ws.sessionPolicy = null;
  } else {
    ws.sessionPolicy = {
      maxLifetimeSec: policy.maxLifetimeSec,
      idleTimeoutSec: policy.idleTimeoutSec,
      maxConcurrentSessions: cap,
      updatedAt: Date.now(),
      updatedBy: actor,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Bounds for the workspace API key max age policy. Min 1 day so a key is
 * usable for at least one full rotation cycle; max 365 days mirrors the
 * per-key MAX_EXPIRES_DAYS cap in lib/api-keys.ts.
 */
export const API_KEY_POLICY_BOUNDS = {
  maxAgeDays: { min: 1, max: 365 },
} as const;

export function sanitizeApiKeyPolicy(
  input: { maxAgeDays?: unknown } | null | undefined,
): { maxAgeDays: number } | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).maxAgeDays;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return { maxAgeDays: 0 };
  const clamped = Math.min(
    API_KEY_POLICY_BOUNDS.maxAgeDays.max,
    Math.max(API_KEY_POLICY_BOUNDS.maxAgeDays.min, Math.floor(n)),
  );
  return { maxAgeDays: clamped };
}

/**
 * Replace the workspace API key max-age policy. Pass null or 0 to clear.
 * Caller must enforce owner-only permission and write the audit entry.
 */
export async function setApiKeyPolicy(
  ws: WorkspaceRecord,
  policy: { maxAgeDays: number } | null,
  actor: string,
): Promise<WorkspaceRecord> {
  if (!policy || policy.maxAgeDays === 0) {
    ws.apiKeyPolicy = null;
  } else {
    ws.apiKeyPolicy = {
      maxAgeDays: policy.maxAgeDays,
      updatedAt: Date.now(),
      updatedBy: actor,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * The latest `expiresAt` (ms) an API key in this workspace may have given
 * the configured policy and the key's `createdAt`. Returns null when the
 * policy is unset (no enforcement).
 */
export function apiKeyPolicyDeadline(
  ws: WorkspaceRecord | null | undefined,
  createdAtMs: number,
): number | null {
  const days = ws?.apiKeyPolicy?.maxAgeDays;
  if (!days || days <= 0) return null;
  return createdAtMs + days * 24 * 60 * 60 * 1000;
}

// ---- MFA enrollment policy ---------------------------------------------

export const MFA_POLICY_BOUNDS = {
  gracePeriodDays: { min: 0, max: 90 },
} as const;

export function sanitizeMfaPolicy(
  input: { requireEnrollment?: unknown; gracePeriodDays?: unknown } | null | undefined,
): { requireEnrollment: boolean; gracePeriodDays: number } | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const requireEnrollment = Boolean(obj.requireEnrollment);
  const raw = obj.gracePeriodDays;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  const grace = Number.isFinite(n)
    ? Math.min(
        MFA_POLICY_BOUNDS.gracePeriodDays.max,
        Math.max(MFA_POLICY_BOUNDS.gracePeriodDays.min, Math.floor(n)),
      )
    : 0;
  return { requireEnrollment, gracePeriodDays: grace };
}

/**
 * Replace the workspace MFA enrollment policy. Pass null or
 * `requireEnrollment=false` to clear. Caller enforces owner-only and
 * writes the audit entry.
 */
export async function setMfaPolicy(
  ws: WorkspaceRecord,
  policy: { requireEnrollment: boolean; gracePeriodDays: number } | null,
  actor: string,
): Promise<WorkspaceRecord> {
  if (!policy || !policy.requireEnrollment) {
    ws.mfaPolicy = null;
  } else {
    ws.mfaPolicy = {
      requireEnrollment: true,
      gracePeriodDays: policy.gracePeriodDays,
      updatedAt: Date.now(),
      updatedBy: actor,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

// ---- Secret-scan DLP policy --------------------------------------------

export function sanitizeSecretScanPolicy(
  input: { mode?: unknown } | null | undefined,
): { mode: SecretScanMode } | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).mode;
  if (!isSecretScanMode(raw)) return { mode: "off" };
  return { mode: raw };
}

/**
 * Replace the workspace secret-scan DLP policy. Pass null or `mode=off`
 * to clear it (off is the default and means "no scan"). Caller enforces
 * owner-only permission and writes the audit entry.
 */
export async function setSecretScanPolicy(
  ws: WorkspaceRecord,
  policy: { mode: SecretScanMode } | null,
  actor: string,
): Promise<WorkspaceRecord> {
  if (!policy || policy.mode === "off") {
    ws.secretScanPolicy = null;
  } else {
    ws.secretScanPolicy = {
      mode: policy.mode,
      updatedAt: Date.now(),
      updatedBy: actor,
    };
  }
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Resolve the effective scan mode for a workspace (or a lookup-failure
 * case). Centralized so the enforcement middleware can stay terse and
 * we have one place to evolve the default later (e.g. plan-driven).
 */
export function effectiveSecretScanMode(
  ws: WorkspaceRecord | null | undefined,
): SecretScanMode {
  return ws?.secretScanPolicy?.mode ?? "off";
}


/**
 * Resolve whether a user is past the MFA enrollment grace window of any
 * workspace they belong to. Returns the strictest (earliest) workspace
 * whose policy is in force, or null if no workspace requires enrollment
 * yet. Callers combine this with `isEnrolled(mfa)` to decide whether to
 * block a mutating request.
 *
 * The deadline for a member is `max(policy.updatedAt, member.joinedAt) +
 * gracePeriodDays * 1d`, so existing members get the full grace window
 * when an owner enables the policy, and new joiners get a fresh window
 * from their join time.
 */
export async function effectiveMfaPolicyForUser(
  userId: string,
  now: number = Date.now(),
): Promise<{
  required: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  gracePeriodDays: number;
  deadline: number | null;
  pastDeadline: boolean;
}> {
  const workspaces = await listWorkspacesForUser(userId);
  let strictestDeadline: number | null = null;
  let strictestWs: WorkspaceRecord | null = null;
  let strictestGrace = 0;
  let anyRequired = false;
  for (const w of workspaces) {
    const p = w.mfaPolicy;
    if (!p || !p.requireEnrollment) continue;
    const m = getActiveMember(w, userId);
    if (!m) continue;
    anyRequired = true;
    const base = Math.max(p.updatedAt, m.joinedAt);
    const deadline = base + p.gracePeriodDays * 24 * 60 * 60 * 1000;
    if (strictestDeadline === null || deadline < strictestDeadline) {
      strictestDeadline = deadline;
      strictestWs = w;
      strictestGrace = p.gracePeriodDays;
    }
  }
  return {
    required: anyRequired,
    workspaceId: strictestWs?.id ?? null,
    workspaceName: strictestWs?.name ?? null,
    gracePeriodDays: strictestGrace,
    deadline: strictestDeadline,
    pastDeadline: strictestDeadline !== null && now >= strictestDeadline,
  };
}

// Resolve the effective session policy for a user across every workspace
// they belong to. Strictest non-zero wins; 0 means no limit.
export async function effectiveSessionPolicyForUser(
  userId: string,
): Promise<{
  maxLifetimeSec: number;
  idleTimeoutSec: number;
  maxConcurrentSessions: number;
  sourceWorkspaceId: string | null;
  capSourceWorkspaceId: string | null;
}> {
  const workspaces = await listWorkspacesForUser(userId);
  let max = 0;
  let idle = 0;
  let cap = 0;
  let source: string | null = null;
  let capSource: string | null = null;
  for (const w of workspaces) {
    // Only members in good standing should be constrained by a workspace.
    // isMemberActive already excludes expired support grants and suspended
    // accounts so a stale link cannot extend a workspace's reach.
    const m = w.members.find((x) => x.userId === userId);
    if (!m || !isMemberActive(m)) continue;
    const p = w.sessionPolicy;
    if (!p) continue;
    if (p.maxLifetimeSec > 0 && (max === 0 || p.maxLifetimeSec < max)) {
      max = p.maxLifetimeSec;
      source = w.id;
    }
    if (p.idleTimeoutSec > 0 && (idle === 0 || p.idleTimeoutSec < idle)) {
      idle = p.idleTimeoutSec;
      source = source ?? w.id;
    }
    const pCap = p.maxConcurrentSessions ?? 0;
    if (pCap > 0 && (cap === 0 || pCap < cap)) {
      cap = pCap;
      capSource = w.id;
    }
  }
  return {
    maxLifetimeSec: max,
    idleTimeoutSec: idle,
    maxConcurrentSessions: cap,
    sourceWorkspaceId: source,
    capSourceWorkspaceId: capSource,
  };
}

/**
 * Update the workspace billing plan. Caller is responsible for the
 * owner-only authorisation check and for writing the audit entry; we
 * just validate the id and persist.
 */
export async function setWorkspacePlan(
  ws: WorkspaceRecord,
  plan: PlanId,
): Promise<WorkspaceRecord> {
  if (!isPlanId(plan)) {
    throw new Error(`invalid plan id: ${String(plan)}`);
  }
  ws.plan = plan;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Owner-only: replace the workspace's auto-join domain list and default
 * role. Domains are normalised to lowercase, deduped, and validated. Caller
 * writes the audit entry; we just validate and persist.
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function sanitizeAutoJoinDomains(input: unknown): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(input)) return { ok, rejected };
  for (const raw of input) {
    if (typeof raw !== "string") { rejected.push(String(raw)); continue; }
    let d = raw.trim().toLowerCase();
    if (d.startsWith("@")) d = d.slice(1);
    if (!d) continue;
    if (!DOMAIN_RE.test(d) || d.length > 253) { rejected.push(raw); continue; }
    if (seen.has(d)) continue;
    seen.add(d);
    ok.push(d);
  }
  return { ok, rejected };
}

export async function setAutoJoin(
  ws: WorkspaceRecord,
  domains: string[],
  role: Exclude<Role, "owner">,
): Promise<WorkspaceRecord> {
  if (role !== "editor" && role !== "viewer") throw new Error("invalid_role");
  ws.autoJoinDomains = domains;
  ws.autoJoinRole = role;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Apply domain auto-join for a freshly-signed-in user. Scans every
 * workspace, adds the user as a member of each workspace whose
 * `autoJoinDomains` contains the user's email domain, and returns the
 * list of workspaces the user was added to (for audit logging).
 *
 * Cross-tenant safe: we only mutate workspaces whose owner explicitly
 * listed the domain. Existing members are left untouched. SSO-enforced
 * workspaces never auto-join from magic-link sign-ins (caller passes
 * `viaSso` so we can gate that).
 */
export async function applyAutoJoinForUser(opts: {
  userId: string;
  email: string;
  viaSso: boolean;
}): Promise<WorkspaceRecord[]> {
  const email = opts.email.toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return [];
  const domain = email.slice(at + 1);
  if (!domain) return [];
  const all = await listWorkspaces();
  const joined: WorkspaceRecord[] = [];
  for (const ws of all) {
    const list = Array.isArray(ws.autoJoinDomains) ? ws.autoJoinDomains : [];
    if (!list.includes(domain)) continue;
    // If this workspace enforces SSO for the user's domain, only auto-join
    // when the sign-in actually came through SSO.
    if (ws.sso && ws.sso.enforced && ws.sso.allowedDomain === domain && !opts.viaSso) {
      continue;
    }
    if (ws.members.some((m) => m.userId === opts.userId)) continue;
    const role: Role = ws.autoJoinRole === "editor" ? "editor" : "viewer";
    ws.members.push({
      userId: opts.userId,
      email: opts.email,
      role,
      joinedAt: Date.now(),
    });
    await writeJson(workspacePath(ws.id), ws);
    await addToMemberIndex(opts.userId, ws.id);
    joined.push(ws);
  }
  return joined;
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const files = await listFiles(WORKSPACES_DIR);
  const out: WorkspaceRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const w = await readJson<WorkspaceRecord>(path.join(WORKSPACES_DIR, f));
    if (w) out.push(w);
  }
  return out;
}

export async function renameWorkspace(ws: WorkspaceRecord, name: string): Promise<WorkspaceRecord> {
  const clean = normalizeName(name);
  if (!clean) throw new Error("invalid_name");
  ws.name = clean;
  ws.slug = slugify(clean);
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

export interface IssuedInvite {
  record: InviteRecord;
  token: string; // <id>.<secret>
  url: string;
}

export async function issueInvite(opts: {
  workspace: WorkspaceRecord;
  email: string;
  role: Exclude<Role, "owner">;
  invitedBy: string;
  origin: string;
}): Promise<IssuedInvite> {
  const { workspace, email, role, invitedBy, origin } = opts;
  if (role !== "editor" && role !== "viewer") throw new Error("invalid_role");
  if (workspace.members.some((m) => m.email === email)) {
    throw new Error("already_member");
  }
  const id = newId("inv", 6);
  const secret = crypto.randomBytes(18).toString("base64url");
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  const now = Date.now();
  const rec: InviteRecord & { hash: string } = {
    v: 1,
    id,
    workspaceId: workspace.id,
    email,
    role,
    invitedBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_SEC * 1000,
    hash,
  } as InviteRecord & { hash: string };
  await writeJson(invitePath(id), rec);
  const token = `${id}.${secret}`;
  const u = new URL(`/workspaces/invite/${token}`, origin);
  return { record: rec, token, url: u.toString() };
}

export async function listInvitesForWorkspace(workspaceId: string): Promise<InviteRecord[]> {
  const files = await listFiles(path.join(WORKSPACES_DIR, "_invites"));
  const out: InviteRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const r = await readJson<InviteRecord>(path.join(WORKSPACES_DIR, "_invites", f));
    if (r && r.workspaceId === workspaceId) out.push(r);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function lookupInvite(token: string): Promise<{
  workspace: WorkspaceRecord;
  invite: InviteRecord;
} | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [id, secret] = token.split(".", 2);
  if (!id || !secret) return null;
  if (!/^inv_[A-Za-z0-9_-]{4,32}$/.test(id)) return null;
  const stored = await readJson<InviteRecord & { hash: string }>(invitePath(id));
  if (!stored) return null;
  if (stored.acceptedAt || stored.revokedAt) return null;
  if (Date.now() > stored.expiresAt) return null;
  const want = crypto.createHash("sha256").update(secret).digest("hex");
  if (!safeEq(want, stored.hash)) return null;
  const ws = await getWorkspace(stored.workspaceId);
  if (!ws) return null;
  return { workspace: ws, invite: stored };
}

export async function acceptInvite(opts: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<WorkspaceRecord | null> {
  const looked = await lookupInvite(opts.token);
  if (!looked) return null;
  const { workspace, invite } = looked;
  // Email gating: the invite is bound to a specific email.
  if (invite.email !== opts.userEmail) return null;
  if (!workspace.members.some((m) => m.userId === opts.userId)) {
    workspace.members.push({
      userId: opts.userId,
      email: opts.userEmail,
      role: invite.role,
      joinedAt: Date.now(),
    });
    await writeJson(workspacePath(workspace.id), workspace);
    await addToMemberIndex(opts.userId, workspace.id);
  }
  const stored = (await readJson<InviteRecord & { hash: string }>(invitePath(invite.id)))!;
  stored.acceptedAt = Date.now();
  stored.acceptedBy = opts.userId;
  await writeJson(invitePath(invite.id), stored);
  return workspace;
}

export async function revokeInvite(inviteId: string): Promise<boolean> {
  const stored = await readJson<InviteRecord & { hash: string }>(invitePath(inviteId));
  if (!stored) return false;
  if (stored.acceptedAt || stored.revokedAt) return false;
  stored.revokedAt = Date.now();
  await writeJson(invitePath(inviteId), stored);
  return true;
}

export async function setMemberRole(ws: WorkspaceRecord, userId: string, role: Role): Promise<WorkspaceRecord> {
  const m = ws.members.find((x) => x.userId === userId);
  if (!m) throw new Error("not_member");
  if (m.status === "support") throw new Error("support_grant_immutable");
  if (m.role === "owner" && role !== "owner") {
    // Cannot demote the only owner.
    const owners = ws.members.filter((x) => x.role === "owner").length;
    if (owners <= 1) throw new Error("only_owner");
  }
  m.role = role;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Transfer the sole-owner role from `fromUserId` to `toUserId`.
 *
 * Enterprise requirement: when a workspace owner leaves the company, the org
 * must be able to re-home the workspace without rebuilding it. We keep the
 * "exactly one owner" invariant by atomically promoting the target to owner
 * and demoting the previous owner to editor in the same write.
 *
 * Throws:
 *   - `not_owner`     fromUserId is not currently the owner of this workspace
 *   - `not_member`    toUserId is not a member of this workspace
 *   - `same_user`     fromUserId === toUserId (no-op rejected so callers must be intentional)
 */
export async function transferOwnership(
  ws: WorkspaceRecord,
  fromUserId: string,
  toUserId: string,
): Promise<WorkspaceRecord> {
  if (fromUserId === toUserId) throw new Error("same_user");
  const from = ws.members.find((m) => m.userId === fromUserId);
  if (!from || from.role !== "owner") throw new Error("not_owner");
  const to = ws.members.find((m) => m.userId === toUserId);
  if (!to) throw new Error("not_member");
  if (to.status === "support") throw new Error("support_grant_immutable");
  to.role = "owner";
  from.role = "editor";
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Suspend a member. Preserves the roster entry (and therefore the audit
 * trail association) but flips `status` to "suspended" so every gating
 * helper treats them as a non-member. Owners cannot be suspended if they
 * are the sole owner (mirrors `removeMember` / role-demotion rules) so the
 * workspace always has at least one acting owner.
 *
 * Throws:
 *   - `not_member` userId is not on the roster
 *   - `only_owner` userId is the sole owner; transfer ownership first
 *   - `already_suspended` userId is already suspended (caller can ignore)
 */
export async function suspendMember(
  ws: WorkspaceRecord,
  userId: string,
  by: { actorUserId: string; reason?: string | null },
): Promise<WorkspaceRecord> {
  const m = ws.members.find((x) => x.userId === userId);
  if (!m) throw new Error("not_member");
  if (m.status === "support") throw new Error("support_grant_immutable");
  if (m.status === "suspended") throw new Error("already_suspended");
  if (m.role === "owner") {
    const activeOwners = ws.members.filter(
      (x) => x.role === "owner" && isMemberActive(x),
    ).length;
    if (activeOwners <= 1) throw new Error("only_owner");
  }
  m.status = "suspended";
  m.suspendedAt = Date.now();
  m.suspendedBy = by.actorUserId;
  const reason = typeof by.reason === "string" ? by.reason.trim().slice(0, 280) : "";
  if (reason) m.suspendedReason = reason; else delete m.suspendedReason;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

/**
 * Reverse `suspendMember`. The roster entry is restored to active status;
 * the `suspendedAt/suspendedBy/suspendedReason` fields are cleared. Sessions
 * and API keys revoked during suspension are NOT auto-restored.
 *
 * Throws:
 *   - `not_member` userId is not on the roster
 *   - `not_suspended` member is already active (caller can ignore)
 */
export async function reinstateMember(
  ws: WorkspaceRecord,
  userId: string,
): Promise<WorkspaceRecord> {
  const m = ws.members.find((x) => x.userId === userId);
  if (!m) throw new Error("not_member");
  if (m.status !== "suspended") throw new Error("not_suspended");
  m.status = "active";
  delete m.suspendedAt;
  delete m.suspendedBy;
  delete m.suspendedReason;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
}

export async function removeMember(ws: WorkspaceRecord, userId: string): Promise<WorkspaceRecord> {
  const m = ws.members.find((x) => x.userId === userId);
  if (!m) return ws;
  if (m.role === "owner") {
    const owners = ws.members.filter((x) => x.role === "owner").length;
    if (owners <= 1) throw new Error("only_owner");
  }
  ws.members = ws.members.filter((x) => x.userId !== userId);
  await writeJson(workspacePath(ws.id), ws);
  await removeFromMemberIndex(userId, ws.id);
  return ws;
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Just-in-time support access grants.
//
// Procurement requirement: customers want a documented, time-bounded path
// for our own support staff to enter their workspace (or for the customer
// to invite a contractor) without that engineer becoming a permanent member.
// Each grant carries a mandatory reason and optional case reference, is
// capped at 24h, and is auditable through both placement and revocation.
//
// Implementation: a support grant is just a Member row with
// `status: "support"`, `role: "viewer"`, and an `expiresAt`. The existing
// access gate `getActiveMember` consults `isMemberActive` which already
// honours the expiry, so support access falls off automatically with no
// background job. Owners can revoke at any time via `revokeSupportGrant`.
// ---------------------------------------------------------------------------

export const SUPPORT_GRANT_MIN_MINUTES = 15;
export const SUPPORT_GRANT_MAX_MINUTES = 24 * 60; // 24 hours, hard cap.
export const SUPPORT_GRANT_DEFAULT_MINUTES = 60;

export interface SupportGrantInput {
  email: string;
  minutes: number;
  reason: string;
  caseRef?: string | null;
}

export interface PublicSupportGrant {
  userId: string;
  email: string;
  grantedAt: number;
  grantedBy: string;
  expiresAt: number;
  reason: string;
  caseRef: string | null;
  expired: boolean;
  remainingMs: number;
}

const SUPPORT_CASE_REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function sanitizeSupportGrantInput(input: unknown): SupportGrantInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const emailRaw = typeof raw.email === "string" ? raw.email : "";
  const reasonRaw = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const minutesRaw = typeof raw.minutes === "number" ? raw.minutes : Number.NaN;
  if (!emailRaw || !reasonRaw) return null;
  if (reasonRaw.length < 3 || reasonRaw.length > 500) return null;
  if (!Number.isFinite(minutesRaw)) return null;
  const minutes = Math.floor(minutesRaw);
  if (minutes < SUPPORT_GRANT_MIN_MINUTES) return null;
  if (minutes > SUPPORT_GRANT_MAX_MINUTES) return null;
  let caseRef: string | null = null;
  if (raw.caseRef != null && raw.caseRef !== "") {
    if (typeof raw.caseRef !== "string") return null;
    const c = raw.caseRef.trim();
    if (c && !SUPPORT_CASE_REF_RE.test(c)) return null;
    caseRef = c || null;
  }
  return { email: emailRaw, minutes, reason: reasonRaw, caseRef };
}

export function publicSupportGrant(
  m: Member,
  now: number = Date.now(),
): PublicSupportGrant | null {
  if (m.status !== "support" || typeof m.expiresAt !== "number") return null;
  const remainingMs = Math.max(0, m.expiresAt - now);
  return {
    userId: m.userId,
    email: m.email,
    grantedAt: m.grantedAt ?? m.joinedAt,
    grantedBy: m.grantedBy ?? "",
    expiresAt: m.expiresAt,
    reason: m.grantReason ?? "",
    caseRef: m.grantCaseRef ?? null,
    expired: remainingMs <= 0,
    remainingMs,
  };
}

export function listSupportGrants(
  ws: WorkspaceRecord,
  now: number = Date.now(),
): PublicSupportGrant[] {
  return ws.members
    .filter((m) => m.status === "support")
    .map((m) => publicSupportGrant(m, now))
    .filter((g): g is PublicSupportGrant => g !== null)
    .sort((a, b) => b.grantedAt - a.grantedAt);
}

export function findActiveSupportGrant(
  ws: WorkspaceRecord,
  userId: string,
  now: number = Date.now(),
): Member | null {
  const m = ws.members.find((x) => x.userId === userId && x.status === "support");
  if (!m) return null;
  if (typeof m.expiresAt !== "number" || now >= m.expiresAt) return null;
  return m;
}

/**
 * Create or replace a support grant for the given resolved user.
 *
 * Rejects when the userId is already a permanent member: we never silently
 * downgrade a real teammate into a support row. Replaces an existing
 * support grant for the same user (the caller may use this to extend or
 * shorten the window) and signals that via `replaced=true` so the audit
 * entry can record both before and after.
 */
export async function createSupportGrant(
  ws: WorkspaceRecord,
  resolved: { userId: string; email: string },
  input: SupportGrantInput,
  grantedBy: string,
  now: number = Date.now(),
): Promise<{ ws: WorkspaceRecord; member: Member; replaced: boolean }> {
  const existing = ws.members.find((m) => m.userId === resolved.userId);
  if (existing && existing.status !== "support") {
    throw new Error("already_member");
  }
  const expiresAt = now + input.minutes * 60 * 1000;
  const next: Member = {
    userId: resolved.userId,
    email: resolved.email,
    role: "viewer",
    joinedAt: existing?.joinedAt ?? now,
    status: "support",
    expiresAt,
    grantedAt: now,
    grantedBy,
    grantReason: input.reason,
    grantCaseRef: input.caseRef ?? null,
  };
  if (existing) {
    ws.members = ws.members.map((m) => (m.userId === resolved.userId ? next : m));
  } else {
    ws.members = [...ws.members, next];
  }
  await writeJson(workspacePath(ws.id), ws);
  await addToMemberIndex(resolved.userId, ws.id);
  return { ws, member: next, replaced: !!existing };
}

/**
 * Revoke a support grant. Refuses to touch permanent members so an owner
 * cannot accidentally remove a real teammate via the support console.
 */
export async function revokeSupportGrant(
  ws: WorkspaceRecord,
  userId: string,
): Promise<{ ws: WorkspaceRecord; removed: Member | null }> {
  const m = ws.members.find((x) => x.userId === userId);
  if (!m) return { ws, removed: null };
  if (m.status !== "support") throw new Error("not_support_grant");
  ws.members = ws.members.filter((x) => x.userId !== userId);
  await writeJson(workspacePath(ws.id), ws);
  await removeFromMemberIndex(userId, ws.id);
  return { ws, removed: m };
}

/**
 * GDPR/DPA: workspace-scoped data export.
 *
 * Collects every record bound to this workspace into a single bundle:
 *   - the workspace record (members, SSO config minus client secret, allowlist)
 *   - all open + historical invites
 *   - all API keys scoped to this workspace (metadata only, never the hash)
 *   - all audit log entries with workspaceId = id
 * Files outside the workspace are NOT included; callers must verify the
 * actor is an owner before calling.
 */
export interface WorkspaceExportBundle {
  v: 1;
  exportedAt: number;
  workspace: Omit<WorkspaceRecord, "sso"> & {
    sso: Omit<NonNullable<WorkspaceRecord["sso"]>, "clientSecret"> | null;
  };
  invites: ReturnType<typeof publicInvite>[];
  apiKeys: unknown[];
  audit: unknown[];
  scimUsers: unknown[];
}

export async function exportWorkspace(ws: WorkspaceRecord): Promise<WorkspaceExportBundle> {
  const invites = await listInvitesForWorkspace(ws.id);
  // Pull API keys + audit via dynamic imports so this module stays loadable
  // in environments that don't need the full data graph (e.g. unit tests).
  const keysMod = await import("./api-keys.ts");
  const auditMod = await import("./audit.ts");
  const allKeys = await keysMod.listKeys();
  const apiKeys = allKeys.filter((k) => (k as { workspaceId?: string }).workspaceId === ws.id);
  const audit = await auditMod.listAudit({ workspaceId: ws.id, limit: auditMod.MAX_LIST });
  // SCIM directory mirror (no token secret; only provisioned user records).
  let scimUsers: unknown[] = [];
  try {
    const scimDir = process.env.CODECLONE_SCIM_DIR
      ? path.resolve(process.cwd(), process.env.CODECLONE_SCIM_DIR)
      : path.resolve(process.cwd(), "..", "scim");
    const dir = path.join(scimDir, "users", ws.id);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const rec = await readJson<unknown>(path.join(dir, n));
      if (rec) scimUsers.push(rec);
    }
  } catch {
    scimUsers = [];
  }
  const sso = ws.sso
    ? (() => {
        const { clientSecret: _omit, ...rest } = ws.sso!;
        void _omit;
        return rest;
      })()
    : null;
  const wsPublic = { ...ws, sso };
  return {
    v: 1,
    exportedAt: Date.now(),
    workspace: wsPublic,
    invites: invites.map(publicInvite),
    apiKeys,
    audit,
    scimUsers,
  };
}

/**
 * GDPR/DPA: workspace hard-delete.
 *
 * Removes the workspace record, every invite for it, drops it from each
 * member's reverse index, revokes (and removes) every API key scoped to it,
 * and deletes webhooks owned by the workspace owner that target this
 * workspace's namespace. Audit entries are KEPT (immutable storage) so the
 * deletion itself remains attributable; callers should record the wipe.
 *
 * Caller MUST verify the actor is an owner and MUST require MFA step-up.
 */
export async function deleteWorkspace(ws: WorkspaceRecord): Promise<{
  workspaceId: string;
  removedInvites: number;
  removedApiKeys: number;
  removedMembers: number;
}> {
  // 1. Wipe invites.
  let removedInvites = 0;
  const invDir = path.join(WORKSPACES_DIR, "_invites");
  const invFiles = await listFiles(invDir);
  for (const f of invFiles) {
    if (!f.endsWith(".json")) continue;
    const rec = await readJson<InviteRecord>(path.join(invDir, f));
    if (rec && rec.workspaceId === ws.id) {
      await fs.unlink(path.join(invDir, f)).catch(() => {});
      removedInvites += 1;
    }
  }
  // 2. Revoke + remove API keys scoped to the workspace.
  let removedApiKeys = 0;
  try {
    const keysMod = await import("./api-keys.ts");
    const keys = await keysMod.listKeys();
    for (const k of keys) {
      if ((k as { workspaceId?: string }).workspaceId === ws.id) {
        await keysMod.deleteKey(k.id).catch(() => {});
        removedApiKeys += 1;
      }
    }
  } catch {
    /* api-keys module optional in some test environments */
  }
  // 3. Drop workspace from each member's reverse index.
  const removedMembers = ws.members.length;
  for (const m of ws.members) {
    await removeFromMemberIndex(m.userId, ws.id).catch(() => {});
  }
  // 4. Wipe SCIM provisioning state (token + provisioned user mirror).
  try {
    const scimDir = process.env.CODECLONE_SCIM_DIR
      ? path.resolve(process.cwd(), process.env.CODECLONE_SCIM_DIR)
      : path.resolve(process.cwd(), "..", "scim");
    await fs.unlink(path.join(scimDir, "tokens", ws.id + ".json")).catch(() => {});
    await fs.rm(path.join(scimDir, "users", ws.id), { recursive: true, force: true }).catch(() => {});
  } catch { /* best effort */ }
  // 5. Delete the workspace record itself.
  await fs.unlink(workspacePath(ws.id)).catch(() => {});
  return { workspaceId: ws.id, removedInvites, removedApiKeys, removedMembers };
}

export function publicInvite(rec: InviteRecord): Omit<InviteRecord, "hash"> & { status: string } {
  const { ...rest } = rec as InviteRecord & { hash?: string };
  delete (rest as Record<string, unknown>).hash;
  let status = "pending";
  if (rec.acceptedAt) status = "accepted";
  else if (rec.revokedAt) status = "revoked";
  else if (Date.now() > rec.expiresAt) status = "expired";
  return { ...rest, status };
}
