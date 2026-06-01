/**
 * Canonical specification for the public /v1 API surface.
 *
 * Drives the in-product API reference at /docs and is asserted by
 * tests/docs.test.ts to keep the page honest: every endpoint listed
 * here must map to a real route file on disk and reference a real
 * scope from lib/api-keys.ts.
 *
 * Keep this file dependency-light so it can be imported from both
 * server components and node:test without dragging Next runtime in.
 */
import { ALL_SCOPES, type Scope } from "./scopes.ts";

export interface SpecParam {
  name: string;
  kind: "path" | "query" | "body" | "header";
  required: boolean;
  type: string;
  description: string;
}

export interface SpecEndpoint {
  id: string;
  method: "GET" | "POST";
  path: string;
  routeFile: string;
  summary: string;
  scope: Scope;
  params: SpecParam[];
  sampleBody?: string;
  sampleResponse: string;
  curl: (host: string, key: string) => string;
}

const SAMPLE_A = `def add(a, b):\n    return a + b\n`;
const SAMPLE_B = `def sum_two(x, y):\n    return x + y\n`;

const compareBody = JSON.stringify(
  { a: SAMPLE_A, b: SAMPLE_B, language: "python" },
  null,
  2,
);

const compareResponse = JSON.stringify(
  {
    language: "python",
    scores: {
      tokenJaccard: 0.71,
      shingleJaccard: 0.62,
      lcsRatio: 0.55,
    },
    clone: { label: "near-duplicate", confidence: 0.82 },
    bytes: { a: 27, b: 32 },
  },
  null,
  2,
);

const batchBody = JSON.stringify(
  {
    language: "python",
    snippets: [
      { id: "v1", code: SAMPLE_A },
      { id: "v2", code: SAMPLE_B },
      { id: "v3", code: "def total(a,b):\n  return a+b\n" },
    ],
  },
  null,
  2,
);

const batchResponse = JSON.stringify(
  {
    language: "python",
    count: 3,
    pairs: [
      {
        a: "v1",
        b: "v2",
        scores: { tokenJaccard: 0.71, shingleJaccard: 0.62, lcsRatio: 0.55 },
        clone: { label: "near-duplicate", confidence: 0.82 },
      },
    ],
  },
  null,
  2,
);

const sharesListResponse = JSON.stringify(
  {
    total: 1,
    count: 1,
    limit: 25,
    offset: 0,
    items: [
      {
        id: "abc1234567",
        title: "sum helpers",
        language: "python",
        cloneLabel: "near-duplicate",
        shingleJaccard: 0.62,
        tags: ["review"],
        createdAt: 1717000000000,
        bytes: { a: 27, b: 32 },
      },
    ],
  },
  null,
  2,
);

const shareDetailResponse = JSON.stringify(
  {
    id: "abc1234567",
    title: "sum helpers",
    language: "python",
    snippets: { a: SAMPLE_A, b: SAMPLE_B },
    scores: { tokenJaccard: 0.71, shingleJaccard: 0.62, lcsRatio: 0.55 },
    clone: { label: "near-duplicate", confidence: 0.82 },
    createdAt: 1717000000000,
  },
  null,
  2,
);

const webhooksListResponse = JSON.stringify(
  {
    workspace_id: "ws_acme",
    count: 1,
    supported_events: ["compare.completed", "batch.completed", "audit.recorded", "webhook.ping"],
    items: [
      {
        id: "wh_2a9k1p4q",
        workspaceId: "ws_acme",
        label: "prod-pagerduty",
        url: "https://example.com/hooks/codeclone",
        events: ["compare.completed", "audit.recorded"],
        secretPrefix: "whsec_aBcD",
        createdAt: 1717000000000,
        successCount: 42,
        failureCount: 0,
      },
    ],
  },
  null,
  2,
);

const webhooksCreateBody = JSON.stringify(
  {
    label: "prod-pagerduty",
    url: "https://example.com/hooks/codeclone",
    events: ["compare.completed", "audit.recorded"],
  },
  null,
  2,
);

const webhooksCreateResponse = JSON.stringify(
  {
    webhook: {
      id: "wh_2a9k1p4q",
      workspaceId: "ws_acme",
      label: "prod-pagerduty",
      url: "https://example.com/hooks/codeclone",
      events: ["compare.completed", "audit.recorded"],
      secretPrefix: "whsec_aBcD",
      createdAt: 1717000000000,
      successCount: 0,
      failureCount: 0,
    },
    secret: "whsec_REDACTED_SHOWN_ONCE",
    secret_notice:
      "Store this signing secret now. It will never be shown again. Use it to verify the X-CodeClone-Signature header on every delivery.",
  },
  null,
  2,
);

function shJsonArg(s: string): string {
  // Single-quote for shell, escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const ENDPOINTS: SpecEndpoint[] = [
  {
    id: "compare",
    method: "POST",
    path: "/v1/compare",
    routeFile: "app/api/v1/compare/route.ts",
    summary: "Score similarity between two code snippets and classify the clone type.",
    scope: "compare:write",
    params: [
      { name: "a", kind: "body", required: true, type: "string", description: "First snippet source. Max 64 KB." },
      { name: "b", kind: "body", required: true, type: "string", description: "Second snippet source. Max 64 KB." },
      { name: "language", kind: "body", required: false, type: "string", description: "Hint for tokenizer (python, javascript, typescript, java, go, rust)." },
      { name: "dry_run", kind: "body", required: false, type: "boolean", description: "Sandbox mode. Validates input, scope, quota, and rate limits then returns the would-be result without charging quota, logging usage, or firing webhooks. Also accepted as ?dry_run=true." },
    ],
    sampleBody: compareBody,
    sampleResponse: compareResponse,
    curl: (host, key) =>
      `curl -sS ${host}/v1/compare \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shJsonArg(compareBody)}`,
  },
  {
    id: "batch",
    method: "POST",
    path: "/v1/batch",
    routeFile: "app/api/v1/batch/route.ts",
    summary: "Run pairwise similarity over up to 12 snippets in one billable call.",
    scope: "batch:write",
    params: [
      { name: "language", kind: "body", required: false, type: "string", description: "Tokenizer hint applied to every snippet." },
      { name: "snippets", kind: "body", required: true, type: "Array<{id,code}>", description: "2..12 snippets. Each id must be unique." },
      { name: "dry_run", kind: "body", required: false, type: "boolean", description: "Sandbox mode. Returns the preview including pair_count and total_bytes without charging quota or firing webhooks. Also accepted as ?dry_run=true." },
    ],
    sampleBody: batchBody,
    sampleResponse: batchResponse,
    curl: (host, key) =>
      `curl -sS ${host}/v1/batch \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shJsonArg(batchBody)}`,
  },
  {
    id: "shares-list",
    method: "GET",
    path: "/v1/shares",
    routeFile: "app/api/v1/shares/route.ts",
    summary: "List saved comparison results. Supports search, tag, language, and score filters.",
    scope: "shares:read",
    params: [
      { name: "limit", kind: "query", required: false, type: "1..100", description: "Page size. Default 25." },
      { name: "offset", kind: "query", required: false, type: "integer >= 0", description: "Page offset. Default 0." },
      { name: "q", kind: "query", required: false, type: "string", description: "Free-text search over title, tags, and snippet text." },
      { name: "tag", kind: "query", required: false, type: "string", description: "Exact tag match." },
      { name: "language", kind: "query", required: false, type: "string", description: "Filter by language id." },
      { name: "label", kind: "query", required: false, type: "string", description: "Filter by clone label (e.g. near-duplicate)." },
      { name: "minScore", kind: "query", required: false, type: "0..1", description: "Lower bound on shingle Jaccard." },
      { name: "maxScore", kind: "query", required: false, type: "0..1", description: "Upper bound on shingle Jaccard." },
    ],
    sampleResponse: sharesListResponse,
    curl: (host, key) =>
      `curl -sS "${host}/v1/shares?limit=10&label=near-duplicate" \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "shares-get",
    method: "GET",
    path: "/v1/shares/{id}",
    routeFile: "app/api/v1/shares/[id]/route.ts",
    summary: "Fetch a saved comparison including both snippets, scores, and alignment.",
    scope: "shares:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Share id returned from /v1/shares or the share UI." },
    ],
    sampleResponse: shareDetailResponse,
    curl: (host, key) =>
      `curl -sS ${host}/v1/shares/abc1234567 \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "audit",
    method: "GET",
    path: "/v1/audit",
    routeFile: "app/api/v1/audit/route.ts",
    summary: "Stream workspace-scoped audit entries as NDJSON for SIEM ingestion (Splunk, Datadog, Elastic).",
    scope: "audit:read",
    params: [
      { name: "limit", kind: "query", required: false, type: "1..500", description: "Page size. Default 100." },
      { name: "format", kind: "query", required: false, type: "ndjson|json", description: "Response format. Default ndjson (one entry per line). 'json' returns an object with an items array." },
      { name: "action", kind: "query", required: false, type: "string", description: "Exact action match (e.g. 'snippet.create') or prefix with trailing dot ('snippet.')." },
      { name: "status", kind: "query", required: false, type: "ok|denied|error", description: "Filter by outcome. Useful for surfacing only policy denials." },
      { name: "actorId", kind: "query", required: false, type: "string", description: "Filter by acting user or API key id." },
      { name: "targetType", kind: "query", required: false, type: "string", description: "Filter by audited target type (e.g. 'share', 'api_key')." },
      { name: "targetId", kind: "query", required: false, type: "string", description: "Filter by audited target id." },
      { name: "since", kind: "query", required: false, type: "ISO 8601 or ms epoch", description: "Only return entries at or after this time." },
      { name: "until", kind: "query", required: false, type: "ISO 8601 or ms epoch", description: "Only return entries at or before this time. Use the X-Next-Until response header to paginate backwards." },
    ],
    sampleResponse: JSON.stringify(
      {
        workspace_id: "ws_acme",
        count: 1,
        limit: 100,
        next_until: null,
        items: [
          {
            v: 1,
            id: "a1b2c3d4e5",
            ts: 1717000000000,
            actorId: "u_42",
            actorEmail: "alice@acme.com",
            workspaceId: "ws_acme",
            action: "share.create",
            target: { type: "share", id: "abc1234567" },
            status: "ok",
            ip: "203.0.113.7",
            requestId: "req_8f3e2a1b",
          },
        ],
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS "${host}/v1/audit?limit=100&status=denied" \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "webhooks-list",
    method: "GET",
    path: "/v1/webhooks",
    routeFile: "app/api/v1/webhooks/route.ts",
    summary: "List the calling workspace's webhook endpoints. Signing secrets are never returned.",
    scope: "webhooks:read",
    params: [],
    sampleResponse: webhooksListResponse,
    curl: (host, key) =>
      `curl -sS ${host}/v1/webhooks \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "webhooks-create",
    method: "POST",
    path: "/v1/webhooks",
    routeFile: "app/api/v1/webhooks/route.ts",
    summary: "Provision a webhook endpoint in the calling workspace. The signing secret is returned exactly once.",
    scope: "webhooks:write",
    params: [
      { name: "url", kind: "body", required: true, type: "https URL", description: "Receiver URL. Must be https. Public hosts only (private/loopback ranges are rejected). Honours the workspace webhook domain allowlist if configured." },
      { name: "label", kind: "body", required: false, type: "string", description: "Human label shown in the dashboard. Max 60 chars." },
      { name: "events", kind: "body", required: false, type: "string[]", description: "Subset of supported events to subscribe to. Defaults to compare.completed." },
      { name: "dry_run", kind: "body", required: false, type: "boolean", description: "Sandbox mode. Validates auth, scope, policy, and URL then returns a preview without creating the webhook or charging quota. Also accepted as ?dry_run=true." },
    ],
    sampleBody: webhooksCreateBody,
    sampleResponse: webhooksCreateResponse,
    curl: (host, key) =>
      `curl -sS ${host}/v1/webhooks \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shJsonArg(webhooksCreateBody)}`,
  },
  {
    id: "members-list",
    method: "GET",
    path: "/v1/members",
    routeFile: "app/api/v1/members/route.ts",
    summary: "List the calling workspace's members and roles for identity governance reconciliation.",
    scope: "members:read",
    params: [
      { name: "include_suspended", kind: "query", required: false, type: "boolean", description: "Include members retained in 'suspended' status for forensic continuity. Default false." },
      { name: "include_support", kind: "query", required: false, type: "boolean", description: "Include just-in-time support access grants. Default false." },
    ],
    sampleResponse: JSON.stringify(
      {
        workspace: { id: "ws_acme", name: "Acme", slug: "acme", plan: "pro" },
        count: 2,
        include_suspended: false,
        include_support: false,
        items: [
          {
            user_id: "u_42",
            email: "alice@acme.com",
            role: "owner",
            status: "active",
            joined_at: 1717000000000,
            suspended_at: null,
            suspended_reason: null,
            expires_at: null,
            granted_by: null,
            grant_reason: null,
          },
          {
            user_id: "u_91",
            email: "bob@acme.com",
            role: "editor",
            status: "active",
            joined_at: 1717100000000,
            suspended_at: null,
            suspended_reason: null,
            expires_at: null,
            granted_by: null,
            grant_reason: null,
          },
        ],
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS "${host}/v1/members?include_suspended=true" \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "export-bundle",
    method: "GET",
    path: "/v1/export",
    routeFile: "app/api/v1/export/route.ts",
    summary: "Download the calling workspace's GDPR Article 20 portability bundle (members, invites, API key metadata, audit log, SCIM mirror).",
    scope: "export:read",
    params: [
      { name: "format", kind: "query", required: false, type: "string", description: "json (default) returns the full bundle; csv returns the audit log flattened to CSV for DPA review packets." },
    ],
    sampleResponse: JSON.stringify(
      {
        v: 1,
        exportedAt: 1717200000000,
        workspace: { id: "ws_acme", name: "Acme", slug: "acme", plan: "pro" },
        invites: [],
        apiKeys: [{ id: "key_xxx", prefix: "ck_live_", scopes: ["compare:write"] }],
        audit: [{ action: "v1.compare.write", actorId: "key_xxx", workspaceId: "ws_acme", at: 1717100000000 }],
        scimUsers: [],
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS "${host}/v1/export?format=json" \\
  -H "Authorization: Bearer ${key}" \\
  -o workspace-export.json`,
  },
  {
    id: "webhooks-get",
    method: "GET",
    path: "/v1/webhooks/{id}",
    routeFile: "app/api/v1/webhooks/[id]/route.ts",
    summary: "Fetch a single webhook endpoint summary. Returns 404 for ids in other workspaces.",
    scope: "webhooks:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Webhook id from /v1/webhooks or the dashboard." },
    ],
    sampleResponse: JSON.stringify(
      {
        id: "wh_2a9k1p4q",
        workspaceId: "ws_acme",
        label: "prod-pagerduty",
        url: "https://example.com/hooks/codeclone",
        events: ["compare.completed", "audit.recorded"],
        secretPrefix: "whsec_aBcD",
        createdAt: 1717000000000,
        successCount: 42,
        failureCount: 0,
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS ${host}/v1/webhooks/wh_2a9k1p4q \\\n  -H "Authorization: Bearer ${key}"`,
  },
];

export function endpointsForScopes(scopes: readonly Scope[] | undefined): SpecEndpoint[] {
  if (!scopes) return ENDPOINTS;
  const allow = new Set(scopes);
  return ENDPOINTS.filter((e) => allow.has(e.scope));
}

export function allReferencedScopes(): Scope[] {
  const set = new Set<Scope>();
  for (const e of ENDPOINTS) set.add(e.scope);
  // Stable order matching ALL_SCOPES.
  return ALL_SCOPES.filter((s) => set.has(s));
}
