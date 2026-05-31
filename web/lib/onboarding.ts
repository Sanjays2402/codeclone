/**
 * Filesystem-backed onboarding state.
 *
 * codeclone is self-hosted single-tenant for now, so onboarding state lives
 * in a single JSON file next to the rest of the runtime data:
 *   $CODECLONE_ONBOARDING_FILE  (default: ../.onboarding.json)
 *
 * Step completion is *derived* from real state whenever possible so the user
 * cannot end up with a checklist that lies. The persisted file only records
 * (a) whether the user has dismissed the welcome flow, and (b) the timestamp
 * the welcome was first seen, which is useful for analytics later.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listKeys } from "./api-keys.ts";
import { createShare, deleteShare, listShares } from "./share.ts";
import { compareCode, alignLines, classifyClone } from "./similarity.ts";
import { COMPARE_SAMPLES } from "./compare-samples.ts";

/**
 * Tag applied to every sample share created by seedSamples(). Used to find
 * and remove them later without touching anything the user saved.
 */
export const SAMPLE_TAG = "sample";

const CWD = process.cwd();

export const ONBOARDING_FILE = process.env.CODECLONE_ONBOARDING_FILE
  ? path.resolve(CWD, process.env.CODECLONE_ONBOARDING_FILE)
  : path.resolve(CWD, "..", ".onboarding.json");

export type StepId = "create_key" | "run_compare" | "save_share";

export interface Step {
  id: StepId;
  title: string;
  body: string;
  href: string;
  cta: string;
  done: boolean;
}

export interface OnboardingState {
  steps: Step[];
  completed: number;
  total: number;
  dismissed: boolean;
  startedAt: number;
  finishedAt?: number;
}

interface Persisted {
  v: 1;
  dismissed: boolean;
  startedAt: number;
  finishedAt?: number;
  comparedAt?: number;
  seededAt?: number;
}

async function readPersisted(): Promise<Persisted> {
  try {
    const raw = await fs.readFile(ONBOARDING_FILE, "utf-8");
    const j = JSON.parse(raw) as Partial<Persisted>;
    return {
      v: 1,
      dismissed: !!j.dismissed,
      startedAt: typeof j.startedAt === "number" ? j.startedAt : Date.now(),
      finishedAt: typeof j.finishedAt === "number" ? j.finishedAt : undefined,
      comparedAt: typeof j.comparedAt === "number" ? j.comparedAt : undefined,
      seededAt: typeof j.seededAt === "number" ? j.seededAt : undefined,
    };
  } catch {
    return { v: 1, dismissed: false, startedAt: Date.now() };
  }
}

async function writePersisted(p: Persisted): Promise<void> {
  await fs.mkdir(path.dirname(ONBOARDING_FILE), { recursive: true });
  await fs.writeFile(ONBOARDING_FILE, JSON.stringify(p, null, 2));
}

async function haveActiveKey(): Promise<boolean> {
  try {
    const keys = await listKeys();
    return keys.some((k) => !k.revoked);
  } catch {
    return false;
  }
}

async function haveCompareRun(persisted: Persisted): Promise<boolean> {
  if (persisted.comparedAt) return true;
  // A saved share implies the user has compared something already.
  try {
    const shares = await listShares({ limit: 1 });
    if (shares.length > 0) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function haveSavedShare(): Promise<boolean> {
  try {
    const shares = await listShares({ limit: 1 });
    return shares.length > 0;
  } catch {
    return false;
  }
}

export async function getOnboarding(): Promise<OnboardingState> {
  const persisted = await readPersisted();
  const [keyDone, compareDone, shareDone] = await Promise.all([
    haveActiveKey(),
    haveCompareRun(persisted),
    haveSavedShare(),
  ]);
  const steps: Step[] = [
    {
      id: "create_key",
      title: "Create your first API key",
      body: "You will use this key to call /v1/compare from curl, CI, or your editor.",
      href: "/api-keys",
      cta: "Open API keys",
      done: keyDone,
    },
    {
      id: "run_compare",
      title: "Run your first comparison",
      body: "Paste two snippets, pick a language, see similarity, alignment, and a clone label.",
      href: "/compare",
      cta: "Open compare",
      done: compareDone,
    },
    {
      id: "save_share",
      title: "Save a result to history",
      body: "Anything you save shows up under history with a public share link you can send.",
      href: "/history",
      cta: "Open history",
      done: shareDone,
    },
  ];
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const allDone = completed === total;
  if (allDone && !persisted.finishedAt) {
    persisted.finishedAt = Date.now();
    await writePersisted(persisted);
  }
  return {
    steps,
    completed,
    total,
    dismissed: persisted.dismissed,
    startedAt: persisted.startedAt,
    finishedAt: persisted.finishedAt,
  };
}

export async function dismissOnboarding(): Promise<void> {
  const p = await readPersisted();
  p.dismissed = true;
  await writePersisted(p);
}

/**
 * Find shares that were created by seedSamples(). A share counts as a sample
 * iff it carries the SAMPLE_TAG tag we wrote at creation time.
 */
export async function listSampleShareIds(): Promise<string[]> {
  try {
    const shares = await listShares({ limit: 200 });
    return shares
      .filter((s) => Array.isArray(s.tags) && s.tags.includes(SAMPLE_TAG))
      .map((s) => s.id);
  } catch {
    return [];
  }
}

export interface SeedSamplesResult {
  created: string[];
  skipped: boolean;
  total: number;
}

/**
 * Seed the account with one share per built-in COMPARE_SAMPLES entry. Idempotent:
 * if any sample-tagged share already exists, returns skipped=true and does not
 * duplicate. Uses the real similarity pipeline so the records look identical
 * to anything the user would produce themselves.
 */
export async function seedSamples(): Promise<SeedSamplesResult> {
  const existing = await listSampleShareIds();
  if (existing.length > 0) {
    return { created: existing, skipped: true, total: existing.length };
  }
  const created: string[] = [];
  for (const sample of COMPARE_SAMPLES) {
    const started = performance.now();
    const scores = compareCode(sample.a, sample.b);
    const alignment = alignLines(sample.a, sample.b);
    const clone = classifyClone(sample.a, sample.b, scores);
    const latency_ms = Number((performance.now() - started).toFixed(3));
    const rec = await createShare({
      a: sample.a,
      b: sample.b,
      language: sample.language,
      title: `Sample: ${sample.title}`,
      tags: [SAMPLE_TAG, sample.id],
      result: {
        language: sample.language,
        scores,
        alignment,
        clone,
        bytes: {
          a: Buffer.byteLength(sample.a, "utf-8"),
          b: Buffer.byteLength(sample.b, "utf-8"),
        },
        latency_ms,
        method:
          "exact-jaccard+5gram-shingles+line-align+structural-4gram-clone-type",
      },
    });
    created.push(rec.id);
  }
  const p = await readPersisted();
  if (!p.seededAt) {
    p.seededAt = Date.now();
    await writePersisted(p);
  }
  return { created, skipped: false, total: created.length };
}

/**
 * Remove every share previously created by seedSamples(). Anything the user
 * created themselves is left alone.
 */
export async function clearSamples(): Promise<{ removed: number }> {
  const ids = await listSampleShareIds();
  let removed = 0;
  for (const id of ids) {
    const ok = await deleteShare(id);
    if (ok) removed++;
  }
  return { removed };
}

export async function markCompared(): Promise<void> {
  const p = await readPersisted();
  if (!p.comparedAt) {
    p.comparedAt = Date.now();
    await writePersisted(p);
  }
}

export async function resetOnboarding(): Promise<void> {
  const p: Persisted = { v: 1, dismissed: false, startedAt: Date.now() };
  await writePersisted(p);
}
