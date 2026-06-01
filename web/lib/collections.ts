/**
 * Filesystem-backed collections of shares.
 *
 * A collection groups any number of public /r/<id> shares under a single
 * title so a user can hand a teammate one URL ("/c/<id>") that lists
 * every dupe they found this sprint. Records live in $CODECLONE_COLLECTIONS_DIR
 * (defaults to ../collections relative to web/), one JSON file per id.
 *
 * Public read by id matches the share model. Mutation is open in single-
 * tenant FS mode, same as /api/share. Schema is versioned via `v`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadShare, type ScopeHint, type ShareRecord } from "./share.ts";

const CWD = process.cwd();

export const COLLECTIONS_DIR = process.env.CODECLONE_COLLECTIONS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_COLLECTIONS_DIR)
  : path.resolve(CWD, "..", "collections");

const ID_LEN = 10;
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_ITEMS = 200;

export interface CollectionRecord {
  v: 1;
  id: string;
  title: string;
  description?: string;
  shareIds: string[];
  createdAt: number;
  updatedAt: number;
  /**
   * Workspace that owns this collection. Required for any record
   * created through /v1/collections. Legacy records written before
   * this field existed (or by the single-tenant FS dashboard path)
   * leave it undefined and are treated as global by the legacy
   * dashboard routes only; /v1 callers can never see records that
   * do not match their workspace.
   */
  workspaceId?: string;
}

export interface CreateCollectionInput {
  title: string;
  description?: string;
  shareIds?: string[];
  workspaceId?: string;
}

export interface UpdateCollectionInput {
  title?: string;
  description?: string | null;
}

export interface CollectionSummary {
  id: string;
  title: string;
  description?: string;
  count: number;
  createdAt: number;
  updatedAt: number;
}

function newId(): string {
  return crypto.randomBytes(8).toString("base64url").slice(0, ID_LEN);
}

export function isCollectionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(id);
}

function isShareIdLike(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(id);
}

async function ensureDir() {
  await fs.mkdir(COLLECTIONS_DIR, { recursive: true });
}

function collectionFile(id: string): string {
  return path.join(COLLECTIONS_DIR, `${id}.json`);
}

function sanitizeTitle(t: unknown): string {
  if (typeof t !== "string") throw new Error("title must be a string");
  const cleaned = t.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
  if (!cleaned) throw new Error("title must not be empty");
  return cleaned;
}

function sanitizeDescription(d: unknown): string | undefined {
  if (d === null || d === undefined) return undefined;
  if (typeof d !== "string") throw new Error("description must be a string");
  const cleaned = d.replace(/\s+/g, " ").trim().slice(0, MAX_DESC_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeShareIds(ids: unknown): string[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) throw new Error("shareIds must be an array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (!isShareIdLike(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export async function createCollection(
  input: CreateCollectionInput,
): Promise<CollectionRecord> {
  const title = sanitizeTitle(input.title);
  const description = sanitizeDescription(input.description);
  const shareIds = sanitizeShareIds(input.shareIds);
  await ensureDir();
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = newId();
    const file = collectionFile(id);
    try {
      await fs.access(file);
      continue;
    } catch {
      // free
    }
    const now = Date.now();
    const rec: CollectionRecord = {
      v: 1,
      id,
      title,
      ...(description ? { description } : {}),
      shareIds,
      createdAt: now,
      updatedAt: now,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    };
    await fs.writeFile(file, JSON.stringify(rec), "utf-8");
    return rec;
  }
  throw new Error("could not allocate collection id");
}

export async function loadCollection(
  id: string,
): Promise<CollectionRecord | null> {
  if (!isCollectionId(id)) return null;
  try {
    const buf = await fs.readFile(collectionFile(id), "utf-8");
    const rec = JSON.parse(buf) as CollectionRecord;
    if (!rec || rec.v !== 1 || typeof rec.id !== "string") return null;
    if (!Array.isArray(rec.shareIds)) rec.shareIds = [];
    return rec;
  } catch {
    return null;
  }
}

export async function updateCollection(
  id: string,
  patch: UpdateCollectionInput,
): Promise<CollectionRecord | null> {
  const rec = await loadCollection(id);
  if (!rec) return null;
  let changed = false;
  if (patch.title !== undefined) {
    const t = sanitizeTitle(patch.title);
    if (t !== rec.title) {
      rec.title = t;
      changed = true;
    }
  }
  if (patch.description !== undefined) {
    if (patch.description === null || patch.description === "") {
      if (rec.description !== undefined) {
        delete rec.description;
        changed = true;
      }
    } else {
      const d = sanitizeDescription(patch.description);
      if (d !== rec.description) {
        rec.description = d;
        changed = true;
      }
    }
  }
  if (changed) {
    rec.updatedAt = Date.now();
    await fs.writeFile(collectionFile(id), JSON.stringify(rec), "utf-8");
  }
  return rec;
}

export async function deleteCollection(id: string): Promise<boolean> {
  if (!isCollectionId(id)) return false;
  try {
    await fs.unlink(collectionFile(id));
    return true;
  } catch {
    return false;
  }
}

export async function addItem(
  id: string,
  shareId: string,
  opts: { shareScope?: ScopeHint } = {},
): Promise<CollectionRecord | null> {
  if (!isShareIdLike(shareId)) throw new Error("invalid shareId");
  // confirm the share actually exists; refuse otherwise so collections
  // never accumulate dangling references. When called from a tenant
  // -scoped /v1 path, the caller passes shareScope so we cannot link a
  // share owned by workspace B into workspace A's collection even if
  // both stores share the same filesystem prefix.
  const share = await loadShare(shareId, opts.shareScope);
  if (!share) throw new Error("share not found");
  const rec = await loadCollection(id);
  if (!rec) return null;
  if (rec.shareIds.includes(shareId)) return rec;
  if (rec.shareIds.length >= MAX_ITEMS) {
    throw new Error(`collection is full (max ${MAX_ITEMS} items)`);
  }
  rec.shareIds.unshift(shareId);
  rec.updatedAt = Date.now();
  await fs.writeFile(collectionFile(id), JSON.stringify(rec), "utf-8");
  return rec;
}

export async function removeItem(
  id: string,
  shareId: string,
): Promise<CollectionRecord | null> {
  const rec = await loadCollection(id);
  if (!rec) return null;
  const before = rec.shareIds.length;
  rec.shareIds = rec.shareIds.filter((s) => s !== shareId);
  if (rec.shareIds.length === before) return rec;
  rec.updatedAt = Date.now();
  await fs.writeFile(collectionFile(id), JSON.stringify(rec), "utf-8");
  return rec;
}

export type CollectionSortKey =
  | "updated"
  | "created"
  | "title"
  | "count";
export type CollectionSortDir = "asc" | "desc";

const VALID_SORT_KEYS: CollectionSortKey[] = [
  "updated",
  "created",
  "title",
  "count",
];

export function parseSortKey(v: unknown): CollectionSortKey {
  return typeof v === "string" && (VALID_SORT_KEYS as string[]).includes(v)
    ? (v as CollectionSortKey)
    : "updated";
}

export function parseSortDir(v: unknown): CollectionSortDir {
  return v === "asc" ? "asc" : "desc";
}

export async function listCollections(opts: {
  limit?: number;
  offset?: number;
  q?: string;
  sort?: CollectionSortKey;
  dir?: CollectionSortDir;
  /**
   * If set, only records whose workspaceId matches are returned.
   * If `allowLegacy` is also true, unscoped legacy records are
   * included (used by the cookie-auth dashboard in single-tenant
   * mode). /v1 callers should pass their workspaceId and
   * `allowLegacy: false` for strict isolation.
   */
  workspaceId?: string | null;
  allowLegacy?: boolean;
} = {}): Promise<{
  items: CollectionSummary[];
  total: number;
  offset: number;
  limit: number;
  q: string;
  sort: CollectionSortKey;
  dir: CollectionSortDir;
}> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 200);
  const sort = parseSortKey(opts.sort);
  const dir = parseSortDir(opts.dir);
  await ensureDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(COLLECTIONS_DIR);
  } catch {
    return { items: [], total: 0, offset, limit, q, sort, dir };
  }
  const records: CollectionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const rec = await loadCollection(id);
    if (rec) records.push(rec);
  }
  const scoped = opts.workspaceId === undefined
    ? records
    : records.filter((r) => {
        if (r.workspaceId && r.workspaceId === opts.workspaceId) return true;
        if (!r.workspaceId && opts.allowLegacy) return true;
        return false;
      });
  const filtered = q
    ? scoped.filter((r) => {
        const hay = `${r.title} ${r.description ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
    : scoped;
  const factor = dir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "created":
        cmp = a.createdAt - b.createdAt;
        break;
      case "title":
        cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        break;
      case "count":
        cmp = a.shareIds.length - b.shareIds.length;
        break;
      case "updated":
      default:
        cmp = a.updatedAt - b.updatedAt;
        break;
    }
    if (cmp === 0) cmp = a.updatedAt - b.updatedAt;
    return cmp * factor;
  });
  const slice = filtered.slice(offset, offset + limit);
  return {
    items: slice.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
      count: r.shareIds.length,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    total: filtered.length,
    offset,
    limit,
    q,
    sort,
    dir,
  };
}

export interface ExpandedCollectionItem {
  id: string;
  title?: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  bytes: { a: number; b: number };
  missing?: boolean;
}

export async function expandCollection(
  id: string,
): Promise<
  | (CollectionRecord & { items: ExpandedCollectionItem[] })
  | null
> {
  const rec = await loadCollection(id);
  if (!rec) return null;
  const items: ExpandedCollectionItem[] = [];
  for (const sid of rec.shareIds) {
    const share = await loadShare(sid);
    if (!share) {
      items.push({
        id: sid,
        language: "?",
        cloneLabel: "missing",
        shingleJaccard: 0,
        createdAt: 0,
        bytes: { a: 0, b: 0 },
        missing: true,
      });
      continue;
    }
    const item: ExpandedCollectionItem = {
      id: share.id,
      ...(share.title ? { title: share.title } : {}),
      language: share.language,
      cloneLabel: share.result.clone.label,
      shingleJaccard: share.result.scores.shingleJaccard,
      createdAt: share.createdAt,
      bytes: share.result.bytes,
    };
    items.push(item);
  }
  return { ...rec, items };
}

export interface ListItemsOptions {
  /** Page size, 1..100. Defaults to 25. */
  limit?: number;
  /** Opaque cursor returned from a previous page. */
  cursor?: string | null;
  /** Restrict share lookups to a workspace. Cross-tenant shares present as `missing`. */
  shareScope?: ScopeHint;
}

export interface ListItemsPage {
  collectionId: string;
  items: ExpandedCollectionItem[];
  total: number;
  nextCursor: string | null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const obj = JSON.parse(raw) as { o?: unknown };
    if (typeof obj.o === "number" && Number.isInteger(obj.o) && obj.o >= 0) {
      return obj.o;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * Paginated, optionally tenant-scoped, expansion of a collection's shareIds
 * into ExpandedCollectionItem rows. Shares the caller cannot see (wrong
 * workspace, deleted, corrupt) are returned as `{ missing: true }` so the
 * pagination cursor stays stable across visibility changes.
 */
export async function listItems(
  id: string,
  opts: ListItemsOptions = {},
): Promise<ListItemsPage | null> {
  const rec = await loadCollection(id);
  if (!rec) return null;
  const total = rec.shareIds.length;
  const offset = Math.min(Math.max(0, decodeCursor(opts.cursor)), total);
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 100);
  const slice = rec.shareIds.slice(offset, offset + limit);
  const items: ExpandedCollectionItem[] = [];
  for (const sid of slice) {
    const share = await loadShare(sid, opts.shareScope);
    if (!share) {
      items.push({
        id: sid,
        language: "?",
        cloneLabel: "missing",
        shingleJaccard: 0,
        createdAt: 0,
        bytes: { a: 0, b: 0 },
        missing: true,
      });
      continue;
    }
    const item: ExpandedCollectionItem = {
      id: share.id,
      ...(share.title ? { title: share.title } : {}),
      language: share.language,
      cloneLabel: share.result.clone.label,
      shingleJaccard: share.result.scores.shingleJaccard,
      createdAt: share.createdAt,
      bytes: share.result.bytes,
    };
    items.push(item);
  }
  const consumed = offset + slice.length;
  const nextCursor = consumed < total ? encodeCursor(consumed) : null;
  return { collectionId: rec.id, items, total, nextCursor };
}

// re-export for type-only consumers
export type { ShareRecord };
