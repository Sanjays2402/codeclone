/**
 * Build the public /v1/discovery manifest.
 *
 * Kept dependency-light (no next/server, no node:fs) so node:test can
 * import it directly and so the same builder can be reused by SDKs or
 * static export scripts without dragging Next runtime in.
 */
import { ENDPOINTS } from "./api-spec.ts";
import { ALL_SCOPES, SCOPE_DESCRIPTIONS, type Scope } from "./scopes.ts";
import { DEFAULT_RPM } from "./rate-limit.ts";

export interface DiscoveryEndpoint {
  id: string;
  method: string;
  path: string;
  summary: string;
  scope: Scope;
  params: { name: string; in: string; required: boolean; type: string; description: string }[];
}

export interface DiscoveryScope {
  id: Scope;
  description: string;
  endpoints: string[];
}

export interface DiscoveryManifest {
  api: {
    name: string;
    version: string;
    base_url: string;
    docs_url: string;
    openapi_url: string;
    openapi_yaml_url: string;
    contact: { security_txt: string };
  };
  auth: {
    schemes: string[];
    header_examples: Record<string, string>;
    key_introspection: string;
  };
  rate_limits: {
    default_requests_per_minute: number;
    window_seconds: number;
    response_headers: string[];
    throttled_status: number;
  };
  policies: Record<string, string>;
  scopes: DiscoveryScope[];
  endpoints: DiscoveryEndpoint[];
  generated_at: string;
}

export function buildDiscovery(host: string): DiscoveryManifest {
  const endpoints: DiscoveryEndpoint[] = ENDPOINTS.map((e) => ({
    id: e.id,
    method: e.method,
    path: e.path,
    summary: e.summary,
    scope: e.scope,
    params: e.params.map((p) => ({
      name: p.name,
      in: p.kind,
      required: p.required,
      type: p.type,
      description: p.description,
    })),
  }));

  const byScope = new Map<Scope, string[]>();
  for (const s of ALL_SCOPES) byScope.set(s, []);
  for (const e of ENDPOINTS) {
    const list = byScope.get(e.scope);
    if (list) list.push(e.id);
  }

  const scopes: DiscoveryScope[] = ALL_SCOPES.map((s) => ({
    id: s,
    description: SCOPE_DESCRIPTIONS[s],
    endpoints: byScope.get(s) ?? [],
  }));

  return {
    api: {
      name: "CodeClone",
      version: "v1",
      base_url: host,
      docs_url: `${host}/docs`,
      openapi_url: `${host}/v1/openapi.json`,
      openapi_yaml_url: `${host}/v1/openapi.yaml`,
      contact: { security_txt: `${host}/.well-known/security.txt` },
    },
    auth: {
      schemes: ["Bearer", "x-api-key"],
      header_examples: {
        Authorization: "Bearer ck_live_...",
        "x-api-key": "ck_live_...",
      },
      key_introspection: `${host}/v1/whoami`,
    },
    rate_limits: {
      default_requests_per_minute: DEFAULT_RPM,
      window_seconds: 60,
      response_headers: [
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "Retry-After",
      ],
      throttled_status: 429,
    },
    policies: {
      tenant_isolation: "Every /v1 route resolves the caller's API key, derives workspaceId, and scopes data access to that workspace. Cross-tenant reads return 404, not 403, so tenant existence is not leaked.",
      audit_log: "Every authenticated /v1 request appends an immutable, hash-chained audit row (actor, action, target, ip, ts, status). Stream it via GET /v1/audit.",
      idempotency: "POST endpoints that mutate state honour the 'Idempotency-Key' request header. Replays return the original response with 'Idempotency-Replay: true'.",
      ip_allowlist: "Workspace admins may restrict /v1 access to a CIDR list. Per-key allowlists narrow this further.",
      residency: "Workspaces can pin processing to a region. Requests from outside the region are rejected with 451.",
      lockdown: "Workspaces in lockdown mode reject all /v1 writes until cleared by an admin.",
      dry_run: "Pass 'X-Dry-Run: true' to validate a request without persisting state or counting against quota.",
    },
    scopes,
    endpoints,
    generated_at: new Date().toISOString(),
  };
}
