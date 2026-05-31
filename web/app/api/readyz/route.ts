/**
 * Readiness probe. Returns 200 only when the dashboard can serve traffic:
 * required dirs exist (or can be created) and the backing inference service
 * is reachable. Returns 503 + a structured `checks` object otherwise so an
 * orchestrator can fail the pod cleanly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { instrument } from "../../../lib/instrument";

export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkDir(name: string, p: string): Promise<Check> {
  try {
    await fs.mkdir(p, { recursive: true });
    await fs.access(p);
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkServe(base: string): Promise<Check> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch(`${base}/healthz`, { signal: ac.signal, cache: "no-store" });
    clearTimeout(t);
    return { name: "serve", ok: r.ok, detail: `status=${r.status}` };
  } catch (err) {
    return {
      name: "serve",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export const GET = instrument("/api/readyz", async () => {
  const cwd = process.cwd();
  const checks: Check[] = await Promise.all([
    checkDir("runs", process.env.CODECLONE_RUNS_DIR
      ? path.resolve(cwd, process.env.CODECLONE_RUNS_DIR)
      : path.resolve(cwd, "..", "runs")),
    checkDir("audit", process.env.CODECLONE_AUDIT_DIR
      ? path.resolve(cwd, process.env.CODECLONE_AUDIT_DIR)
      : path.resolve(cwd, "..", "audit")),
    checkDir("users", process.env.CODECLONE_USERS_DIR
      ? path.resolve(cwd, process.env.CODECLONE_USERS_DIR)
      : path.resolve(cwd, "..", "users")),
    checkServe(process.env.CODECLONE_SERVE_URL || "http://127.0.0.1:7461"),
  ]);

  // The `serve` backend being down is reported but does not by itself fail
  // readiness, because the dashboard can still serve docs/settings/auth.
  // Storage failures are hard-fail.
  const criticalOk = checks.filter((c) => c.name !== "serve").every((c) => c.ok);
  const allOk = checks.every((c) => c.ok);

  return NextResponse.json(
    { status: criticalOk ? "ready" : "not_ready", all_ok: allOk, checks },
    { status: criticalOk ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
});
