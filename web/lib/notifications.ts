/**
 * Per-user in-app notifications inbox.
 *
 * Storage: one JSON-lines file per user under $CODECLONE_NOTIFICATIONS_DIR,
 * matching the file-backed style of the rest of the app. Each line is a
 * NotificationRecord. We append on emit and rewrite the file on read-state
 * or delete changes (small files in practice; capped at MAX_PER_USER).
 *
 * Emission is best-effort: if writing the inbox fails we log and move on
 * so the originating action (sharing, batch run, webhook delivery) never
 * fails because of a notification side effect.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const NOTIFICATIONS_DIR = process.env.CODECLONE_NOTIFICATIONS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_NOTIFICATIONS_DIR)
  : path.resolve(CWD, "..", "runs", "notifications");

export const MAX_PER_USER = 200;
export const MAX_TITLE_LEN = 160;
export const MAX_BODY_LEN = 600;

export type NotificationKind =
  | "share.created"
  | "batch.completed"
  | "webhook.failed"
  | "system";

export interface NotificationRecord {
  v: 1;
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  href?: string;
  createdAt: number;
  readAt?: number;
  meta?: Record<string, string | number | boolean>;
}

export interface CreateInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  href?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface ListOptions {
  limit?: number;
  unreadOnly?: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export function isNotificationId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function userFile(userId: string): string {
  if (!USER_RE.test(userId)) {
    throw new Error("Invalid user id for notifications.");
  }
  return path.join(NOTIFICATIONS_DIR, `${userId}.ndjson`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(NOTIFICATIONS_DIR, { recursive: true });
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "\u2026";
}

function parseLine(line: string): NotificationRecord | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s) as NotificationRecord;
    if (!obj || obj.v !== 1 || !isNotificationId(obj.id)) return null;
    return obj;
  } catch {
    return null;
  }
}

async function readAll(userId: string): Promise<NotificationRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(userFile(userId), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: NotificationRecord[] = [];
  for (const line of raw.split("\n")) {
    const rec = parseLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

async function writeAll(userId: string, recs: NotificationRecord[]): Promise<void> {
  await ensureDir();
  const file = userFile(userId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = recs.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(tmp, body ? body + "\n" : "", "utf-8");
  await fs.rename(tmp, file);
}

export async function createNotification(input: CreateInput): Promise<NotificationRecord> {
  if (!USER_RE.test(input.userId)) throw new Error("Invalid user id.");
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("Notification title required.");
  }
  const rec: NotificationRecord = {
    v: 1,
    id: newId(),
    userId: input.userId,
    kind: input.kind,
    title: clip(input.title, MAX_TITLE_LEN),
    body: input.body ? clip(input.body, MAX_BODY_LEN) : undefined,
    href: typeof input.href === "string" && input.href.startsWith("/") ? input.href : undefined,
    createdAt: Date.now(),
    meta: input.meta,
  };
  await ensureDir();
  // Read, prepend, trim, rewrite. Cheap for <=MAX_PER_USER records.
  const existing = await readAll(input.userId);
  const next = [rec, ...existing].slice(0, MAX_PER_USER);
  await writeAll(input.userId, next);
  return rec;
}

/** Best-effort emit: never throws. Returns the record on success, null on failure. */
export async function emitNotification(input: CreateInput): Promise<NotificationRecord | null> {
  try {
    return await createNotification(input);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[notifications] emit failed:", (e as Error).message);
    return null;
  }
}

export async function listNotifications(
  userId: string,
  opts: ListOptions = {},
): Promise<NotificationRecord[]> {
  const all = await readAll(userId);
  const filtered = opts.unreadOnly ? all.filter((r) => !r.readAt) : all;
  const limit = Math.max(1, Math.min(MAX_PER_USER, opts.limit ?? 100));
  return filtered.slice(0, limit);
}

export async function countUnread(userId: string): Promise<number> {
  const all = await readAll(userId);
  let n = 0;
  for (const r of all) if (!r.readAt) n += 1;
  return n;
}

export async function markRead(
  userId: string,
  id: string,
  read: boolean,
): Promise<NotificationRecord | null> {
  if (!isNotificationId(id)) return null;
  const all = await readAll(userId);
  let updated: NotificationRecord | null = null;
  const next = all.map((r) => {
    if (r.id !== id) return r;
    const out: NotificationRecord = { ...r };
    if (read) out.readAt = Date.now();
    else delete out.readAt;
    updated = out;
    return out;
  });
  if (!updated) return null;
  await writeAll(userId, next);
  return updated;
}

export async function markAllRead(userId: string): Promise<number> {
  const all = await readAll(userId);
  const now = Date.now();
  let n = 0;
  const next = all.map((r) => {
    if (r.readAt) return r;
    n += 1;
    return { ...r, readAt: now };
  });
  if (n > 0) await writeAll(userId, next);
  return n;
}

export async function deleteNotification(userId: string, id: string): Promise<boolean> {
  if (!isNotificationId(id)) return false;
  const all = await readAll(userId);
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  await writeAll(userId, next);
  return true;
}

export async function clearAll(userId: string): Promise<number> {
  const all = await readAll(userId);
  if (!all.length) return 0;
  await writeAll(userId, []);
  return all.length;
}
