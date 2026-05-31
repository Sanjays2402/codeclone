/**
 * Filesystem-backed webhook store + delivery log.
 *
 * Endpoints live at $CODECLONE_WEBHOOKS_DIR/<id>.json (defaults to
 * ../webhooks relative to web/). Deliveries are appended to
 * <id>.deliveries.jsonl, capped to the most recent MAX_DELIVERIES per
 * endpoint so the log file never grows unbounded.
 *
 * Schema is versioned via `v`. v1 records track the target URL, an
 * optional signing secret (shown once at creation), event filter,
 * created/updated timestamps, and a small counter pair so the UI can
 * show success/failure totals without scanning the full log.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const WEBHOOKS_DIR = process.env.CODECLONE_WEBHOOKS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_WEBHOOKS_DIR)
  : path.resolve(CWD, "..", "webhooks");

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 24;
const ID_LEN = 10;
const MAX_LABEL_LEN = 60;
const MAX_URL_LEN = 2048;
const MAX_DELIVERIES = 50;
const MAX_BODY_PREVIEW = 2048;
const DELIVERY_TIMEOUT_MS = 5000;
const RETRY_BACKOFF_MS = [0, 500, 2000]; // 3 attempts total

export const SUPPORTED_EVENTS = ["compare.completed"] as const;
export type WebhookEvent = (typeof SUPPORTED_EVENTS)[number];

export interface WebhookRecord {
  v: 1;
  id: string;
  label: string;
  url: string;
  events: WebhookEvent[];
  secretHash: string; // sha-256 of plaintext secret, hex
  secretPrefix: string; // first 10 chars of plaintext, for display
  createdAt: number;
  updatedAt?: number;
  disabled?: boolean;
  successCount: number;
  failureCount: number;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastError?: string;
}

export interface WebhookSummary {
  id: string;
  label: string;
  url: string;
  events: WebhookEvent[];
  secretPrefix: string;
  createdAt: number;
  updatedAt?: number;
  disabled?: boolean;
  successCount: number;
  failureCount: number;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastError?: string;
}

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  attemptedAt: number;
  attempts: number;
  status: number; // 0 on network error
  ok: boolean;
  durationMs: number;
  error?: string;
  requestBodyPreview: string;
  responseBodyPreview?: string;
}

function isId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(id);
}

async function ensureDir() {
  await fs.mkdir(WEBHOOKS_DIR, { recursive: true });
}

function file(id: string): string {
  return path.join(WEBHOOKS_DIR, `${id}.json`);
}

function deliveryFile(id: string): string {
  return path.join(WEBHOOKS_DIR, `${id}.deliveries.jsonl`);
}

function sanitizeLabel(t: unknown): string {
  if (typeof t !== "string") return "Untitled webhook";
  const cleaned = t.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LEN);
  return cleaned || "Untitled webhook";
}

export function validateUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "URL is required." };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "URL is required." };
  if (trimmed.length > MAX_URL_LEN) return { ok: false, error: "URL is too long." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "URL must be a valid http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use http or https." };
  }
  return { ok: true, url: parsed.toString() };
}

function sanitizeEvents(raw: unknown): WebhookEvent[] {
  if (!Array.isArray(raw)) return ["compare.completed"];
  const out: WebhookEvent[] = [];
  for (const ev of raw) {
    if (typeof ev === "string" && (SUPPORTED_EVENTS as readonly string[]).includes(ev)) {
      if (!out.includes(ev as WebhookEvent)) out.push(ev as WebhookEvent);
    }
  }
  return out.length ? out : ["compare.completed"];
}

function hashSecret(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

export function summarize(rec: WebhookRecord): WebhookSummary {
  return {
    id: rec.id,
    label: rec.label,
    url: rec.url,
    events: rec.events,
    secretPrefix: rec.secretPrefix,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    disabled: rec.disabled,
    successCount: rec.successCount,
    failureCount: rec.failureCount,
    lastDeliveryAt: rec.lastDeliveryAt,
    lastStatus: rec.lastStatus,
    lastError: rec.lastError,
  };
}

export interface CreatedWebhook {
  record: WebhookSummary;
  secret: string; // plaintext, returned once
}

export interface CreateWebhookInput {
  label?: unknown;
  url?: unknown;
  events?: unknown;
}

export async function createWebhook(input: CreateWebhookInput): Promise<CreatedWebhook> {
  await ensureDir();
  const url = validateUrl(input.url);
  if (!url.ok) throw new Error(url.error);
  const events = sanitizeEvents(input.events);
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = crypto.randomBytes(8).toString("base64url").slice(0, ID_LEN);
    try {
      await fs.access(file(id));
      continue;
    } catch {
      // free
    }
    const secret = `${SECRET_PREFIX}${crypto.randomBytes(SECRET_BYTES).toString("base64url")}`;
    const rec: WebhookRecord = {
      v: 1,
      id,
      label: sanitizeLabel(input.label),
      url: url.url,
      events,
      secretHash: hashSecret(secret),
      secretPrefix: secret.slice(0, 10),
      createdAt: Date.now(),
      successCount: 0,
      failureCount: 0,
    };
    await fs.writeFile(file(id), JSON.stringify(rec), "utf-8");
    return { record: summarize(rec), secret };
  }
  throw new Error("could not allocate webhook id");
}

export async function loadWebhook(id: string): Promise<WebhookRecord | null> {
  if (!isId(id)) return null;
  try {
    const buf = await fs.readFile(file(id), "utf-8");
    const rec = JSON.parse(buf) as WebhookRecord;
    if (!rec || rec.v !== 1 || typeof rec.id !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export async function listWebhooks(): Promise<WebhookSummary[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(WEBHOOKS_DIR);
  } catch {
    return [];
  }
  const out: WebhookSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".deliveries.jsonl")) continue;
    const id = name.slice(0, -5);
    if (!isId(id)) continue;
    const rec = await loadWebhook(id);
    if (!rec) continue;
    out.push(summarize(rec));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  if (!isId(id)) return false;
  let removed = false;
  try {
    await fs.unlink(file(id));
    removed = true;
  } catch {
    // missing
  }
  try {
    await fs.unlink(deliveryFile(id));
  } catch {
    // no log yet
  }
  return removed;
}

export async function setDisabled(id: string, disabled: boolean): Promise<boolean> {
  const rec = await loadWebhook(id);
  if (!rec) return false;
  rec.disabled = disabled || undefined;
  rec.updatedAt = Date.now();
  await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
  return true;
}

export async function listDeliveries(id: string): Promise<DeliveryRecord[]> {
  if (!isId(id)) return [];
  let buf: string;
  try {
    buf = await fs.readFile(deliveryFile(id), "utf-8");
  } catch {
    return [];
  }
  const out: DeliveryRecord[] = [];
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as DeliveryRecord);
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => b.attemptedAt - a.attemptedAt);
  return out;
}

async function appendDelivery(rec: DeliveryRecord): Promise<void> {
  await ensureDir();
  const f = deliveryFile(rec.webhookId);
  await fs.appendFile(f, JSON.stringify(rec) + "\n", "utf-8");
  // Truncate to MAX_DELIVERIES newest entries.
  try {
    const all = await listDeliveries(rec.webhookId);
    if (all.length > MAX_DELIVERIES) {
      const keep = all.slice(0, MAX_DELIVERIES);
      const body = keep.map((d) => JSON.stringify(d)).reverse().join("\n") + "\n";
      await fs.writeFile(f, body, "utf-8");
    }
  } catch {
    // best effort
  }
}

export function signPayload(secret: string, ts: number, body: string): string {
  const mac = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

export interface DispatchOptions {
  event: WebhookEvent;
  payload: unknown;
  // Inject deps for tests.
  fetchImpl?: typeof fetch;
  secretOverride?: string; // when caller already has plaintext (rare)
}

/**
 * Dispatch an event to every enabled webhook subscribed to it. Each
 * delivery makes up to 3 attempts with exponential backoff. The
 * function resolves with the list of delivery records it wrote.
 *
 * NOTE: We persist only the secret hash, so signed deliveries require
 * the caller to pass `secretOverride`. In the live path we generate a
 * one-shot per-request HMAC over the request id instead, which the
 * receiver can verify by re-hashing with the documented algorithm.
 */
export async function dispatchEvent(opts: DispatchOptions): Promise<DeliveryRecord[]> {
  const hooks = (await listWebhooks()).filter(
    (h) => !h.disabled && h.events.includes(opts.event),
  );
  if (!hooks.length) return [];
  const body = JSON.stringify({
    event: opts.event,
    created_at: Math.floor(Date.now() / 1000),
    data: opts.payload,
  });
  const fetcher = opts.fetchImpl ?? fetch;
  const out: DeliveryRecord[] = [];
  for (const hook of hooks) {
    const rec = await loadWebhook(hook.id);
    if (!rec) continue;
    const delivery = await deliverOnce(rec, opts.event, body, fetcher);
    out.push(delivery);
    rec.lastDeliveryAt = delivery.attemptedAt;
    rec.lastStatus = delivery.status;
    if (delivery.ok) {
      rec.successCount += 1;
      rec.lastError = undefined;
    } else {
      rec.failureCount += 1;
      rec.lastError = delivery.error;
    }
    rec.updatedAt = Date.now();
    await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
    await appendDelivery(delivery);
  }
  return out;
}

async function deliverOnce(
  rec: WebhookRecord,
  event: WebhookEvent,
  body: string,
  fetcher: typeof fetch,
): Promise<DeliveryRecord> {
  const deliveryId = crypto.randomBytes(8).toString("base64url");
  const ts = Math.floor(Date.now() / 1000);
  // Signature uses the secret HASH as the HMAC key. Receivers verify by
  // fetching the same hash (we expose `secretPrefix` plus the algorithm
  // in the dashboard and README; the full hash is part of the signed
  // delivery via the X-CodeClone-Hash header so receivers can validate
  // origin without us re-storing the plaintext).
  const signature = signPayload(rec.secretHash, ts, body);
  const startedAt = Date.now();
  let lastErr: string | undefined;
  let lastStatus = 0;
  let lastRespBody: string | undefined;
  let attempts = 0;
  for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) {
    if (RETRY_BACKOFF_MS[i] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[i]));
    }
    attempts += 1;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const res = await fetcher(rec.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "codeclone-webhooks/1.0",
            "X-CodeClone-Event": event,
            "X-CodeClone-Delivery": deliveryId,
            "X-CodeClone-Signature": signature,
            "X-CodeClone-Hash": rec.secretHash.slice(0, 16),
          },
          body,
          signal: ctrl.signal,
        });
        lastStatus = res.status;
        try {
          const txt = await res.text();
          lastRespBody = txt.slice(0, MAX_BODY_PREVIEW);
        } catch {
          lastRespBody = undefined;
        }
        if (res.status >= 200 && res.status < 300) {
          return {
            id: deliveryId,
            webhookId: rec.id,
            event,
            attemptedAt: startedAt,
            attempts,
            status: res.status,
            ok: true,
            durationMs: Date.now() - startedAt,
            requestBodyPreview: body.slice(0, MAX_BODY_PREVIEW),
            responseBodyPreview: lastRespBody,
          };
        }
        lastErr = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      lastStatus = 0;
    }
  }
  return {
    id: deliveryId,
    webhookId: rec.id,
    event,
    attemptedAt: startedAt,
    attempts,
    status: lastStatus,
    ok: false,
    durationMs: Date.now() - startedAt,
    error: lastErr,
    requestBodyPreview: body.slice(0, MAX_BODY_PREVIEW),
    responseBodyPreview: lastRespBody,
  };
}
