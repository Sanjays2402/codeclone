/**
 * Filesystem-backed share store for /compare results.
 *
 * Each share is a single JSON file at $CODECLONE_SHARES_DIR/<id>.json
 * (defaults to ../shares relative to web/). Public, read-only by id.
 *
 * Schema is versioned via the `v` field so we can evolve it later without
 * breaking existing links.
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
  v: 1;
  id: string;
  createdAt: number;
  language: string;
  a: string;
  b: string;
  result: ShareResult;
}

export interface CreateShareInput {
  a: string;
  b: string;
  language: string;
  result: ShareResult;
}

function newId(): string {
  // 9 bytes -> 12 base64url chars, url-safe, no padding.
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
  // Retry on the astronomically unlikely id collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = newId().slice(0, ID_LEN);
    const file = shareFile(id);
    try {
      await fs.access(file);
      continue; // taken, try again
    } catch {
      // free
    }
    const rec: ShareRecord = {
      v: 1,
      id,
      createdAt: Date.now(),
      language: input.language || "auto",
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
    if (!rec || rec.v !== 1 || typeof rec.id !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export function shareSummary(rec: ShareRecord): {
  id: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
} {
  return {
    id: rec.id,
    language: rec.language,
    cloneLabel: rec.result.clone.label,
    shingleJaccard: rec.result.scores.shingleJaccard,
    createdAt: rec.createdAt,
  };
}
