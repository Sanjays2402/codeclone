/**
 * Public GET /v1/runs: programmatic training-run inventory.
 *
 * MLOps integrators (MLflow, Weights & Biases, internal model
 * registries, SIEM ingest for ML supply-chain visibility) need a
 * stable, scoped, audited endpoint to enumerate training runs and
 * their headline metrics. The dashboard's /api/runs route is
 * unauthenticated and intended for the browser; this route is the
 * enterprise-grade equivalent: Bearer auth, scope-gated
 * (`runs:read`), audited, rate-limited, and surfaced under /usage.
 *
 * Runs are global artifacts of this CodeClone deployment (a single
 * fine-tuning host), not per-workspace rows. We still gate behind
 * a valid workspace-bound API key so revocation, IP allowlists,
 * residency, DPA, and lockdown all apply: a customer that revokes
 * its workspace API key immediately loses programmatic access to
 * the run feed without a separate teardown step.
 *
 * Auth: Bearer or x-api-key, identical to the rest of /v1.
 * Scope: runs:read.
 * Side effects: bills one /v1 rate-limit slot, records one audit
 *   row (`v1.runs.list`), and logs a free usage event so the call
 *   shows up in /usage timelines. Runs themselves are not mutated.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../lib/dpa-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { logUsage } from "../../../../lib/usage";
import { loadRuns, type RunSummary } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        message: `This key is missing the '${scope}' scope. Rotate it with the scope enabled or issue a new key.`,
        required_scope: scope,
        granted_scopes: key.scopes ?? null,
      },
    },
    { status: 403 },
  );
}

function parsePositiveInt(raw: string | null, fallback: number, max: number) {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, n);
}

function presentRun(r: RunSummary) {
  return {
    id: r.id,
    recipe_hash: r.recipeHash,
    steps: r.steps,
    last_loss: r.lastLoss,
    backend: r.backend,
    model: r.model,
    started_at: r.startedAt,
    status: r.status,
  };
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  if (!hasScope(key, "runs:read")) return missingScope("runs:read", key);

  const lockdown = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/runs" });
  if (lockdown) return lockdown;
  const wsIp = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsIp) return wsIp;
  const keyIp = await enforceKeyAllowlist(req, key);
  if (keyIp) return keyIp;
  const residency = await enforceWorkspaceResidencyForKey(req, key);
  if (residency) return residency;
  const policy = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policy) return policy;
  const dpa = await enforceWorkspaceDpaForKey(req, key, { route: "/v1/runs" });
  if (dpa) return dpa;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const model = url.searchParams.get("model");
  const backend = url.searchParams.get("backend");
  const sinceRaw = url.searchParams.get("since");
  let since: number | null = null;
  if (sinceRaw !== null && sinceRaw !== "") {
    // Accept either epoch milliseconds or an ISO-8601 timestamp.
    // Anything that fails to parse is a 400 so MLOps pipelines
    // notice the typo instead of silently returning every run.
    const asInt = Number(sinceRaw);
    if (Number.isFinite(asInt) && /^-?\d+$/.test(sinceRaw.trim())) {
      since = asInt;
    } else {
      const parsed = Date.parse(sinceRaw);
      if (!Number.isNaN(parsed)) since = parsed;
    }
    if (since === null) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message:
              "Invalid 'since' value. Pass either epoch milliseconds or an ISO-8601 timestamp.",
          },
        },
        { status: 400 },
      );
    }
  }
  const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 1_000_000);

  const started = performance.now();
  let runs = await loadRuns();
  if (status && ["queued", "running", "passed", "failed"].includes(status)) {
    runs = runs.filter((r) => r.status === status);
  }
  if (model) {
    runs = runs.filter((r) => r.model === model);
  }
  if (backend) {
    runs = runs.filter((r) => r.backend === backend);
  }
  if (since !== null) {
    const cutoff = since;
    runs = runs.filter((r) => r.startedAt >= cutoff);
  }
  const total = runs.length;
  const items = runs.slice(offset, offset + limit).map(presentRun);
  const latencyMs = performance.now() - started;

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.runs.list",
    actorId: key.userId ?? key.id,
    workspaceId: key.workspaceId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: items.length,
      total,
      filters: {
        status: status ?? null,
        model: model ?? null,
        backend: backend ?? null,
        since: since,
      },
      limit,
      offset,
    },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/runs",
    bytes: 0,
    latencyMs: Number(latencyMs.toFixed(3)),
    workspaceId: key.workspaceId,
  });

  return NextResponse.json(
    {
      count: items.length,
      total,
      limit,
      offset,
      items,
    },
    { headers: rl.headers },
  );
}
