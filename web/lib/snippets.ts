/**
 * Snippets library — per-user reusable code snippets.
 *
 * A returning user often compares new code against the same baselines
 * (canonical implementations, suspected sources, internal templates).
 * The snippets library lets them save, tag, and reload those baselines
 * into /compare without copy-pasting from elsewhere.
 *
 * Storage: filesystem, mirroring the rest of the app.
 *   $CODECLONE_SNIPPETS_DIR/<userId>/<id>.json
 * Defaults to ../snippets relative to web/.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const SNIPPETS_DIR = process.env.CODECLONE_SNIPPETS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_SNIPPETS_DIR)
  : path.resolve(CWD, "..", "snippets");

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TITLE_LEN = 120;
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 32;
export const MAX_LANG_LEN = 32;
export const MAX_SNIPPETS_PER_USER = 500;

export interface SnippetRecord {
  v: 1;
  id: string;
  userId: string;
  title: string;
  language: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateSnippetInput {
  title: string;
  language: string;
  body: string;
  tags?: string[];
}

export interface UpdateSnippetInput {
  title?: string;
  language?: string;
  body?: string;
  tags?: string[];
}

function newId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

function isId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(id);
}

function isUserId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

function normalizeTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, MAX_TITLE_LEN);
}

function normalizeLanguage(input: unknown): string {
  if (typeof input !== "string") return "";
  const v = input.trim().toLowerCase().slice(0, MAX_LANG_LEN);
  return /^[a-z0-9_+#.-]+$/.test(v) ? v : "";
}

function normalizeBody(input: unknown): string {
  if (typeof input !== "string") return "";
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength > MAX_BODY_BYTES) {
    return buf.subarray(0, MAX_BODY_BYTES).toString("utf8");
  }
  return input;
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_TAG_LEN);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

async function ensureUserDir(userId: string): Promise<string> {
  const dir = path.join(SNIPPETS_DIR, userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function recordPath(userId: string, id: string): string {
  return path.join(SNIPPETS_DIR, userId, `${id}.json`);
}

export class SnippetError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function createSnippet(
  userId: string,
  input: CreateSnippetInput,
): Promise<SnippetRecord> {
  if (!isUserId(userId)) throw new SnippetError(400, "invalid user");
  const title = normalizeTitle(input.title);
  const language = normalizeLanguage(input.language);
  const body = normalizeBody(input.body);
  const tags = normalizeTags(input.tags);
  if (!title) throw new SnippetError(400, "title required");
  if (!language) throw new SnippetError(400, "language required");
  if (!body.trim()) throw new SnippetError(400, "body required");

  const existing = await listSnippets(userId);
  if (existing.length >= MAX_SNIPPETS_PER_USER) {
    throw new SnippetError(429, "snippet quota reached");
  }

  await ensureUserDir(userId);
  const now = Date.now();
  const rec: SnippetRecord = {
    v: 1,
    id: newId(),
    userId,
    title,
    language,
    body,
    tags,
    createdAt: now,
    updatedAt: now,
  };
  await fs.writeFile(recordPath(userId, rec.id), JSON.stringify(rec), "utf8");
  return rec;
}

export async function loadSnippet(
  userId: string,
  id: string,
): Promise<SnippetRecord | null> {
  if (!isUserId(userId) || !isId(id)) return null;
  try {
    const buf = await fs.readFile(recordPath(userId, id), "utf8");
    const rec = JSON.parse(buf) as SnippetRecord;
    if (rec && rec.v === 1 && rec.userId === userId) return rec;
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function updateSnippet(
  userId: string,
  id: string,
  patch: UpdateSnippetInput,
): Promise<SnippetRecord | null> {
  const rec = await loadSnippet(userId, id);
  if (!rec) return null;
  if (patch.title !== undefined) {
    const t = normalizeTitle(patch.title);
    if (!t) throw new SnippetError(400, "title required");
    rec.title = t;
  }
  if (patch.language !== undefined) {
    const l = normalizeLanguage(patch.language);
    if (!l) throw new SnippetError(400, "language required");
    rec.language = l;
  }
  if (patch.body !== undefined) {
    const b = normalizeBody(patch.body);
    if (!b.trim()) throw new SnippetError(400, "body required");
    rec.body = b;
  }
  if (patch.tags !== undefined) {
    rec.tags = normalizeTags(patch.tags);
  }
  rec.updatedAt = Date.now();
  await fs.writeFile(recordPath(userId, id), JSON.stringify(rec), "utf8");
  return rec;
}

export async function deleteSnippet(
  userId: string,
  id: string,
): Promise<boolean> {
  if (!isUserId(userId) || !isId(id)) return false;
  try {
    await fs.unlink(recordPath(userId, id));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface ListOptions {
  q?: string;
  tag?: string;
  language?: string;
  limit?: number;
  offset?: number;
}

export async function listSnippets(
  userId: string,
  opts: ListOptions = {},
): Promise<SnippetRecord[]> {
  if (!isUserId(userId)) return [];
  const dir = path.join(SNIPPETS_DIR, userId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: SnippetRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const buf = await fs.readFile(path.join(dir, f), "utf8");
      const rec = JSON.parse(buf) as SnippetRecord;
      if (rec && rec.v === 1 && rec.userId === userId) records.push(rec);
    } catch {
      // skip corrupt records silently
    }
  }
  let out = records.sort((a, b) => b.updatedAt - a.updatedAt);
  const q = (opts.q ?? "").trim().toLowerCase();
  if (q) {
    out = out.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q) ||
        r.tags.some((t) => t.includes(q)),
    );
  }
  if (opts.tag) {
    const t = opts.tag.trim().toLowerCase();
    out = out.filter((r) => r.tags.includes(t));
  }
  if (opts.language) {
    const l = normalizeLanguage(opts.language);
    if (l) out = out.filter((r) => r.language === l);
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  return out.slice(offset, offset + limit);
}

export async function countSnippets(userId: string): Promise<number> {
  const all = await listSnippets(userId, { limit: 500 });
  return all.length;
}
