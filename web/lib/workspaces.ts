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
  sso?: {
    provider: "oidc";
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowedDomain: string;
    enforced: boolean;
    updatedAt: number;
    updatedBy: string;
  } | null;
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

export function getMember(ws: WorkspaceRecord, userId: string): Member | null {
  return ws.members.find((m) => m.userId === userId) ?? null;
}

export function canInvite(ws: WorkspaceRecord, userId: string): boolean {
  const m = getMember(ws, userId);
  if (!m) return false;
  return m.role === "owner" || m.role === "editor";
}

export function canManage(ws: WorkspaceRecord, userId: string): boolean {
  const m = getMember(ws, userId);
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

export async function setSsoConfig(
  ws: WorkspaceRecord,
  cfg: WorkspaceRecord["sso"],
): Promise<WorkspaceRecord> {
  ws.sso = cfg ?? null;
  await writeJson(workspacePath(ws.id), ws);
  return ws;
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
  if (m.role === "owner" && role !== "owner") {
    // Cannot demote the only owner.
    const owners = ws.members.filter((x) => x.role === "owner").length;
    if (owners <= 1) throw new Error("only_owner");
  }
  m.role = role;
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

export function publicInvite(rec: InviteRecord): Omit<InviteRecord, "hash"> & { status: string } {
  const { ...rest } = rec as InviteRecord & { hash?: string };
  delete (rest as Record<string, unknown>).hash;
  let status = "pending";
  if (rec.acceptedAt) status = "accepted";
  else if (rec.revokedAt) status = "revoked";
  else if (Date.now() > rec.expiresAt) status = "expired";
  return { ...rest, status };
}
