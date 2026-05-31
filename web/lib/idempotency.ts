/**
 * Stripe-style Idempotency-Key support for the public /v1 write surface.
 *
 * Enterprise integrators retry POSTs on network blips, timeouts, and
 * proxy 502s. Without an idempotency contract, those retries can
 * double-charge plan quota, fire webhook subscribers twice, and pollute
 * audit logs. With one, the second request returns the exact same
 * response (status, body, content-type) that the first one produced.
 *
 * Contract:
 *   - Header: `Idempotency-Key: <client-chosen string, 1..255 chars,
 *     ASCII printable>`. Optional. When absent, the route runs normally.
 *   - Scope: per API key. Two different keys (even in the same
 *     workspace) using the same idempotency key do NOT collide.
 *   - Window: 24 hours. After that the key is reusable.
 *   - Body fingerprint: the SHA-256 of the canonical JSON body is stored
 *     with the first request. If a second request reuses the same key
 *     but sends a different body, we return HTTP 409 with
 *     `error.type = "idempotency_conflict"`. This catches the common
 *     bug where a client retries with mutated input.
 *   - Inflight guard: a placeholder record is written before we run the
 *     real work. If a duplicate arrives while the first is still in
 *     flight, the duplicate returns HTTP 409 with
 *     `error.type = "idempotency_in_progress"` so the client backs off.
 *   - Replay: successful replays emit `Idempotent-Replayed: true` and
 *     reuse the original status code + body + content-type. Headers
 *     that must reflect the current request (rate-limit counters, plan
 *     remaining) are NOT replayed; they are re-derived by the caller.
 *
 * Storage: a single JSON file per (keyId, idempotencyKey) under
 * `$CODECLONE_IDEMPOTENCY_DIR` (defaults to `<cwd>/../runs/_idempotency`).
 * We deliberately avoid a database dependency so this runs in the same
 * filesystem-backed footprint as the rest of the app. The directory is
 * pruned lazily: anything older than the TTL is treated as absent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();
const TTL_MS = 24 * 60 * 60 * 1000;
const INFLIGHT_TIMEOUT_MS = 60 * 1000;
const HEADER = "idempotency-key";

export const IDEMPOTENCY_DIR = process.env.CODECLONE_IDEMPOTENCY_DIR
  ? path.resolve(CWD, process.env.CODECLONE_IDEMPOTENCY_DIR)
  : path.resolve(CWD, "..", "runs", "_idempotency");

export const REPLAY_HEADER = "Idempotent-Replayed";
export const KEY_HEADER = "Idempotency-Key";

export interface StoredResponse {
  status: number;
  contentType: string;
  body: string;
}

interface IdempotencyRecord {
  v: 1;
  keyId: string;
  idempotencyKey: string;
  bodyHash: string;
  createdAt: number;
  completedAt: number | null;
  response: StoredResponse | null;
}

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get(HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!KEY_RE.test(trimmed)) return null;
  return trimmed;
}

export function hashBody(body: unknown): string {
  // Stable JSON: object keys sorted, undefined dropped, NaN/Infinity
  // serialized to null (JSON.stringify default). Idempotency must not
  // depend on object key ordering in the wire payload.
  const canon = stableStringify(body);
  return crypto.createHash("sha256").update(canon).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as { [k: string]: unknown };
  const keys = Object.keys(o).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(o[k]))
      .join(",") +
    "}"
  );
}

function safeSegment(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function recordPath(keyId: string, idempotencyKey: string): string {
  // Hash both segments so the on-disk path can never collide or leak
  // raw key material into the filesystem listing.
  const dir = path.join(IDEMPOTENCY_DIR, safeSegment(keyId));
  return path.join(dir, safeSegment(idempotencyKey) + ".json");
}

async function readRecord(file: string): Promise<IdempotencyRecord | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as IdempotencyRecord;
    if (!parsed || parsed.v !== 1) return null;
    if (Date.now() - parsed.createdAt > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRecord(file: string, rec: IdempotencyRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(rec), "utf8");
}

export type BeginResult =
  | { kind: "fresh"; finalize: (resp: StoredResponse) => Promise<void> }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "conflict_body" }
  | { kind: "conflict_inflight" };

/**
 * Reserve an idempotency slot. On `fresh`, the caller MUST invoke
 * `finalize(response)` exactly once after producing the response.
 */
export async function begin(
  keyId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<BeginResult> {
  const file = recordPath(keyId, idempotencyKey);
  const bodyHash = hashBody(body);
  const existing = await readRecord(file);
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      return { kind: "conflict_body" };
    }
    if (existing.response && existing.completedAt) {
      return { kind: "replay", response: existing.response };
    }
    // In-flight: someone else is still computing. Bail unless the
    // inflight slot is older than the safety timeout, in which case we
    // treat it as orphaned and take it over.
    if (Date.now() - existing.createdAt < INFLIGHT_TIMEOUT_MS) {
      return { kind: "conflict_inflight" };
    }
  }
  const placeholder: IdempotencyRecord = {
    v: 1,
    keyId,
    idempotencyKey,
    bodyHash,
    createdAt: Date.now(),
    completedAt: null,
    response: null,
  };
  await writeRecord(file, placeholder);
  return {
    kind: "fresh",
    finalize: async (resp) => {
      const completed: IdempotencyRecord = {
        ...placeholder,
        completedAt: Date.now(),
        response: resp,
      };
      await writeRecord(file, completed);
    },
  };
}

/**
 * Helper to materialize a stored Response into a real `Response`. The
 * caller passes any "live" headers (rate-limit counters, plan headers)
 * that should reflect the CURRENT request rather than the original.
 */
export function buildReplay(
  stored: StoredResponse,
  liveHeaders: { [k: string]: string },
): Response {
  const headers = new Headers(liveHeaders);
  headers.set("content-type", stored.contentType);
  headers.set(REPLAY_HEADER, "true");
  return new Response(stored.body, { status: stored.status, headers });
}

export const __test = { stableStringify, recordPath, TTL_MS, INFLIGHT_TIMEOUT_MS };
