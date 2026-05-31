/**
 * SCIM 2.0 provisioning for codeclone workspaces.
 *
 * Enterprise IdPs (Okta, Azure AD / Entra ID, Google Workspace via
 * partners, OneLogin, JumpCloud) push users into downstream apps using
 * SCIM 2.0 (RFC 7644). This module implements the minimum surface those
 * IdPs probe during a connector setup:
 *
 *   POST   /scim/v2/{wsId}/Users          create a provisioned user
 *   GET    /scim/v2/{wsId}/Users          list with filter+pagination
 *   GET    /scim/v2/{wsId}/Users/{id}     fetch
 *   PUT    /scim/v2/{wsId}/Users/{id}     replace
 *   PATCH  /scim/v2/{wsId}/Users/{id}     attribute patch (active flag)
 *   DELETE /scim/v2/{wsId}/Users/{id}     deprovision (hard delete)
 *
 *   GET    /scim/v2/{wsId}/ServiceProviderConfig
 *   GET    /scim/v2/{wsId}/Schemas
 *   GET    /scim/v2/{wsId}/ResourceTypes
 *
 * Auth: per-workspace bearer token. The plaintext token is shown ONCE
 * at issue time; only a sha256 hash is persisted. Tokens are bound to
 * a single workspace id so a token leaked from workspace A can never
 * be replayed against workspace B (URL path + stored binding both
 * checked). Each provisioning mutation writes an immutable audit entry.
 *
 * Storage layout (filesystem, mirrors other lib modules):
 *
 *   $CODECLONE_SCIM_DIR/tokens/<workspaceId>.json
 *       { v, workspaceId, hash, prefix, createdAt, createdBy,
 *         lastUsedAt, rotatedAt }
 *
 *   $CODECLONE_SCIM_DIR/users/<workspaceId>/<scimId>.json
 *       SCIM core User resource (subset).
 *
 * Provisioned SCIM users do NOT auto-grant access to runs / API. They
 * exist as a directory mirror. A subsequent sign-in (magic link or SSO)
 * for the same email lifts them into the workspace.members list via
 * the existing auto-join machinery, so RBAC continues to flow through
 * one place. `active=false` is recorded and surfaced in the audit log,
 * blocking the next sign-in attempt for that email at the SSO callback.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getWorkspace, isEmailAllowedForWorkspace } from "./workspaces.ts";

const CWD = process.cwd();

export const SCIM_DIR = process.env.CODECLONE_SCIM_DIR
  ? path.resolve(CWD, process.env.CODECLONE_SCIM_DIR)
  : path.resolve(CWD, "..", "scim");

const TOKEN_PREFIX = "cc_scim_";
const TOKEN_BYTES = 30; // 40 base64url chars
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

export const SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_SCHEMA_SPC = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_SCHEMA_RESOURCETYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";

export interface ScimTokenRecord {
  v: 1;
  workspaceId: string;
  hash: string;       // sha256 hex of plaintext token (incl. prefix)
  prefix: string;     // first 14 chars of token for UI display
  createdAt: number;
  createdBy: string;  // userId of owner who issued
  lastUsedAt?: number;
  rotatedAt?: number;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;            // typically the email or IdP-provided login
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  active: boolean;
  meta: {
    resourceType: "User";
    created: string;           // ISO 8601
    lastModified: string;
    location: string;
    version: string;           // weak ETag
  };
}

interface StoredScimUser extends Omit<ScimUserResource, "meta" | "schemas"> {
  v: 1;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}
function tokenPath(workspaceId: string) {
  return path.join(SCIM_DIR, "tokens", `${workspaceId}.json`);
}
function usersDir(workspaceId: string) {
  return path.join(SCIM_DIR, "users", workspaceId);
}
function userPath(workspaceId: string, scimId: string) {
  return path.join(usersDir(workspaceId), `${scimId}.json`);
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(p, "utf8");
    return JSON.parse(buf) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}
async function writeJson(p: string, value: unknown) {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, p);
}

/* ------------------------------------------------------------------ */
/*  Tokens                                                            */
/* ------------------------------------------------------------------ */

function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

function newId(prefix: string, bytes = 8): string {
  return prefix + crypto.randomBytes(bytes).toString("hex").slice(0, 16);
}

export interface IssuedScimToken {
  record: ScimTokenRecord;
  plaintext: string; // shown exactly once
}

export async function issueScimToken(opts: {
  workspaceId: string;
  createdBy: string;
}): Promise<IssuedScimToken> {
  const plaintext = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const rec: ScimTokenRecord = {
    v: 1,
    workspaceId: opts.workspaceId,
    hash: hashToken(plaintext),
    prefix: plaintext.slice(0, 14),
    createdAt: Date.now(),
    createdBy: opts.createdBy,
  };
  await writeJson(tokenPath(opts.workspaceId), rec);
  return { record: rec, plaintext };
}

export async function rotateScimToken(opts: {
  workspaceId: string;
  rotatedBy: string;
}): Promise<IssuedScimToken | null> {
  const existing = await readJson<ScimTokenRecord>(tokenPath(opts.workspaceId));
  if (!existing) return null;
  const next = await issueScimToken({ workspaceId: opts.workspaceId, createdBy: opts.rotatedBy });
  next.record.rotatedAt = Date.now();
  await writeJson(tokenPath(opts.workspaceId), next.record);
  return next;
}

export async function revokeScimToken(workspaceId: string): Promise<boolean> {
  try {
    await fs.unlink(tokenPath(workspaceId));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

export async function getScimTokenMeta(workspaceId: string): Promise<{
  prefix: string; createdAt: number; lastUsedAt?: number; rotatedAt?: number;
} | null> {
  const rec = await readJson<ScimTokenRecord>(tokenPath(workspaceId));
  if (!rec) return null;
  return {
    prefix: rec.prefix,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    rotatedAt: rec.rotatedAt,
  };
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Validate a Bearer token presented at /scim/v2/<workspaceId>/...
 * Returns true only when the token's stored binding matches the URL
 * workspaceId. This is the cross-tenant isolation guarantee.
 */
export async function verifyScimToken(opts: {
  workspaceId: string;
  authHeader: string | null | undefined;
}): Promise<boolean> {
  if (!opts.authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(opts.authHeader.trim());
  if (!m) return false;
  const plain = m[1].trim();
  if (!plain.startsWith(TOKEN_PREFIX)) return false;

  const rec = await readJson<ScimTokenRecord>(tokenPath(opts.workspaceId));
  if (!rec) return false;
  // Reject if the stored token was somehow bound to a different workspace.
  if (rec.workspaceId !== opts.workspaceId) return false;
  if (!safeEq(hashToken(plain), rec.hash)) return false;
  // Touch lastUsedAt (best effort; do not block the request on write failure).
  rec.lastUsedAt = Date.now();
  writeJson(tokenPath(opts.workspaceId), rec).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ */
/*  User resources                                                    */
/* ------------------------------------------------------------------ */

export class ScimError extends Error {
  status: number;
  scimType?: string;
  constructor(status: number, message: string, scimType?: string) {
    super(message);
    this.status = status;
    this.scimType = scimType;
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: string) {
  const body: Record<string, unknown> = {
    schemas: [SCIM_SCHEMA_ERROR],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return body;
}

interface ScimUserInput {
  userName?: unknown;
  externalId?: unknown;
  name?: unknown;
  displayName?: unknown;
  emails?: unknown;
  active?: unknown;
}

function normalizeString(v: unknown, max = 320): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.slice(0, max);
}

function normalizeEmails(input: unknown): Array<{ value: string; primary?: boolean; type?: string }> | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Array<{ value: string; primary?: boolean; type?: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const value = normalizeString(r.value, 320);
    if (!value || !value.includes("@")) continue;
    const entry: { value: string; primary?: boolean; type?: string } = { value: value.toLowerCase() };
    if (typeof r.primary === "boolean") entry.primary = r.primary;
    const type = normalizeString(r.type, 32);
    if (type) entry.type = type;
    out.push(entry);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeName(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  const givenName = normalizeString(r.givenName, 80);
  const familyName = normalizeString(r.familyName, 80);
  const formatted = normalizeString(r.formatted, 200);
  if (!givenName && !familyName && !formatted) return undefined;
  const out: { givenName?: string; familyName?: string; formatted?: string } = {};
  if (givenName) out.givenName = givenName;
  if (familyName) out.familyName = familyName;
  if (formatted) out.formatted = formatted;
  return out;
}

function primaryEmail(emails?: Array<{ value: string; primary?: boolean }>): string | undefined {
  if (!emails || emails.length === 0) return undefined;
  return (emails.find((e) => e.primary)?.value ?? emails[0].value).toLowerCase();
}

function buildResource(stored: StoredScimUser, baseUrl: string): ScimUserResource {
  return {
    schemas: [SCIM_SCHEMA_USER],
    id: stored.id,
    externalId: stored.externalId,
    userName: stored.userName,
    name: stored.name,
    displayName: stored.displayName,
    emails: stored.emails,
    active: stored.active,
    meta: {
      resourceType: "User",
      created: new Date(stored.createdAt).toISOString(),
      lastModified: new Date(stored.updatedAt).toISOString(),
      location: `${baseUrl}/Users/${stored.id}`,
      version: `W/"${stored.updatedAt}"`,
    },
  };
}

async function listStoredUsers(workspaceId: string): Promise<StoredScimUser[]> {
  const dir = usersDir(workspaceId);
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: StoredScimUser[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = await readJson<StoredScimUser>(path.join(dir, n));
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/**
 * Tiny SCIM filter parser. IdPs typically send:
 *     userName eq "alice@acme.com"
 *     externalId eq "okta-123"
 * We support those two equality filters; anything else is a 400 to keep
 * connector authors honest (per RFC 7644 §3.4.2.2).
 */
function applyFilter(items: StoredScimUser[], filter?: string): StoredScimUser[] | { error: string } {
  if (!filter) return items;
  const m = /^(\w+)\s+eq\s+"([^"]+)"$/.exec(filter.trim());
  if (!m) return { error: `unsupported filter: ${filter.slice(0, 120)}` };
  const attr = m[1].toLowerCase();
  const val = m[2].toLowerCase();
  switch (attr) {
    case "username":
      return items.filter((u) => u.userName.toLowerCase() === val);
    case "externalid":
      return items.filter((u) => (u.externalId ?? "").toLowerCase() === val);
    case "active":
      return items.filter((u) => String(u.active).toLowerCase() === val);
    default:
      return { error: `unsupported attribute: ${attr}` };
  }
}

export interface ListUsersOptions {
  filter?: string;
  startIndex?: number; // 1-based per RFC
  count?: number;
}

export async function listUsers(workspaceId: string, baseUrl: string, opts: ListUsersOptions = {}) {
  const all = await listStoredUsers(workspaceId);
  const filtered = applyFilter(all, opts.filter);
  if (!Array.isArray(filtered)) throw new ScimError(400, filtered.error, "invalidFilter");
  const startIndex = Math.max(1, Math.floor(opts.startIndex ?? 1));
  const count = Math.min(MAX_PAGE, Math.max(0, Math.floor(opts.count ?? DEFAULT_PAGE)));
  const slice = filtered.slice(startIndex - 1, startIndex - 1 + count);
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: filtered.length,
    startIndex,
    itemsPerPage: slice.length,
    Resources: slice.map((s) => buildResource(s, baseUrl)),
  };
}

export async function getUser(workspaceId: string, id: string, baseUrl: string): Promise<ScimUserResource | null> {
  const rec = await readJson<StoredScimUser>(userPath(workspaceId, id));
  if (!rec) return null;
  return buildResource(rec, baseUrl);
}

export async function findUserByUserName(workspaceId: string, userName: string): Promise<StoredScimUser | null> {
  const all = await listStoredUsers(workspaceId);
  return all.find((u) => u.userName.toLowerCase() === userName.toLowerCase()) ?? null;
}

export async function createUser(opts: {
  workspaceId: string;
  body: ScimUserInput;
  baseUrl: string;
}): Promise<ScimUserResource> {
  const userName = normalizeString(opts.body.userName, 320);
  if (!userName) {
    throw new ScimError(400, "userName is required", "invalidValue");
  }
  const dup = await findUserByUserName(opts.workspaceId, userName);
  if (dup) throw new ScimError(409, "userName already exists", "uniqueness");

  const emails = normalizeEmails(opts.body.emails);
  // Enforce the workspace invite-domain allowlist. The IdP-supplied
  // userName is normally an email; if any email (userName or emails[])
  // is off-policy we refuse the provisioning request with a SCIM 400.
  const ws = await getWorkspace(opts.workspaceId);
  if (ws) {
    const candidates: string[] = [];
    if (userName) candidates.push(userName);
    if (Array.isArray(emails)) {
      for (const e of emails) {
        if (e && typeof e.value === "string") candidates.push(e.value);
      }
    }
    for (const c of candidates) {
      if (c.includes("@") && !isEmailAllowedForWorkspace(ws, c)) {
        throw new ScimError(
          400,
          "email domain not permitted by workspace invite domain allowlist",
          "invalidValue",
        );
      }
    }
  }
  const externalId = normalizeString(opts.body.externalId, 200);
  const name = normalizeName(opts.body.name);
  const displayName = normalizeString(opts.body.displayName, 200);
  const active = typeof opts.body.active === "boolean" ? opts.body.active : true;

  const now = Date.now();
  const id = newId("scu_", 10);
  const stored: StoredScimUser = {
    v: 1,
    workspaceId: opts.workspaceId,
    id,
    externalId,
    userName,
    name,
    displayName,
    emails,
    active,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(userPath(opts.workspaceId, id), stored);
  return buildResource(stored, opts.baseUrl);
}

export async function replaceUser(opts: {
  workspaceId: string;
  id: string;
  body: ScimUserInput;
  baseUrl: string;
}): Promise<ScimUserResource | null> {
  const existing = await readJson<StoredScimUser>(userPath(opts.workspaceId, opts.id));
  if (!existing) return null;
  const userName = normalizeString(opts.body.userName, 320) ?? existing.userName;
  // Enforce uniqueness if the userName actually changed.
  if (userName.toLowerCase() !== existing.userName.toLowerCase()) {
    const dup = await findUserByUserName(opts.workspaceId, userName);
    if (dup && dup.id !== existing.id) throw new ScimError(409, "userName already exists", "uniqueness");
  }
  const updated: StoredScimUser = {
    ...existing,
    userName,
    externalId: normalizeString(opts.body.externalId, 200) ?? existing.externalId,
    name: normalizeName(opts.body.name) ?? existing.name,
    displayName: normalizeString(opts.body.displayName, 200) ?? existing.displayName,
    emails: normalizeEmails(opts.body.emails) ?? existing.emails,
    active: typeof opts.body.active === "boolean" ? opts.body.active : existing.active,
    updatedAt: Date.now(),
  };
  await writeJson(userPath(opts.workspaceId, opts.id), updated);
  return buildResource(updated, opts.baseUrl);
}

/**
 * Minimal PATCH support: Operations[{op: "replace", path?: "active", value}].
 * Okta deactivation sends exactly this shape. Anything richer is 400.
 */
export async function patchUser(opts: {
  workspaceId: string;
  id: string;
  body: { Operations?: unknown; schemas?: unknown };
  baseUrl: string;
}): Promise<ScimUserResource | null> {
  const existing = await readJson<StoredScimUser>(userPath(opts.workspaceId, opts.id));
  if (!existing) return null;
  const ops = Array.isArray(opts.body.Operations) ? opts.body.Operations : null;
  if (!ops || ops.length === 0) {
    throw new ScimError(400, "Operations is required", "invalidValue");
  }
  let touched = false;
  for (const raw of ops) {
    if (!raw || typeof raw !== "object") {
      throw new ScimError(400, "operation must be an object", "invalidSyntax");
    }
    const op = (raw as Record<string, unknown>).op;
    const opStr = typeof op === "string" ? op.toLowerCase() : "";
    if (opStr !== "replace" && opStr !== "add") {
      throw new ScimError(400, `unsupported op: ${op}`, "invalidSyntax");
    }
    const pathAttr = (raw as Record<string, unknown>).path;
    const value = (raw as Record<string, unknown>).value;
    // Whole-resource patch: { op: "replace", value: { active: false } }
    const valueObj = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!pathAttr && valueObj) {
      if (typeof valueObj.active === "boolean") {
        existing.active = valueObj.active;
        touched = true;
      }
      const dn = normalizeString(valueObj.displayName, 200);
      if (dn) { existing.displayName = dn; touched = true; }
      continue;
    }
    if (typeof pathAttr !== "string") {
      throw new ScimError(400, "path must be a string", "invalidPath");
    }
    const attr = pathAttr.toLowerCase();
    if (attr === "active" && typeof value === "boolean") {
      existing.active = value;
      touched = true;
    } else if (attr === "displayname" && typeof value === "string") {
      const dn = normalizeString(value, 200);
      if (dn) { existing.displayName = dn; touched = true; }
    } else {
      throw new ScimError(400, `unsupported path: ${pathAttr}`, "invalidPath");
    }
  }
  if (!touched) {
    throw new ScimError(400, "no supported operations applied", "invalidValue");
  }
  existing.updatedAt = Date.now();
  await writeJson(userPath(opts.workspaceId, opts.id), existing);
  return buildResource(existing, opts.baseUrl);
}

export async function deleteUser(workspaceId: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(userPath(workspaceId, id));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Metadata documents                                                */
/* ------------------------------------------------------------------ */

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCIM_SCHEMA_SPC],
    documentationUri: `${baseUrl}/docs`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer Token",
        description: "Per-workspace bearer token issued in the workspace settings.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  };
}

export function resourceTypes(baseUrl: string) {
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: 1,
    Resources: [
      {
        schemas: [SCIM_SCHEMA_RESOURCETYPE],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "User Account",
        schema: SCIM_SCHEMA_USER,
        meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
      },
    ],
  };
}

export function userSchemaDoc(baseUrl: string) {
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: 1,
    Resources: [
      {
        id: SCIM_SCHEMA_USER,
        name: "User",
        description: "SCIM core User resource (subset).",
        attributes: [
          { name: "userName", type: "string", required: true, uniqueness: "server" },
          { name: "externalId", type: "string", required: false },
          { name: "displayName", type: "string", required: false },
          { name: "active", type: "boolean", required: false },
          { name: "emails", type: "complex", multiValued: true, required: false },
          { name: "name", type: "complex", required: false },
        ],
        meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_SCHEMA_USER}` },
      },
    ],
  };
}

/**
 * SCIM base URL for a workspace. Built from the request so we honour
 * forwarded proto/host headers behind reverse proxies. Falls back to
 * the request URL's own origin.
 */
export function scimBaseUrl(req: Request, workspaceId: string): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}/scim/v2/${workspaceId}`;
}
