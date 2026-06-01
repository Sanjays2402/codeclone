/**
 * Public GET /v1/runs/{id}: programmatic single-run detail.
 *
 * Returns hyperparameters, per-step metrics, and (if present) the
 * eval report for a single training run. Pairs with GET /v1/runs
 * for full MLOps ingest.
 *
 * Auth, scope, enforcement, audit, and usage logging match
 * GET /v1/runs. Path id is validated as slug-safe to prevent any
 * filesystem traversal even though loadRun() resolves via the
 * runs root prefix.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../../lib/dpa-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../../lib/audit";
import { logUsage } from "../../../../../lib/usage";
import { loadRun } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function missingScope(scope: string, key: { scopes?: string[] | null }) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${scope}' scope.`,
        required_scope: scope,
        granted_scopes: key.scopes ?? null,
      },
    },
    { status: 403 },
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid run id." } },
      { status: 400 },
    );
  }

  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");

  if (!hasScope(key, "runs:read")) return missingScope("runs:read", key);

  const lockdown = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/runs/:id" });
  if (lockdown) return lockdown;
  const wsIp = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsIp) return wsIp;
  const keyIp = await enforceKeyAllowlist(req, key);
  if (keyIp) return keyIp;
  const residency = await enforceWorkspaceResidencyForKey(req, key);
  if (residency) return residency;
  const policy = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policy) return policy;
  const dpa = await enforceWorkspaceDpaForKey(req, key, { route: "/v1/runs/:id" });
  if (dpa) return dpa;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const started = performance.now();
  const run = await loadRun(id);
  const latencyMs = performance.now() - started;

  void recordUse(key.id, clientIpFromRequest(req));

  if (!run) {
    void tryRecordAudit(req, {
      action: "v1.runs.read",
      actorId: key.userId ?? key.id,
      workspaceId: key.workspaceId ?? null,
      target: { type: "run", id, label: id },
      status: "denied",
      meta: { prefix: key.prefix, reason: "not_found" },
    });
    return NextResponse.json(
      { error: { type: "not_found", message: `Run '${id}' not found.` } },
      { status: 404, headers: rl.headers },
    );
  }

  void tryRecordAudit(req, {
    action: "v1.runs.read",
    actorId: key.userId ?? key.id,
    workspaceId: key.workspaceId ?? null,
    target: { type: "run", id: run.id, label: run.id },
    status: "ok",
    meta: { prefix: key.prefix, steps: run.steps, status: run.status },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/runs/:id",
    bytes: 0,
    latencyMs: Number(latencyMs.toFixed(3)),
    workspaceId: key.workspaceId,
  });

  return NextResponse.json(
    {
      id: run.id,
      recipe_hash: run.recipeHash,
      steps: run.steps,
      last_loss: run.lastLoss,
      backend: run.backend,
      model: run.model,
      started_at: run.startedAt,
      status: run.status,
      params: run.params,
      metrics: run.metrics,
      eval_report: run.evalReport,
    },
    { headers: rl.headers },
  );
}
