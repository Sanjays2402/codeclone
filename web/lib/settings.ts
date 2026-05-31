/**
 * Filesystem-backed user preferences.
 *
 * Single-tenant for now: prefs live in one JSON file at
 * $CODECLONE_SETTINGS_FILE (defaults to ../settings.json relative to web/).
 * Schema is versioned via `v` so we can evolve safely.
 *
 * Also exposes GDPR-style helpers:
 *   - exportAll(): bundle every share, api key (metadata only, no hashes),
 *     and webhook (metadata only, no secrets) into one JSON blob.
 *   - wipeAll(): delete every share, api key, webhook, and prefs file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listShares, loadShare, SHARES_DIR } from "./share.ts";
import { listKeys, KEYS_DIR } from "./api-keys.ts";
import { listWebhooks, WEBHOOKS_DIR } from "./webhooks.ts";
const CWD = process.cwd();

export const SETTINGS_FILE = process.env.CODECLONE_SETTINGS_FILE
  ? path.resolve(CWD, process.env.CODECLONE_SETTINGS_FILE)
  : path.resolve(CWD, "..", "settings.json");

export const SUPPORTED_LANGUAGES = [
  "auto",
  "python",
  "javascript",
  "typescript",
  "go",
  "rust",
  "java",
  "cpp",
  "c",
  "ruby",
] as const;
export type DefaultLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface Preferences {
  v: 1;
  defaultLanguage: DefaultLanguage;
  cloneThreshold: number; // 0..1 jaccard cutoff for "clone"
  retentionDays: number;  // 0 = keep forever
  notifyOnCompareCompleted: boolean;
  notifyOnWebhookFailure: boolean;
  updatedAt: number;
}

export const DEFAULTS: Preferences = {
  v: 1,
  defaultLanguage: "auto",
  cloneThreshold: 0.85,
  retentionDays: 0,
  notifyOnCompareCompleted: false,
  notifyOnWebhookFailure: true,
  updatedAt: 0,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function coerce(raw: unknown): Preferences {
  const r = (raw ?? {}) as Partial<Preferences>;
  const lang = SUPPORTED_LANGUAGES.includes(r.defaultLanguage as DefaultLanguage)
    ? (r.defaultLanguage as DefaultLanguage)
    : DEFAULTS.defaultLanguage;
  const threshold = typeof r.cloneThreshold === "number" && Number.isFinite(r.cloneThreshold)
    ? clamp(r.cloneThreshold, 0, 1)
    : DEFAULTS.cloneThreshold;
  const retention = typeof r.retentionDays === "number" && Number.isFinite(r.retentionDays)
    ? Math.floor(clamp(r.retentionDays, 0, 3650))
    : DEFAULTS.retentionDays;
  return {
    v: 1,
    defaultLanguage: lang,
    cloneThreshold: threshold,
    retentionDays: retention,
    notifyOnCompareCompleted: Boolean(r.notifyOnCompareCompleted ?? DEFAULTS.notifyOnCompareCompleted),
    notifyOnWebhookFailure: Boolean(r.notifyOnWebhookFailure ?? DEFAULTS.notifyOnWebhookFailure),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const buf = await fs.readFile(SETTINGS_FILE, "utf8");
    return coerce(JSON.parse(buf));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
    throw e;
  }
}

export interface UpdateInput {
  defaultLanguage?: unknown;
  cloneThreshold?: unknown;
  retentionDays?: unknown;
  notifyOnCompareCompleted?: unknown;
  notifyOnWebhookFailure?: unknown;
}

export async function updatePreferences(input: UpdateInput): Promise<Preferences> {
  const current = await loadPreferences();
  const merged = coerce({
    ...current,
    ...input,
    updatedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export interface ExportBundle {
  v: 1;
  exportedAt: number;
  preferences: Preferences;
  shares: unknown[];
  apiKeys: unknown[];
  webhooks: unknown[];
  counts: { shares: number; apiKeys: number; webhooks: number };
}

export async function exportAll(): Promise<ExportBundle> {
  const preferences = await loadPreferences();
  const shareSummaries = await listShares({ limit: 10000 });
  const shares = [];
  for (const s of shareSummaries) {
    const full = await loadShare(s.id);
    if (full) shares.push(full);
  }
  const apiKeys = await listKeys(); // metadata only, no hashes leak
  const webhooks = (await listWebhooks()).map(w => ({ ...w })); // metadata only
  return {
    v: 1,
    exportedAt: Date.now(),
    preferences,
    shares,
    apiKeys,
    webhooks,
    counts: { shares: shares.length, apiKeys: apiKeys.length, webhooks: webhooks.length },
  };
}

async function rmDirContents(dir: string): Promise<number> {
  let n = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        await fs.unlink(path.join(dir, e.name));
        n++;
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return n;
}

export interface WipeResult {
  shares: number;
  apiKeys: number;
  webhooks: number;
  preferencesReset: boolean;
}

export async function wipeAll(): Promise<WipeResult> {
  const shares = await rmDirContents(SHARES_DIR);
  const apiKeys = await rmDirContents(KEYS_DIR);
  const webhooks = await rmDirContents(WEBHOOKS_DIR);
  let preferencesReset = false;
  try {
    await fs.unlink(SETTINGS_FILE);
    preferencesReset = true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { shares, apiKeys, webhooks, preferencesReset };
}
