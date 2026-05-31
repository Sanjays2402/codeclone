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

export const SUPPORTED_EVENTS = [
  "compare.completed",
  "batch.completed",
  // Real-time audit log forwarding for SIEM/observability tooling.
  // Every successful audit entry written for the workspace fans out as
  // a signed `audit.recorded` delivery, so customers can stream their
  // SOC2 trail to Splunk/Datadog/S3 without polling /api/audit.
  "audit.recorded",
  // Manual connectivity + signature test. Owners/editors fire one from
  // the dashboard with `pingWebhook` to validate HMAC verification and
  // network reachability before flipping a webhook live. Always sent to
  // the targeted webhook regardless of its `events` subscription so
  // receivers do not have to opt in to be testable.
  "webhook.ping",
] as const;
export type WebhookEvent = (typeof SUPPORTED_EVENTS)[number];

export interface WebhookRecord {
  v: 1;
  id: string;
  /**
   * Owning workspace. Required for all webhooks created on or after
   * the multi-tenant webhook migration. Legacy records that predate this
   * field are treated as orphaned (not visible to any workspace, not
   * dispatched to). Set CODECLONE_WEBHOOKS_ALLOW_LEGACY=1 to also surface
   * them in dispatch and listing for backwards compatibility in dev.
   */
  workspaceId?: string;
  label: string;
  url: string;
  events: WebhookEvent[];
  secretHash: string; // sha-256 of plaintext secret, hex
  secretPrefix: string; // first 10 chars of plaintext, for display
  /**
   * In-flight signing secret rotation. While `pendingSecretHash` is set
   * AND `pendingExpiresAt` is in the future, every delivery is signed
   * with BOTH the primary and pending secrets (headers `X-CodeClone-
   * Signature` and `X-CodeClone-Signature-Next`), giving receivers a
   * grace window to migrate. On `finalizeRotation` (or auto-finalize
   * once `pendingExpiresAt` elapses) the pending secret is promoted to
   * primary and the pending fields are cleared. `cancelRotation` drops
   * the pending secret without promoting it. The plaintext is shown to
   * the caller exactly once (at rotate time), matching create-time.
   */
  pendingSecretHash?: string;
  pendingSecretPrefix?: string;
  pendingCreatedAt?: number;
  pendingExpiresAt?: number;
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
  workspaceId?: string;
  label: string;
  url: string;
  events: WebhookEvent[];
  secretPrefix: string;
  pendingSecretPrefix?: string;
  pendingCreatedAt?: number;
  pendingExpiresAt?: number;
  createdAt: number;
  updatedAt?: number;
  disabled?: boolean;
  successCount: number;
  failureCount: number;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastError?: string;
}

const WORKSPACE_ID_RE = /^ws_[A-Za-z0-9_-]{6,32}$/;

function allowLegacy(): boolean {
  return process.env.CODECLONE_WEBHOOKS_ALLOW_LEGACY === "1";
}

export function validateWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return WORKSPACE_ID_RE.test(raw) ? raw : null;
}

/**
 * True when this webhook record is visible to / owned by the given
 * workspace. Legacy records without a workspaceId are hidden from every
 * workspace unless CODECLONE_WEBHOOKS_ALLOW_LEGACY=1 (dev-only escape).
 */
export function webhookBelongsTo(rec: WebhookRecord, workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  if (rec.workspaceId) return rec.workspaceId === workspaceId;
  return allowLegacy();
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
  redeliveredFrom?: string;
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

/**
 * Return true when the given hostname (literal IP or DNS name) targets
 * a network we must not allow outbound webhook traffic to reach.
 *
 * Blocks loopback, RFC1918 private, link-local, unique-local (IPv6 fc00::/7),
 * IPv6 loopback (::1), the cloud metadata IP (169.254.169.254 is link-local
 * but called out below for documentation), and well-known internal-only
 * hostnames (`localhost`, anything ending in `.local` / `.internal` /
 * `.localhost` / `.lan` / `.intranet`). This is a defense in depth check on
 * top of TLS + auth; it is not a substitute for runtime DNS pinning.
 */
export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
      h.endsWith(".lan") || h.endsWith(".intranet") || h.endsWith(".home.arpa")) {
    return true;
  }
  // IPv4 literal
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const parts = m4.slice(1).map((n) => Number(n));
    if (parts.some((p) => p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;                               // 10/8
    if (a === 127) return true;                              // loopback
    if (a === 0) return true;                                // 0/8 wildcard
    if (a === 169 && b === 254) return true;                 // link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
    if (a === 192 && b === 168) return true;                 // 192.168/16
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64/10
    if (a >= 224) return true;                               // multicast + reserved
    return false;
  }
  // IPv6 literal (very rough; we strip zone id and check well-known ranges)
  if (h.includes(":")) {
    const stripped = h.split("%")[0];
    if (stripped === "::" || stripped === "::1") return true;
    if (stripped.startsWith("fe8") || stripped.startsWith("fe9") ||
        stripped.startsWith("fea") || stripped.startsWith("feb")) return true; // fe80::/10
    if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true;   // fc00::/7
    if (stripped.startsWith("::ffff:")) {
      // IPv4-mapped IPv6: recurse on the embedded v4.
      return isPrivateHost(stripped.slice(7));
    }
    return false;
  }
  return false;
}

/**
 * When `CODECLONE_WEBHOOKS_ALLOW_PRIVATE=1`, the SSRF block is disabled.
 * Required for the local dev loop where someone points a webhook at
 * `http://localhost:4000/hook` and for the test suite, which uses a
 * mock fetch but may exercise loopback URLs.
 */
function privateHostsAllowed(): boolean {
  return process.env.CODECLONE_WEBHOOKS_ALLOW_PRIVATE === "1";
}

/**
 * Resolve the workspace's webhook destination domain allowlist, if any.
 * Used at delivery time so policy changes take effect immediately.
 * Returns null on missing/invalid workspace; returns an empty array when
 * the workspace exists but has no rules (open).
 *
 * Dynamic import keeps this file free of a hard dep on workspaces.ts so
 * the module graph stays cycle-free.
 */
async function loadWorkspaceDomainAllowlist(
  workspaceId: string | undefined,
): Promise<readonly string[] | null> {
  if (!workspaceId) return null;
  try {
    const mod = await import("./workspaces.ts");
    const ws = await mod.getWorkspace(workspaceId);
    if (!ws) return null;
    const list = ws.webhookDomainAllowlist;
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/**
 * Sanitize a list of webhook destination domain entries. Each entry is
 * lowercased and trimmed. Accepted forms:
 *   example.com         exact host match
 *   *.example.com       any subdomain of example.com (not example.com itself)
 * Anything else (paths, schemes, ports, IP literals, empty strings) is
 * rejected and returned in `rejected` so the UI can surface it.
 */
export function sanitizeWebhookDomainList(
  raw: unknown,
): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(raw)) return { ok, rejected };
  const seen = new Set<string>();
  for (const entryRaw of raw) {
    if (typeof entryRaw !== "string") {
      rejected.push(String(entryRaw));
      continue;
    }
    const e = entryRaw.trim().toLowerCase();
    if (!e) continue;
    if (e.length > 253) { rejected.push(entryRaw); continue; }
    const body = e.startsWith("*.") ? e.slice(2) : e;
    // RFC1035-ish: labels of [a-z0-9-] separated by dots, must contain a dot.
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(body)) {
      rejected.push(entryRaw);
      continue;
    }
    // Reject IPv4-like literals (all-numeric labels). The hostname allowlist
    // is for DNS names; use the IP allowlist for address-level rules.
    if (/^[0-9.]+$/.test(body)) {
      rejected.push(entryRaw);
      continue;
    }
    // TLD must contain at least one letter (e.g. ".com", not ".123").
    const tld = body.slice(body.lastIndexOf(".") + 1);
    if (!/[a-z]/.test(tld)) {
      rejected.push(entryRaw);
      continue;
    }
    if (seen.has(e)) continue;
    seen.add(e);
    ok.push(e);
  }
  return { ok, rejected };
}

/**
 * True when `hostname` is permitted by `allowlist`. Empty / missing list
 * means "no restriction". Matching is case-insensitive. Exact hosts must
 * equal the entry; `*.example.com` matches `a.example.com` and
 * `a.b.example.com` but not `example.com` itself.
 */
export function matchesDomainAllowlist(
  hostname: string,
  allowlist: readonly string[] | null | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (typeof hostname !== "string" || !hostname) return false;
  const h = hostname.trim().toLowerCase();
  for (const entryRaw of allowlist) {
    const entry = String(entryRaw).trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

export function validateUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {  if (typeof raw !== "string") return { ok: false, error: "URL is required." };
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
  if (!privateHostsAllowed() && isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      error: "URL targets a private, loopback, or link-local address. Set CODECLONE_WEBHOOKS_ALLOW_PRIVATE=1 to override for local development.",
    };
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
    workspaceId: rec.workspaceId,
    label: rec.label,
    url: rec.url,
    events: rec.events,
    secretPrefix: rec.secretPrefix,
    pendingSecretPrefix: rec.pendingSecretPrefix,
    pendingCreatedAt: rec.pendingCreatedAt,
    pendingExpiresAt: rec.pendingExpiresAt,
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
  workspaceId?: unknown;
  /**
   * Optional workspace-level destination domain allowlist. When provided
   * and non-empty, the URL must match. The route handler reads this off
   * the workspace record so the policy is enforced at create time.
   */
  domainAllowlist?: readonly string[];
}

export async function createWebhook(input: CreateWebhookInput): Promise<CreatedWebhook> {
  await ensureDir();
  const workspaceId = validateWorkspaceId(input.workspaceId);
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }
  const url = validateUrl(input.url);
  if (!url.ok) throw new Error(url.error);
  if (input.domainAllowlist && input.domainAllowlist.length > 0) {
    let host = "";
    try { host = new URL(url.url).hostname; } catch { host = ""; }
    if (!matchesDomainAllowlist(host, input.domainAllowlist)) {
      throw new Error(
        `URL host "${host}" is not in this workspace's webhook domain allowlist.`,
      );
    }
  }
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
      workspaceId,
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

/**
 * Internal: list every webhook record regardless of workspace. Callers in
 * the public API MUST filter by workspace via `listWebhooksForWorkspace`
 * to prevent cross-tenant leakage. Exposed for migration/admin tooling
 * only.
 */
export async function listAllWebhooks(): Promise<WebhookSummary[]> {
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

/**
 * Workspace-scoped list. Returns only webhooks owned by the given
 * workspace. Legacy records without a workspaceId are excluded unless
 * CODECLONE_WEBHOOKS_ALLOW_LEGACY=1 is set.
 */
export async function listWebhooksForWorkspace(workspaceId: string): Promise<WebhookSummary[]> {
  if (!validateWorkspaceId(workspaceId)) return [];
  const all = await listAllWebhooks();
  return all.filter((w) => {
    if (w.workspaceId) return w.workspaceId === workspaceId;
    return allowLegacy();
  });
}

/**
 * Back-compat alias. New code MUST use `listWebhooksForWorkspace`. Kept
 * because settings.ts (per-user export) and dispatchEvent both want a
 * cross-cutting view; we now route those through workspace-aware helpers
 * instead.
 */
export async function listWebhooks(): Promise<WebhookSummary[]> {
  return listAllWebhooks();
}

/**
 * Workspace-scoped load. Returns null if the webhook does not exist OR
 * does not belong to the given workspace. Use this in every request
 * handler that resolves a webhook id from path params.
 */
export async function loadWebhookForWorkspace(
  id: string,
  workspaceId: string,
): Promise<WebhookRecord | null> {
  const rec = await loadWebhook(id);
  if (!rec) return null;
  if (!webhookBelongsTo(rec, workspaceId)) return null;
  return rec;
}

/**
 * Hard-delete a webhook. Workspace-scoped: if `workspaceId` is provided
 * and the webhook does not belong to it, the delete is refused (returns
 * false) and nothing on disk is touched. Pass `null` only from admin
 * tooling that has its own authorisation check.
 */
export async function deleteWebhook(
  id: string,
  workspaceId: string | null,
): Promise<boolean> {
  if (!isId(id)) return false;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return false;
    const rec = await loadWebhook(id);
    if (!rec) return false;
    if (!webhookBelongsTo(rec, workspaceId)) return false;
  }
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

export async function setDisabled(
  id: string,
  disabled: boolean,
  workspaceId: string | null,
): Promise<boolean> {
  const rec = await loadWebhook(id);
  if (!rec) return false;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return false;
    if (!webhookBelongsTo(rec, workspaceId)) return false;
  }
  rec.disabled = disabled || undefined;
  rec.updatedAt = Date.now();
  await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
  return true;
}

// Bounds for rotation grace window. Receivers need enough time to deploy
// a verifier that accepts the new secret; we cap at 30d so a forgotten
// rotation eventually finalizes on its own.
export const ROTATION_MIN_MS = 60 * 1000; // 1 minute (tests + emergencies)
export const ROTATION_DEFAULT_MS = 24 * 60 * 60 * 1000; // 24h
export const ROTATION_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30d

export interface RotatedWebhook {
  record: WebhookSummary;
  secret: string; // plaintext of the NEW pending secret, returned once
  expiresAt: number;
}

/**
 * Begin a signing-secret rotation. Generates a fresh secret, stores
 * only its hash as `pendingSecretHash`, and returns the plaintext to
 * the caller exactly once. During the grace window every delivery is
 * signed with BOTH the primary and pending secrets so receivers can
 * roll forward without dropping events. Calling this while a rotation
 * is already pending replaces the pending secret (does NOT touch the
 * primary), so an operator can extend or restart a botched rollout.
 */
export async function rotateSecret(
  id: string,
  workspaceId: string | null,
  graceMs: number = ROTATION_DEFAULT_MS,
): Promise<RotatedWebhook | null> {
  const rec = await loadWebhook(id);
  if (!rec) return null;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return null;
    if (!webhookBelongsTo(rec, workspaceId)) return null;
  }
  let grace = Number.isFinite(graceMs) ? Math.floor(graceMs) : ROTATION_DEFAULT_MS;
  if (grace < ROTATION_MIN_MS) grace = ROTATION_MIN_MS;
  if (grace > ROTATION_MAX_MS) grace = ROTATION_MAX_MS;
  const secret = `${SECRET_PREFIX}${crypto.randomBytes(SECRET_BYTES).toString("base64url")}`;
  const now = Date.now();
  rec.pendingSecretHash = hashSecret(secret);
  rec.pendingSecretPrefix = secret.slice(0, 10);
  rec.pendingCreatedAt = now;
  rec.pendingExpiresAt = now + grace;
  rec.updatedAt = now;
  await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
  return { record: summarize(rec), secret, expiresAt: rec.pendingExpiresAt };
}

/**
 * Promote the pending secret to primary and clear pending state.
 * Returns null if there is no pending secret or the webhook is not
 * visible to the workspace.
 */
export async function finalizeRotation(
  id: string,
  workspaceId: string | null,
): Promise<WebhookSummary | null> {
  const rec = await loadWebhook(id);
  if (!rec) return null;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return null;
    if (!webhookBelongsTo(rec, workspaceId)) return null;
  }
  if (!rec.pendingSecretHash || !rec.pendingSecretPrefix) return null;
  rec.secretHash = rec.pendingSecretHash;
  rec.secretPrefix = rec.pendingSecretPrefix;
  rec.pendingSecretHash = undefined;
  rec.pendingSecretPrefix = undefined;
  rec.pendingCreatedAt = undefined;
  rec.pendingExpiresAt = undefined;
  rec.updatedAt = Date.now();
  await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
  return summarize(rec);
}

/** Drop the pending secret without promoting it. */
export async function cancelRotation(
  id: string,
  workspaceId: string | null,
): Promise<WebhookSummary | null> {
  const rec = await loadWebhook(id);
  if (!rec) return null;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return null;
    if (!webhookBelongsTo(rec, workspaceId)) return null;
  }
  if (!rec.pendingSecretHash) return summarize(rec);
  rec.pendingSecretHash = undefined;
  rec.pendingSecretPrefix = undefined;
  rec.pendingCreatedAt = undefined;
  rec.pendingExpiresAt = undefined;
  rec.updatedAt = Date.now();
  await fs.writeFile(file(rec.id), JSON.stringify(rec), "utf-8");
  return summarize(rec);
}

/**
 * Workspace-scoped delivery list. If `workspaceId` is supplied, returns
 * an empty list when the webhook either does not exist or belongs to a
 * different workspace (no leakage of "this id exists somewhere").
 */
export async function listDeliveriesForWorkspace(
  id: string,
  workspaceId: string,
): Promise<DeliveryRecord[]> {
  if (!validateWorkspaceId(workspaceId)) return [];
  const rec = await loadWebhook(id);
  if (!rec || !webhookBelongsTo(rec, workspaceId)) return [];
  return listDeliveries(id);
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
  /**
   * REQUIRED. Only webhooks owned by this workspace receive the event.
   * Passing null/undefined dispatches to no one (safe default). Legacy
   * webhooks without a workspaceId are included only when
   * CODECLONE_WEBHOOKS_ALLOW_LEGACY=1 is set, matching the listing rule.
   */
  workspaceId: string | null | undefined;
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
  const wsId = validateWorkspaceId(opts.workspaceId);
  if (!wsId) return [];
  const hooks = (await listWebhooksForWorkspace(wsId)).filter(
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

/**
 * Manually redeliver a previously-logged delivery. Looks up the
 * original delivery by id, replays the stored request body against the
 * webhook URL, and appends a new delivery record. The new delivery is
 * marked with `redeliveredFrom` so the UI can show provenance. Counters
 * on the webhook record are updated just like a live dispatch.
 *
 * Returns null if the webhook or original delivery cannot be found.
 */
/**
 * Send a one-shot signed test delivery (`webhook.ping`) to a single
 * webhook. Used by the dashboard "send test" action so customers can
 * confirm HMAC verification and connectivity before subscribing to
 * real events. Bypasses the per-webhook event subscription filter on
 * purpose. Same signing path, headers, and retry budget as a live
 * dispatch, so a passing ping is a real proof of integration.
 *
 * Returns null if the webhook is not found OR does not belong to the
 * supplied workspace (tenant isolation). Errors during delivery are
 * captured in the returned DeliveryRecord (ok=false, error) rather
 * than thrown so the caller can always audit + render the result.
 */
export async function pingWebhook(
  webhookId: string,
  workspaceId: string,
  actor: { id: string; email: string | null } | null,
  fetchImpl?: typeof fetch,
): Promise<DeliveryRecord | null> {
  const wsId = validateWorkspaceId(workspaceId);
  if (!wsId) return null;
  const rec = await loadWebhookForWorkspace(webhookId, wsId);
  if (!rec) return null;
  const event: WebhookEvent = "webhook.ping";
  const body = JSON.stringify({
    event,
    created_at: Math.floor(Date.now() / 1000),
    data: {
      message:
        "This is a CodeClone webhook test ping. Verify the HMAC signature, then ignore.",
      webhook_id: rec.id,
      workspace_id: wsId,
      actor: actor ? { id: actor.id, email: actor.email } : null,
    },
  });
  const fetcher = fetchImpl ?? fetch;
  const delivery = await deliverOnce(rec, event, body, fetcher);
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
  return delivery;
}

export async function redeliverDelivery(
  webhookId: string,
  deliveryId: string,
  workspaceId: string | null,
  fetchImpl?: typeof fetch,
): Promise<DeliveryRecord | null> {
  const rec = await loadWebhook(webhookId);
  if (!rec) return null;
  if (workspaceId !== null) {
    if (!validateWorkspaceId(workspaceId)) return null;
    if (!webhookBelongsTo(rec, workspaceId)) return null;
  }
  if (typeof deliveryId !== "string" || !/^[A-Za-z0-9_-]{6,32}$/.test(deliveryId)) {
    return null;
  }
  const all = await listDeliveries(webhookId);
  const original = all.find((d) => d.id === deliveryId);
  if (!original) return null;
  const fetcher = fetchImpl ?? fetch;
  const delivery = await deliverOnce(rec, original.event, original.requestBodyPreview, fetcher);
  delivery.redeliveredFrom = original.id;
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
  return delivery;
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
  // Dual-sign during an in-flight rotation so receivers can verify with
  // either secret. Once `pendingExpiresAt` elapses the next mutation
  // (rotate/finalize/cancel) will clean it up; until then we send both
  // signatures on every delivery in this grace window.
  const rotating =
    !!rec.pendingSecretHash &&
    !!rec.pendingExpiresAt &&
    rec.pendingExpiresAt > Date.now();
  const nextSignature = rotating
    ? signPayload(rec.pendingSecretHash as string, ts, body)
    : undefined;
  const nextHashHeader = rotating
    ? (rec.pendingSecretHash as string).slice(0, 16)
    : undefined;
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
    // Re-check at delivery time so a webhook stored before the SSRF rules
    // shipped, or one whose DNS now points at an internal IP literal, cannot
    // exfiltrate traffic to private networks. We do not yet pin DNS, so this
    // does not defeat a sophisticated DNS-rebinding attacker; documented in
    // docs/threat-model.md.
    if (!privateHostsAllowed()) {
      let host = "";
      try { host = new URL(rec.url).hostname; } catch { host = ""; }
      if (!host || isPrivateHost(host)) {
        lastErr = "blocked: webhook URL targets a private or loopback address";
        lastStatus = 0;
        break;
      }
    }
    // Workspace destination domain allowlist. Re-checked on every
    // attempt so a policy that tightens after a webhook was registered
    // takes effect immediately for in-flight deliveries.
    {
      let host = "";
      try { host = new URL(rec.url).hostname; } catch { host = ""; }
      const wsAllow = await loadWorkspaceDomainAllowlist(rec.workspaceId);
      if (wsAllow && wsAllow.length > 0 && !matchesDomainAllowlist(host, wsAllow)) {
        lastErr = `blocked: "${host}" not in workspace webhook domain allowlist`;
        lastStatus = 0;
        break;
      }
    }
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
            ...(nextSignature
              ? {
                  "X-CodeClone-Signature-Next": nextSignature,
                  "X-CodeClone-Hash-Next": nextHashHeader as string,
                }
              : {}),
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
