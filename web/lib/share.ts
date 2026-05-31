/**
 * Filesystem-backed share store for /compare results.
 *
 * Each share is a single JSON file at $CODECLONE_SHARES_DIR/<id>.json
 * (defaults to ../shares relative to web/). Public, read-only by id.
 *
 * Schema is versioned via the `v` field so we can evolve it later without
 * breaking existing links. v1 records (id, a, b, result, language, createdAt)
 * are upgraded in memory to v2 with optional title + tags.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  SimilarityScores,
  LineAlignment,
  CloneClassification,
} from "./similarity";

const CWD = process.cwd();

export const SHARES_DIR = process.env.CODECLONE_SHARES_DIR
  ? path.resolve(CWD, process.env.CODECLONE_SHARES_DIR)
  : path.resolve(CWD, "..", "shares");

export const MAX_SNIPPET_BYTES = 64 * 1024;
const ID_LEN = 12;
const MAX_TITLE_LEN = 120;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;

export interface ShareResult {
  language: string;
  scores: SimilarityScores;
  alignment: LineAlignment;
  clone: CloneClassification;
  bytes: { a: number; b: number };
  latency_ms: number;
  method: string;
}

export interface ShareRecord {
  v: 1 | 2;
  id: string;
  createdAt: number;
  updatedAt?: number;
  language: string;
  title?: string;
  tags?: string[];
  a: string;
  b: string;
  result: ShareResult;
}

export interface CreateShareInput {
  a: string;
  b: string;
  language: string;
  result: ShareResult;
  title?: string;
  tags?: string[];
}

export interface UpdateShareInput {
  title?: string | null;
  tags?: string[] | null;
}

function newId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

function isShareId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(id);
}

async function ensureDir() {
  await fs.mkdir(SHARES_DIR, { recursive: true });
}

function shareFile(id: string): string {
  return path.join(SHARES_DIR, `${id}.json`);
}

function sanitizeTitle(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const cleaned = t.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeTags(t: unknown): string[] | undefined {
  if (!Array.isArray(t)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of t) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, MAX_TAG_LEN);
    if (!cleaned || seen.has(cleaned)) continue;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export async function createShare(input: CreateShareInput): Promise<ShareRecord> {
  if (typeof input.a !== "string" || typeof input.b !== "string") {
    throw new Error("a and b must be strings");
  }
  if (!input.a.trim() || !input.b.trim()) {
    throw new Error("a and b must be non-empty");
  }
  if (
    Buffer.byteLength(input.a, "utf-8") > MAX_SNIPPET_BYTES ||
    Buffer.byteLength(input.b, "utf-8") > MAX_SNIPPET_BYTES
  ) {
    throw new Error(`each snippet must be at most ${MAX_SNIPPET_BYTES} bytes`);
  }
  if (!input.result || typeof input.result !== "object") {
    throw new Error("result is required");
  }
  await ensureDir();
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = newId().slice(0, ID_LEN);
    const file = shareFile(id);
    try {
      await fs.access(file);
      continue;
    } catch {
      // free
    }
    const now = Date.now();
    const rec: ShareRecord = {
      v: 2,
      id,
      createdAt: now,
      updatedAt: now,
      language: input.language || "auto",
      title: sanitizeTitle(input.title),
      tags: sanitizeTags(input.tags),
      a: input.a,
      b: input.b,
      result: input.result,
    };
    await fs.writeFile(file, JSON.stringify(rec), "utf-8");
    return rec;
  }
  throw new Error("could not allocate share id");
}

export async function loadShare(id: string): Promise<ShareRecord | null> {
  if (!isShareId(id)) return null;
  try {
    const buf = await fs.readFile(shareFile(id), "utf-8");
    const rec = JSON.parse(buf) as ShareRecord;
    if (!rec || (rec.v !== 1 && rec.v !== 2) || typeof rec.id !== "string") {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export async function updateShare(
  id: string,
  patch: UpdateShareInput,
): Promise<ShareRecord | null> {
  const rec = await loadShare(id);
  if (!rec) return null;
  let changed = false;
  if (patch.title !== undefined) {
    if (patch.title === null || patch.title === "") {
      if (rec.title !== undefined) {
        delete rec.title;
        changed = true;
      }
    } else {
      const t = sanitizeTitle(patch.title);
      if (t && t !== rec.title) {
        rec.title = t;
        changed = true;
      }
    }
  }
  if (patch.tags !== undefined) {
    if (patch.tags === null) {
      if (rec.tags && rec.tags.length > 0) {
        delete rec.tags;
        changed = true;
      }
    } else {
      const tags = sanitizeTags(patch.tags) ?? [];
      const same =
        rec.tags &&
        rec.tags.length === tags.length &&
        rec.tags.every((x, i) => x === tags[i]);
      if (!same) {
        if (tags.length > 0) rec.tags = tags;
        else delete rec.tags;
        changed = true;
      }
    }
  }
  if (changed) {
    rec.v = 2;
    rec.updatedAt = Date.now();
    await fs.writeFile(shareFile(id), JSON.stringify(rec), "utf-8");
  }
  return rec;
}

export async function deleteShare(id: string): Promise<boolean> {
  if (!isShareId(id)) return false;
  try {
    await fs.unlink(shareFile(id));
    return true;
  } catch {
    return false;
  }
}

export interface ShareSummary {
  id: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  tags?: string[];
  bytes: { a: number; b: number };
}

export function shareSummary(rec: ShareRecord): ShareSummary {
  return {
    id: rec.id,
    language: rec.language,
    cloneLabel: rec.result.clone.label,
    shingleJaccard: rec.result.scores.shingleJaccard,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    title: rec.title,
    tags: rec.tags,
    bytes: rec.result.bytes,
  };
}

export interface ListSharesOptions {
  limit?: number;
  q?: string;
  tag?: string;
}

export async function listShares(
  opts: ListSharesOptions = {},
): Promise<ShareSummary[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(SHARES_DIR);
  } catch {
    return [];
  }
  const summaries: ShareSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isShareId(id)) continue;
    const rec = await loadShare(id);
    if (!rec) continue;
    summaries.push(shareSummary(rec));
  }
  summaries.sort((a, b) => b.createdAt - a.createdAt);
  let out = summaries;
  if (opts.tag) {
    const tg = opts.tag.toLowerCase();
    out = out.filter((s) => s.tags?.includes(tg));
  }
  if (opts.q) {
    const q = opts.q.toLowerCase();
    out = out.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title?.toLowerCase().includes(q) ?? false) ||
        s.language.toLowerCase().includes(q) ||
        s.cloneLabel.toLowerCase().includes(q),
    );
  }
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}
