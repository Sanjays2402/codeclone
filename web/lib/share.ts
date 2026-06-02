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
  v: 1 | 2 | 3;
  id: string;
  createdAt: number;
  updatedAt?: number;
  language: string;
  title?: string;
  tags?: string[];
  // workspaceId is the tenant that owns this saved comparison. Older
  // records (v1/v2) predate multi-tenant scoping and load as null;
  // owners must be migrated explicitly via the admin console or are
  // treated as legacy public records that no scoped caller can mutate.
  workspaceId?: string | null;
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
  workspaceId?: string | null;
}

/**
 * Scope hint passed to load/update/delete/list. When set, the share
 * must belong to this workspaceId (or to no workspace when the caller
 * explicitly opts in via `allowUnscoped`). When unset, the share is
 * returned regardless of workspace, which is what the public /r/[id]
 * share-link surface and the legacy PDF endpoint use.
 */
export interface ScopeHint {
  workspaceId?: string | null;
  /** Allow legacy records with no workspaceId to match this scope. */
  allowLegacy?: boolean;
}

function scopeMatches(rec: ShareRecord, scope?: ScopeHint): boolean {
  if (!scope) return true;
  const recWs = rec.workspaceId ?? null;
  if (recWs === null) return scope.allowLegacy === true;
  return recWs === (scope.workspaceId ?? null);
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
    const ws = typeof input.workspaceId === "string" && input.workspaceId.startsWith("ws_")
      ? input.workspaceId
      : null;
    const rec: ShareRecord = {
      v: 3,
      id,
      createdAt: now,
      updatedAt: now,
      language: input.language || "auto",
      title: sanitizeTitle(input.title),
      tags: sanitizeTags(input.tags),
      workspaceId: ws,
      a: input.a,
      b: input.b,
      result: input.result,
    };
    await fs.writeFile(file, JSON.stringify(rec), "utf-8");
    return rec;
  }
  throw new Error("could not allocate share id");
}

export async function loadShare(
  id: string,
  scope?: ScopeHint,
): Promise<ShareRecord | null> {
  if (!isShareId(id)) return null;
  try {
    const buf = await fs.readFile(shareFile(id), "utf-8");
    const rec = JSON.parse(buf) as ShareRecord;
    if (!rec || (rec.v !== 1 && rec.v !== 2 && rec.v !== 3) || typeof rec.id !== "string") {
      return null;
    }
    if (!scopeMatches(rec, scope)) return null;
    return rec;
  } catch {
    return null;
  }
}

export async function updateShare(
  id: string,
  patch: UpdateShareInput,
  scope?: ScopeHint,
): Promise<ShareRecord | null> {
  const rec = await loadShare(id, scope);
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
    rec.v = 3;
    rec.updatedAt = Date.now();
    await fs.writeFile(shareFile(id), JSON.stringify(rec), "utf-8");
  }
  return rec;
}

export async function deleteShare(
  id: string,
  scope?: ScopeHint,
): Promise<boolean> {
  if (!isShareId(id)) return false;
  if (scope) {
    const rec = await loadShare(id, scope);
    if (!rec) return false;
  }
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
  workspaceId: string | null;
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
    workspaceId: rec.workspaceId ?? null,
  };
}

export interface ListSharesOptions {
  limit?: number;
  offset?: number;
  q?: string;
  tag?: string;
  language?: string;
  cloneLabel?: string;
  minScore?: number;
  maxScore?: number;
  /** Restrict to a single workspaceId. Combine with allowLegacy. */
  workspaceId?: string | null;
  /** When true, also include legacy records with no workspaceId. */
  allowLegacy?: boolean;
}

async function loadAllSummaries(): Promise<ShareSummary[]> {
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
  return summaries;
}

function applyFilters(
  rows: ShareSummary[],
  opts: ListSharesOptions,
): ShareSummary[] {
  let out = rows;
  if (opts.workspaceId !== undefined) {
    const ws = opts.workspaceId;
    out = out.filter((s) => {
      if (s.workspaceId === ws) return true;
      if (s.workspaceId === null && opts.allowLegacy) return true;
      return false;
    });
  }
  if (opts.tag) {
    const tg = opts.tag.toLowerCase();
    out = out.filter((s) => s.tags?.includes(tg));
  }
  if (opts.language) {
    const lg = opts.language.toLowerCase();
    if (lg !== "all") out = out.filter((s) => s.language.toLowerCase() === lg);
  }
  if (opts.cloneLabel) {
    const cl = opts.cloneLabel.toLowerCase();
    if (cl !== "all")
      out = out.filter((s) => s.cloneLabel.toLowerCase() === cl);
  }
  if (typeof opts.minScore === "number" && Number.isFinite(opts.minScore)) {
    const mn = opts.minScore;
    out = out.filter((s) => s.shingleJaccard >= mn);
  }
  if (typeof opts.maxScore === "number" && Number.isFinite(opts.maxScore)) {
    const mx = opts.maxScore;
    out = out.filter((s) => s.shingleJaccard <= mx);
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
  return out;
}

export async function listShares(
  opts: ListSharesOptions = {},
): Promise<ShareSummary[]> {
  const all = await loadAllSummaries();
  let out = applyFilters(all, opts);
  if (typeof opts.offset === "number" && opts.offset > 0) {
    out = out.slice(opts.offset);
  }
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

export interface ListSharesPage {
  items: ShareSummary[];
  total: number;
  offset: number;
  limit: number;
  facets: {
    languages: { name: string; count: number }[];
    cloneLabels: { name: string; count: number }[];
  };
}

export async function listSharesPage(
  opts: ListSharesOptions = {},
): Promise<ListSharesPage> {
  const all = await loadAllSummaries();
  // Apply tenant scope to the universe BEFORE computing facets so we
  // never leak language/label cardinality from other tenants' shares.
  const scoped = opts.workspaceId !== undefined ? applyFilters(all, { workspaceId: opts.workspaceId, allowLegacy: opts.allowLegacy }) : all;
  const filtered = applyFilters(scoped, opts);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 25;
  const page = filtered.slice(offset, offset + limit);
  const langCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  for (const s of scoped) {
    langCounts.set(s.language, (langCounts.get(s.language) ?? 0) + 1);
    labelCounts.set(s.cloneLabel, (labelCounts.get(s.cloneLabel) ?? 0) + 1);
  }
  const toFacet = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    items: page,
    total: filtered.length,
    offset,
    limit,
    facets: {
      languages: toFacet(langCounts),
      cloneLabels: toFacet(labelCounts),
    },
  };
}

/**
 * Bulk export of share history. Re-uses listShares for filter/sort so the
 * export matches what /history shows. CSV is RFC-4180 quoted; JSON is a
 * stable shape suitable for re-import or downstream analysis.
 */
export type ExportFormat = "csv" | "json";

export interface ExportOptions extends ListSharesOptions {
  format?: ExportFormat;
  origin?: string;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export interface ExportResult {
  body: string;
  contentType: string;
  filename: string;
  count: number;
}

export async function exportShares(opts: ExportOptions = {}): Promise<ExportResult> {
  const items = await listShares({
    limit: opts.limit,
    q: opts.q,
    tag: opts.tag,
    language: opts.language,
    cloneLabel: opts.cloneLabel,
    minScore: opts.minScore,
    maxScore: opts.maxScore,
    workspaceId: opts.workspaceId,
    allowLegacy: opts.allowLegacy,
  });
  const fmt: ExportFormat = opts.format === "json" ? "json" : "csv";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const origin = (opts.origin ?? "").replace(/\/$/, "");
  const link = (id: string) => (origin ? `${origin}/r/${id}` : `/r/${id}`);
  if (fmt === "json") {
    const body = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: items.length,
        items: items.map((s) => ({ ...s, url: link(s.id) })),
      },
      null,
      2,
    );
    return {
      body,
      contentType: "application/json; charset=utf-8",
      filename: `codeclone-history-${stamp}.json`,
      count: items.length,
    };
  }
  const header = [
    "id",
    "created_at",
    "updated_at",
    "title",
    "language",
    "clone_label",
    "shingle_jaccard",
    "bytes_a",
    "bytes_b",
    "tags",
    "url",
  ];
  const lines = [header.join(",")];
  for (const s of items) {
    lines.push(
      [
        csvCell(s.id),
        csvCell(new Date(s.createdAt).toISOString()),
        csvCell(s.updatedAt ? new Date(s.updatedAt).toISOString() : ""),
        csvCell(s.title ?? ""),
        csvCell(s.language),
        csvCell(s.cloneLabel),
        csvCell(s.shingleJaccard.toFixed(6)),
        csvCell(s.bytes.a),
        csvCell(s.bytes.b),
        csvCell((s.tags ?? []).join("|")),
        csvCell(link(s.id)),
      ].join(","),
    );
  }
  return {
    body: lines.join("\n") + "\n",
    contentType: "text/csv; charset=utf-8",
    filename: `codeclone-history-${stamp}.csv`,
    count: items.length,
  };
}
