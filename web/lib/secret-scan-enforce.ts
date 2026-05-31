/**
 * Apply the workspace secret-scan DLP policy to compare/batch payloads.
 *
 * Centralized so /api/compare, /v1/compare, and /v1/batch all behave
 * identically: same rule set, same redaction marker, same audit shape.
 * Each helper returns either:
 *   - `{ blocked: NextResponse }` when the policy mode is "block" and at
 *     least one finding was detected (caller should return immediately),
 *   - `{ effective: { ... } }` carrying the (possibly redacted) text and
 *     the list of findings so the route can pass `effective.*` into the
 *     similarity pipeline and surface findings in the response/audit.
 */
import { NextResponse } from "next/server";
import {
  applyPolicy,
  type SecretFinding,
  type SecretScanMode,
} from "./secret-scan.ts";
import {
  effectiveSecretScanMode,
  getWorkspace,
  type WorkspaceRecord,
} from "./workspaces";
import type { ApiKeyRecord } from "./api-keys";

export interface ScanOutcome {
  ok: true;
  mode: SecretScanMode;
  findings: SecretFinding[];
  effective: Record<string, string>;
}

export interface ScanBlocked {
  ok: false;
  response: NextResponse;
}

function blockResponse(findings: SecretFinding[]): NextResponse {
  // Only return rule ids + offsets + last-4. NEVER echo the matched
  // value: a 422 body shouldn't itself leak the secret it just blocked.
  return NextResponse.json(
    {
      error: {
        type: "secrets_detected",
        message:
          "Workspace DLP policy blocked this request because the submitted code contained material matching one or more secret patterns. Rotate the exposed credential, remove it from the snippet, and retry.",
        findings: findings.map((f) => ({
          rule: f.rule,
          label: f.label,
          start: f.start,
          end: f.end,
          tail_4: f.tail,
        })),
      },
    },
    { status: 422 },
  );
}

/**
 * Scan a labeled bag of strings (e.g. `{ a, b }` for compare or
 * `{ snippet_0, snippet_1, ... }` for batch) under the given workspace's
 * policy. Returns `blocked` with a ready-to-return 422 when the policy
 * says block and at least one input matched.
 */
export function scanInputs(
  inputs: Record<string, string>,
  ws: WorkspaceRecord | null | undefined,
): ScanOutcome | ScanBlocked {
  const mode = effectiveSecretScanMode(ws);
  const allFindings: SecretFinding[] = [];
  const effective: Record<string, string> = {};
  for (const [key, text] of Object.entries(inputs)) {
    const r = applyPolicy(text, mode);
    effective[key] = r.effectiveText;
    for (const f of r.findings) {
      allFindings.push({ ...f, rule: f.rule, label: `${f.label} (${key})` });
    }
    if (r.blocked) {
      return { ok: false, response: blockResponse(r.findings) };
    }
  }
  return { ok: true, mode, findings: allFindings, effective };
}

/** Convenience: load the workspace bound to an API key, then scan. */
export async function scanForKey(
  inputs: Record<string, string>,
  key: ApiKeyRecord,
): Promise<ScanOutcome | ScanBlocked> {
  const ws = key.workspaceId ? await getWorkspace(key.workspaceId) : null;
  return scanInputs(inputs, ws);
}

/**
 * Reduce findings to a compact audit payload: list of `{rule, label,
 * tail_4}` triples, deduplicated. We never write offsets or values into
 * audit because audit rows are queryable and we don't want a tail of
 * positional metadata leaking which line of which file held a credential.
 */
export function findingsForAudit(
  findings: SecretFinding[],
): Array<{ rule: string; label: string; tail_4: string }> {
  const seen = new Set<string>();
  const out: Array<{ rule: string; label: string; tail_4: string }> = [];
  for (const f of findings) {
    const k = `${f.rule}:${f.tail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ rule: f.rule, label: f.label, tail_4: f.tail });
  }
  return out;
}
