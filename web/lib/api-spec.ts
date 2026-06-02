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
  method: "GET" | "POST" | "PATCH" | "DELETE";
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
    id: "shares-create",
    method: "POST",
    path: "/v1/shares",
    routeFile: "app/api/v1/shares/route.ts",
    summary: "Create a saved comparison from CI or an SDK. Server recomputes scores and stamps tenant, returns a public /r/<id> link.",
    scope: "shares:write",
    params: [
      { name: "a", kind: "body", required: true, type: "string", description: "Left snippet. Non-empty, utf-8, <= MAX_SNIPPET_BYTES." },
      { name: "b", kind: "body", required: true, type: "string", description: "Right snippet. Non-empty, utf-8, <= MAX_SNIPPET_BYTES." },
      { name: "language", kind: "body", required: false, type: "string", description: "Language id (e.g. javascript, python). Defaults to 'auto'." },
      { name: "title", kind: "body", required: false, type: "string", description: "Optional title shown on /r/<id> and in history listings." },
      { name: "tags", kind: "body", required: false, type: "string[]", description: "Optional tags. Lowercased and slugged server-side." },
    ],
    sampleResponse: JSON.stringify(
      {
        id: "abc1234567",
        url: "/r/abc1234567",
        language: "javascript",
        title: "build-4127 near-duplicate",
        tags: ["ci", "build-4127"],
        workspace_id: "ws_tenant_alpha",
        scores: { shingleJaccard: 0.83, tokenJaccard: 0.71, containment: 0.88 },
        clone: { label: "near-duplicate", confidence: 0.82 },
        bytes: { a: 38, b: 38 },
        created_at: 1748730000000,
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X POST ${host}/v1/shares \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"a":"function add(x,y){return x+y;}","b":"function add(a,b){return a+b;}","language":"javascript","title":"ci-near-dup"}'`,
  },
  {
    id: "shares-update",
    method: "PATCH",
    path: "/v1/shares/{id}",
    routeFile: "app/api/v1/shares/[id]/route.ts",
    summary: "Edit the title and/or tags of a saved comparison in place. Does not re-run the model or rotate the share id.",
    scope: "shares:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Share id returned from /v1/shares or the share UI." },
      { name: "title", kind: "body", required: false, type: "string | null", description: "New title. Pass null or empty string to clear." },
      { name: "tags", kind: "body", required: false, type: "string[] | null", description: "New tag set (replaces, not merges). Pass null or [] to clear. Lowercased and slugged server-side." },
      { name: "dry_run", kind: "query", required: false, type: "boolean", description: "If true, validate and audit the call but do not mutate storage. Response includes the x-codeclone-dry-run header." },
    ],
    sampleResponse: JSON.stringify(
      {
        share: {
          id: "abc1234567",
          created_at: 1748730000000,
          updated_at: 1748733600000,
          language: "javascript",
          title: "case-2025-0142 near-duplicate",
          tags: ["case-2025-0142", "soc2"],
          url: "/r/abc1234567",
        },
        changed: true,
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X PATCH ${host}/v1/shares/abc1234567 \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"case-2025-0142 near-duplicate","tags":["case-2025-0142","soc2"]}'`,
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
    id: "audit-verify",
    method: "GET",
    path: "/v1/audit/verify",
    routeFile: "app/api/v1/audit/verify/route.ts",
    summary: "Verify the immutable audit hash chain for tamper evidence. Returns the head hash for external pinning (notary, WORM, SOC2 evidence). 200 ok, 409 broken.",
    scope: "audit:read",
    params: [],
    sampleResponse: JSON.stringify(
      {
        ok: true,
        total_entries: 12843,
        chained_entries: 12843,
        legacy_entries: 0,
        first_day: "2025-01-04",
        last_day: "2026-05-31",
        last_hash: "7f2c1d3e9a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5",
        broken_at: null,
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS ${host}/v1/audit/verify \\\n  -H "Authorization: Bearer ${key}"`,
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
    id: "webhooks-failures",
    method: "GET",
    path: "/v1/webhooks/failures",
    routeFile: "app/api/v1/webhooks/failures/route.ts",
    summary: "Stream recent failed webhook delivery attempts across every endpoint in the calling workspace. NDJSON by default for SIEM and on-call pipelines (Datadog, Splunk, PagerDuty, Opsgenie).",
    scope: "webhooks:read",
    params: [
      { name: "limit", kind: "query", required: false, type: "integer", description: "1..200, newest-first. Default 50." },
      { name: "since", kind: "query", required: false, type: "ms epoch or ISO 8601", description: "Only failures attempted at or after this timestamp." },
      { name: "format", kind: "query", required: false, type: "'ndjson' | 'json'", description: "Response shape. Defaults to ndjson (one failure per line) for SIEM ingestion." },
    ],
    sampleResponse: JSON.stringify(
      {
        workspace_id: "ws_acme",
        count: 1,
        limit: 50,
        items: [
          {
            webhookId: "wh_8f3e2a",
            label: "prod pagerduty",
            url: "https://events.pagerduty.com/x/integration/abc",
            event: "compare.completed",
            attemptedAt: 1717000123000,
            status: 503,
            attempts: 3,
            error: "upstream 503",
          },
        ],
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS "${host}/v1/webhooks/failures?limit=100" \\\n  -H "Authorization: Bearer ${key}"`,
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
    id: "members-get",
    method: "GET",
    path: "/v1/members/:user_id",
    routeFile: "app/api/v1/members/[userId]/route.ts",
    summary: "Fetch a single workspace member's role, status, and (for support grants) expiry, without paginating the roster. Used by IGA runbooks reconciling one user.",
    scope: "members:read",
    params: [
      { name: "user_id", kind: "path", required: true, type: "string", description: "Target user id within the calling workspace." },
    ],
    sampleResponse: JSON.stringify(
      {
        member: {
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
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS ${host}/v1/members/u_91 \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "members-invite",
    method: "POST",
    path: "/v1/members",
    routeFile: "app/api/v1/members/route.ts",
    summary: "Invite a member to the calling workspace. Caller's key must be bound to an active owner. Used by Workday joiner pipelines to land first-day access.",
    scope: "members:write",
    params: [
      { name: "email", kind: "body", required: true, type: "string", description: "Invitee email. Must satisfy the workspace invite-domain allowlist if one is set." },
      { name: "role", kind: "body", required: true, type: "string", description: "'editor' or 'viewer'. Owner role cannot be granted via invite." },
    ],
    sampleBody: JSON.stringify({ email: "carol@acme.com", role: "editor" }, null, 2),
    sampleResponse: JSON.stringify(
      {
        invite: {
          id: "inv_abc123",
          workspace_id: "ws_acme",
          email: "carol@acme.com",
          role: "editor",
          invited_by: "u_42",
          created_at: 1717200000000,
          expires_at: 1717804800000,
          accept_url: "https://codeclone.example/workspaces/invite/inv_abc123.XXXX",
        },
        token: "inv_abc123.XXXXXXXXXXXXXXXX",
        token_notice: "Store this token now. It will never be shown again.",
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS ${host}/v1/members \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"email":"carol@acme.com","role":"editor"}'`,
  },
  {
    id: "members-update",
    method: "PATCH",
    path: "/v1/members/:user_id",
    routeFile: "app/api/v1/members/[userId]/route.ts",
    summary: "Change a member's role ('editor'|'viewer') and/or status ('active'|'suspended'). Owner-bound key required; owner demotion blocked here.",
    scope: "members:write",
    params: [
      { name: "user_id", kind: "path", required: true, type: "string", description: "Target user id within the calling workspace." },
      { name: "role", kind: "body", required: false, type: "string", description: "'editor' or 'viewer'." },
      { name: "status", kind: "body", required: false, type: "string", description: "'active' or 'suspended'. Suspension preserves the audit trail." },
      { name: "reason", kind: "body", required: false, type: "string", description: "Free-text suspension reason (max 280 chars)." },
    ],
    sampleBody: JSON.stringify({ role: "viewer", status: "suspended", reason: "Workday leaver event" }, null, 2),
    sampleResponse: JSON.stringify(
      {
        member: {
          user_id: "u_91",
          email: "bob@acme.com",
          role: "viewer",
          status: "suspended",
          joined_at: 1717100000000,
          suspended_at: 1717250000000,
          suspended_reason: "Workday leaver event",
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X PATCH ${host}/v1/members/u_91 \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"suspended","reason":"Workday leaver event"}'`,
  },
  {
    id: "members-remove",
    method: "DELETE",
    path: "/v1/members/:user_id",
    routeFile: "app/api/v1/members/[userId]/route.ts",
    summary: "Remove a member from the calling workspace's roster. Owner-bound key required; self-removal blocked.",
    scope: "members:write",
    params: [
      { name: "user_id", kind: "path", required: true, type: "string", description: "Target user id within the calling workspace." },
    ],
    sampleResponse: JSON.stringify({ id: "u_91", removed: true }, null, 2),
    curl: (host, key) =>
      `curl -sS -X DELETE ${host}/v1/members/u_91 \\\n  -H "Authorization: Bearer ${key}"`,
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
    id: "erasure-execute",
    method: "POST",
    path: "/v1/erasure",
    routeFile: "app/api/v1/erasure/route.ts",
    summary: "Execute GDPR Article 17 (right to erasure) bulk deletion of the calling workspace's saved comparisons. Supports explicit id lists or a filter (tag, language, created_before) plus dry_run preview. Writes a v1.erasure.execute audit row that doubles as a DPO erasure receipt.",
    scope: "erasure:write",
    params: [
      { name: "ids", kind: "body", required: false, type: "string[]", description: "Explicit list of share ids to erase. Mutually exclusive with 'filter'. Foreign-tenant ids are silently skipped, not 404ed." },
      { name: "filter", kind: "body", required: false, type: "object", description: "Bulk selector with optional tag, language, and created_before (epoch ms). Mutually exclusive with 'ids'." },
      { name: "dry_run", kind: "body", required: false, type: "boolean", description: "Preview the erasure without deleting; returns the same auth/scope/rate-limit decisions and the would-be id list." },
    ],
    sampleBody: JSON.stringify(
      { filter: { tag: "customer-acme", created_before: 1717000000000 }, dry_run: true },
      null,
      2,
    ),
    sampleResponse: JSON.stringify(
      {
        mode: "filter",
        workspace_id: "ws_acme",
        erased: { ids: ["abc1234567", "def8901234"], count: 2 },
        skipped: [],
        failed: [],
        receipt: {
          action: "v1.erasure.execute",
          actor_key_id: "key_xxx",
          workspace_id: "ws_acme",
          at: 1717200000000,
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X POST ${host}/v1/erasure \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"filter":{"tag":"customer-acme"},"dry_run":true}'`,
  },
  {
    id: "webhooks-ping",
    method: "POST",
    path: "/v1/webhooks/{id}/ping",
    routeFile: "app/api/v1/webhooks/[id]/ping/route.ts",
    summary: "Fire a one-shot, fully-signed webhook.ping delivery so CI / SOAR scripts can prove HMAC verification and reachability without a person clicking the dashboard. Increments the same counters and writes the same delivery-log entry as a live event. Returns 200 if the receiver answered 2xx, 502 otherwise, 409 if the webhook is paused, 404 for cross-tenant ids.",
    scope: "webhooks:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Webhook id from /v1/webhooks or the dashboard. A webhook id in another workspace returns 404 with no side effects." },
    ],
    sampleResponse: JSON.stringify(
      {
        delivery: {
          id: "whd_2a9k1p4q",
          webhookId: "wh_2a9k1p4q",
          event: "webhook.ping",
          ok: true,
          status: 200,
          attempts: 1,
          durationMs: 42,
          attemptedAt: 1717000000000,
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X POST ${host}/v1/webhooks/wh_2a9k1p4q/ping \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`,
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
  {
    id: "webhooks-update",
    method: "PATCH",
    path: "/v1/webhooks/{id}",
    routeFile: "app/api/v1/webhooks/[id]/route.ts",
    summary: "Edit a webhook in place: change URL, label, subscribed events, or pause delivery with disabled=true. Signing secret is intentionally NOT editable here (use /v1/webhooks/{id}/rotate, which has its own dual-secret grace window). Workspace domain allowlist is enforced on URL change. Audited with before/after diff for SOC2 CC6.1.",
    scope: "webhooks:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Webhook id from /v1/webhooks or the dashboard. A webhook id in another workspace returns 404 with no side effects." },
      { name: "label", kind: "body", required: false, type: "string", description: "New human-readable label. Trimmed and capped server-side." },
      { name: "url", kind: "body", required: false, type: "string", description: "New destination URL. Must be http(s); private/loopback/link-local hosts are refused unless explicitly allowed; must match the workspace webhook domain allowlist when one is configured." },
      { name: "events", kind: "body", required: false, type: "array", description: "New event subscription list. Unknown events are ignored; empty resolves to ['compare.completed']." },
      { name: "disabled", kind: "body", required: false, type: "boolean", description: "true pauses delivery without losing history or secret; false re-enables. Same effect as the dashboard pause/resume toggle." },
      { name: "dry_run", kind: "body", required: false, type: "boolean", description: "Sandbox mode. Returns the would-be summary without writing or recording usage. Also accepted as ?dry_run=true." },
    ],
    sampleBody: JSON.stringify({ url: "https://hooks.example.com/codeclone/v2", events: ["compare.completed", "audit.recorded"], disabled: false }, null, 2),
    sampleResponse: JSON.stringify(
      {
        webhook: {
          id: "wh_2a9k1p4q",
          workspaceId: "ws_acme",
          label: "prod-pagerduty",
          url: "https://hooks.example.com/codeclone/v2",
          events: ["compare.completed", "audit.recorded"],
          secretPrefix: "whsec_aBcD",
          createdAt: 1717000000000,
          updatedAt: 1717999999000,
          successCount: 42,
          failureCount: 0,
        },
        changed: true,
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X PATCH ${host}/v1/webhooks/wh_2a9k1p4q \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"url":"https://hooks.example.com/codeclone/v2","events":["compare.completed","audit.recorded"]}\'`,
  },
  {
    id: "snippets-list",
    method: "GET",
    path: "/v1/snippets",
    routeFile: "app/api/v1/snippets/route.ts",
    summary: "List the calling user's saved snippets. Supports q, tag, language, classification filters plus limit and offset. Strictly scoped to the API key's userId, never cross-user.",
    scope: "snippets:read",
    params: [
      { name: "q", kind: "query", required: false, type: "string", description: "Free-text match over title, body, and tags." },
      { name: "tag", kind: "query", required: false, type: "string", description: "Exact tag match (lowercased)." },
      { name: "language", kind: "query", required: false, type: "string", description: "Language id, e.g. python or typescript." },
      { name: "classification", kind: "query", required: false, type: "string", description: "One of public, internal, confidential, restricted." },
      { name: "limit", kind: "query", required: false, type: "integer", description: "1..100, default 25." },
      { name: "offset", kind: "query", required: false, type: "integer", description: ">= 0, default 0." },
    ],
    sampleResponse: JSON.stringify(
      {
        count: 1,
        limit: 25,
        offset: 0,
        items: [
          {
            id: "sn_2k9j1p4q",
            title: "acme baseline parser",
            language: "python",
            body: "def parse(s):\n    return s.strip()\n",
            tags: ["baseline", "parser"],
            classification: "internal",
            created_at: 1717000000000,
            updated_at: 1717000000000,
          },
        ],
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS "${host}/v1/snippets?language=python&limit=10" \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "snippets-create",
    method: "POST",
    path: "/v1/snippets",
    routeFile: "app/api/v1/snippets/route.ts",
    summary: "Create a snippet in the calling user's corpus. Useful for bulk-loading a baseline reference set from CI or migration scripts.",
    scope: "snippets:write",
    params: [
      { name: "title", kind: "body", required: true, type: "string", description: "Display label, 1..120 chars." },
      { name: "language", kind: "body", required: true, type: "string", description: "Language id, e.g. python." },
      { name: "body", kind: "body", required: true, type: "string", description: "Snippet source, up to 64 KiB." },
      { name: "tags", kind: "body", required: false, type: "string[]", description: "Up to 8 tags, each <= 32 chars." },
      { name: "classification", kind: "body", required: false, type: "string", description: "public | internal | confidential | restricted. Defaults to internal." },
    ],
    sampleBody: JSON.stringify(
      { title: "acme baseline parser", language: "python", body: "def parse(s):\n    return s.strip()\n", tags: ["baseline"], classification: "internal" },
      null,
      2,
    ),
    sampleResponse: JSON.stringify(
      {
        snippet: {
          id: "sn_2k9j1p4q",
          title: "acme baseline parser",
          language: "python",
          body: "def parse(s):\n    return s.strip()\n",
          tags: ["baseline"],
          classification: "internal",
          created_at: 1717000000000,
          updated_at: 1717000000000,
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X POST ${host}/v1/snippets \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"acme baseline parser","language":"python","body":"def parse(s):\\n    return s.strip()\\n"}'`,
  },
  {
    id: "snippets-get",
    method: "GET",
    path: "/v1/snippets/{id}",
    routeFile: "app/api/v1/snippets/[id]/route.ts",
    summary: "Fetch a single snippet by id. Returns 404 for ids that belong to other users.",
    scope: "snippets:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Snippet id from /v1/snippets or the dashboard." },
    ],
    sampleResponse: JSON.stringify(
      {
        snippet: {
          id: "sn_2k9j1p4q",
          title: "acme baseline parser",
          language: "python",
          body: "def parse(s):\n    return s.strip()\n",
          tags: ["baseline"],
          classification: "internal",
          created_at: 1717000000000,
          updated_at: 1717000000000,
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS ${host}/v1/snippets/sn_2k9j1p4q \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "snippets-update",
    method: "PATCH",
    path: "/v1/snippets/{id}",
    routeFile: "app/api/v1/snippets/[id]/route.ts",
    summary: "Partial update of a snippet. Any subset of title, language, body, tags, classification.",
    scope: "snippets:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Snippet id." },
      { name: "title", kind: "body", required: false, type: "string", description: "New display label." },
      { name: "language", kind: "body", required: false, type: "string", description: "New language id." },
      { name: "body", kind: "body", required: false, type: "string", description: "New source body." },
      { name: "tags", kind: "body", required: false, type: "string[]", description: "Replacement tag set." },
      { name: "classification", kind: "body", required: false, type: "string", description: "public | internal | confidential | restricted." },
    ],
    sampleBody: JSON.stringify({ tags: ["baseline", "reviewed"], classification: "confidential" }, null, 2),
    sampleResponse: JSON.stringify(
      {
        snippet: {
          id: "sn_2k9j1p4q",
          title: "acme baseline parser",
          language: "python",
          body: "def parse(s):\n    return s.strip()\n",
          tags: ["baseline", "reviewed"],
          classification: "confidential",
          created_at: 1717000000000,
          updated_at: 1717200000000,
        },
      },
      null,
      2,
    ),
    curl: (host, key) =>
      `curl -sS -X PATCH ${host}/v1/snippets/sn_2k9j1p4q \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"classification":"confidential"}'`,
  },
  {
    id: "snippets-delete",
    method: "DELETE",
    path: "/v1/snippets/{id}",
    routeFile: "app/api/v1/snippets/[id]/route.ts",
    summary: "Permanently delete a snippet from the calling user's corpus.",
    scope: "snippets:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Snippet id." },
    ],
    sampleResponse: JSON.stringify({ ok: true, id: "sn_2k9j1p4q" }, null, 2),
    curl: (host, key) =>
      `curl -sS -X DELETE ${host}/v1/snippets/sn_2k9j1p4q \\\n  -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "collections-list",
    method: "GET",
    path: "/v1/collections",
    routeFile: "app/api/v1/collections/route.ts",
    summary: "List the calling workspace's share collections. Strictly scoped to the API key's workspaceId, never cross-workspace.",
    scope: "collections:read",
    params: [
      { name: "limit", kind: "query", required: false, type: "1..100", description: "Page size. Default 25." },
      { name: "offset", kind: "query", required: false, type: "integer >= 0", description: "Page offset. Default 0." },
      { name: "q", kind: "query", required: false, type: "string", description: "Free-text match over title and description." },
      { name: "sort", kind: "query", required: false, type: "updated|created|title|count", description: "Sort key. Default updated." },
      { name: "dir", kind: "query", required: false, type: "asc|desc", description: "Sort direction. Default desc." },
    ],
    sampleResponse: JSON.stringify({ items: [{ id: "abc1234567", title: "sprint 42 dupes", count: 3, createdAt: 1717000000000, updatedAt: 1717000000000 }], total: 1, offset: 0, limit: 25, next_offset: null }, null, 2),
    curl: (host, key) => `curl -sS "${host}/v1/collections?limit=10" -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "collections-create",
    method: "POST",
    path: "/v1/collections",
    routeFile: "app/api/v1/collections/route.ts",
    summary: "Create a share collection in the calling workspace. Stamps workspaceId so subsequent /v1 reads stay isolated.",
    scope: "collections:write",
    params: [
      { name: "title", kind: "body", required: true, type: "string", description: "1..120 chars." },
      { name: "description", kind: "body", required: false, type: "string", description: "Up to 500 chars." },
      { name: "shareIds", kind: "body", required: false, type: "string[]", description: "Up to 200 share ids." },
    ],
    sampleBody: JSON.stringify({ title: "sprint 42 dupes", shareIds: ["abc1234567"] }, null, 2),
    sampleResponse: JSON.stringify({ collection: { id: "abc1234567", title: "sprint 42 dupes", shareIds: ["abc1234567"], createdAt: 1717000000000, updatedAt: 1717000000000 } }, null, 2),
    curl: (host, key) => `curl -sS -X POST ${host}/v1/collections -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"title":"sprint 42 dupes"}'`,
  },
  {
    id: "collections-get",
    method: "GET",
    path: "/v1/collections/{id}",
    routeFile: "app/api/v1/collections/[id]/route.ts",
    summary: "Fetch a collection. Returns 404 if the record exists in another workspace, never leaking cross-tenant existence.",
    scope: "collections:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
    ],
    sampleResponse: JSON.stringify({ collection: { id: "abc1234567", title: "sprint 42 dupes", shareIds: ["abc1234567"], createdAt: 1717000000000, updatedAt: 1717000000000 } }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/collections/abc1234567 -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "collections-update",
    method: "PATCH",
    path: "/v1/collections/{id}",
    routeFile: "app/api/v1/collections/[id]/route.ts",
    summary: "Patch a collection title or description. Cross-workspace ids return 404.",
    scope: "collections:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
      { name: "title", kind: "body", required: false, type: "string", description: "1..120 chars." },
      { name: "description", kind: "body", required: false, type: "string|null", description: "New description, or null to clear." },
    ],
    sampleBody: JSON.stringify({ title: "sprint 42 dupes (closed)" }, null, 2),
    sampleResponse: JSON.stringify({ collection: { id: "abc1234567", title: "sprint 42 dupes (closed)", shareIds: ["abc1234567"], createdAt: 1717000000000, updatedAt: 1717000001000 } }, null, 2),
    curl: (host, key) => `curl -sS -X PATCH ${host}/v1/collections/abc1234567 -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"title":"sprint 42 dupes (closed)"}'`,
  },
  {
    id: "collections-delete",
    method: "DELETE",
    path: "/v1/collections/{id}",
    routeFile: "app/api/v1/collections/[id]/route.ts",
    summary: "Delete a collection from the calling workspace. Cross-workspace ids return 404.",
    scope: "collections:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
    ],
    sampleResponse: JSON.stringify({ deleted: true }, null, 2),
    curl: (host, key) => `curl -sS -X DELETE ${host}/v1/collections/abc1234567 -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "collections-item-add",
    method: "POST",
    path: "/v1/collections/{id}/items",
    routeFile: "app/api/v1/collections/[id]/items/route.ts",
    summary: "Add a share to a collection. Both the collection and the referenced share must belong to the calling key's workspace; cross-tenant ids return 404 to avoid leaking existence.",
    scope: "collections:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
      { name: "shareId", kind: "body", required: true, type: "string", description: "Share id to add. Must be owned by the same workspace as the collection." },
    ],
    sampleBody: JSON.stringify({ shareId: "abc1234567" }, null, 2),
    sampleResponse: JSON.stringify({ collection: { id: "abc1234567", title: "sprint 42 dupes", shareIds: ["abc1234567"], createdAt: 1717000000000, updatedAt: 1717000002000 } }, null, 2),
    curl: (host, key) => `curl -sS -X POST ${host}/v1/collections/abc1234567/items -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"shareId":"def4567890"}'`,
  },
  {
    id: "collections-item-remove",
    method: "DELETE",
    path: "/v1/collections/{id}/items",
    routeFile: "app/api/v1/collections/[id]/items/route.ts",
    summary: "Remove a share from a collection. Cross-workspace ids return 404.",
    scope: "collections:write",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
      { name: "shareId", kind: "query", required: true, type: "string", description: "Share id to remove." },
    ],
    sampleResponse: JSON.stringify({ collection: { id: "abc1234567", title: "sprint 42 dupes", shareIds: [], createdAt: 1717000000000, updatedAt: 1717000003000 } }, null, 2),
    curl: (host, key) => `curl -sS -X DELETE "${host}/v1/collections/abc1234567/items?shareId=def4567890" -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "collections-item-list",
    method: "GET",
    path: "/v1/collections/{id}/items",
    routeFile: "app/api/v1/collections/[id]/items/route.ts",
    summary: "Paginated expansion of a collection's items. Each row carries share id, language, clone label, shingle Jaccard, byte counts, and createdAt. Cross-tenant collection ids return 404; shares the calling workspace cannot see surface as `{ missing: true }` so the cursor stays stable across visibility changes.",
    scope: "collections:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Collection id." },
      { name: "limit", kind: "query", required: false, type: "number", description: "Page size, 1..100. Defaults to 25." },
      { name: "cursor", kind: "query", required: false, type: "string", description: "Opaque cursor returned in `next_cursor` from a previous page." },
    ],
    sampleResponse: JSON.stringify({ collection_id: "abc1234567", items: [{ id: "def4567890", title: "login flow vs onboarding flow", language: "typescript", cloneLabel: "near-duplicate", shingleJaccard: 0.82, createdAt: 1717000000000, bytes: { a: 1240, b: 1310 } }], total: 1, next_cursor: null }, null, 2),
    curl: (host, key) => `curl -sS "${host}/v1/collections/abc1234567/items?limit=25" -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "sessions-list",
    method: "GET",
    path: "/v1/sessions",
    routeFile: "app/api/v1/sessions/route.ts",
    summary: "List active dashboard sessions for every member of the calling workspace. SOC2 CC6.1 access reviews.",
    scope: "sessions:read",
    params: [],
    sampleResponse: JSON.stringify({ workspace_id: "ws_acme", sessions: [{ jti: "k7Q1...", user_id: "u_42", created_at: 1717000000000, expires_at: 1719600000000, last_seen_at: 1717003600000, ip: "203.0.113.7", user_agent: "Mozilla/5.0", created_ip: "203.0.113.7", created_user_agent: "Mozilla/5.0" }], total: 1 }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/sessions -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "sessions-get",
    method: "GET",
    path: "/v1/sessions/{jti}",
    routeFile: "app/api/v1/sessions/[jti]/route.ts",
    summary: "Fetch one dashboard session's metadata by jti. SOAR-friendly single-session lookup so runbooks can confirm a SIEM-flagged jti is still active before revoking, without paginating /v1/sessions.",
    scope: "sessions:read",
    params: [
      { name: "jti", kind: "path", required: true, type: "string", description: "Session id from /v1/sessions or a SIEM alert." },
    ],
    sampleResponse: JSON.stringify({ jti: "k7Q1abcDEF", user_id: "u_42", created_at: 1717000000000, expires_at: 1719600000000, last_seen_at: 1717003600000, ip: "203.0.113.7", user_agent: "Mozilla/5.0", created_ip: "203.0.113.7", created_user_agent: "Mozilla/5.0" }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/sessions/k7Q1abcDEF -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "sessions-revoke",
    method: "DELETE",
    path: "/v1/sessions/{jti}",
    routeFile: "app/api/v1/sessions/[jti]/route.ts",
    summary: "Revoke a single dashboard session by jti. Cross-workspace jtis return 404.",
    scope: "sessions:write",
    params: [
      { name: "jti", kind: "path", required: true, type: "string", description: "Session id from /v1/sessions." },
    ],
    sampleResponse: JSON.stringify({ jti: "k7Q1...", user_id: "u_42", revoked: true }, null, 2),
    curl: (host, key) => `curl -sS -X DELETE ${host}/v1/sessions/k7Q1abcDEF -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "sessions-revoke-all",
    method: "POST",
    path: "/v1/sessions/revoke-all",
    routeFile: "app/api/v1/sessions/revoke-all/route.ts",
    summary: "Force-logout every active session for a single workspace member. Incident-response kill switch.",
    scope: "sessions:write",
    params: [
      { name: "user_id", kind: "body", required: true, type: "string", description: "User id (must be a member of the calling workspace)." },
    ],
    sampleBody: JSON.stringify({ user_id: "u_42" }, null, 2),
    sampleResponse: JSON.stringify({ user_id: "u_42", revoked_count: 3 }, null, 2),
    curl: (host, key) => `curl -sS -X POST ${host}/v1/sessions/revoke-all -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"user_id":"u_42"}'`,
  },
  {
    id: "runs-list",
    method: "GET",
    path: "/v1/runs",
    routeFile: "app/api/v1/runs/route.ts",
    summary: "List training runs with headline metrics. Drop-in feed for MLflow, W&B, and ML supply-chain SIEM ingest.",
    scope: "runs:read",
    params: [
      { name: "status", kind: "query", required: false, type: "string", description: "Filter by run status: queued, running, passed, failed." },
      { name: "model", kind: "query", required: false, type: "string", description: "Filter by exact model id (matches the 'model' field returned by this endpoint)." },
      { name: "backend", kind: "query", required: false, type: "string", description: "Filter by training backend (e.g. mlx, torch)." },
      { name: "since", kind: "query", required: false, type: "string", description: "Only runs with started_at >= this value. Accepts epoch milliseconds or ISO-8601." },
      { name: "limit", kind: "query", required: false, type: "integer", description: "Max items to return. Default 50, max 200." },
      { name: "offset", kind: "query", required: false, type: "integer", description: "Page offset. Default 0." },
    ],
    sampleResponse: JSON.stringify({ count: 1, total: 1, limit: 50, offset: 0, items: [{ id: "r_2024_05_31_a", recipe_hash: "sha256:abc123", steps: 1500, last_loss: 0.412, backend: "mlx", model: "Qwen/Qwen2.5-Coder-0.5B", started_at: 1717000000000, status: "passed" }] }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/runs -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "runs-get",
    method: "GET",
    path: "/v1/runs/{id}",
    routeFile: "app/api/v1/runs/[id]/route.ts",
    summary: "Fetch hyperparameters, per-step metrics, and eval report for a single training run.",
    scope: "runs:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "Run id from /v1/runs." },
    ],
    sampleResponse: JSON.stringify({ id: "r_2024_05_31_a", recipe_hash: "sha256:abc123", steps: 1500, last_loss: 0.412, backend: "mlx", model: "Qwen/Qwen2.5-Coder-0.5B", started_at: 1717000000000, status: "passed", params: { lr: 0.0002, lora_r: 16 }, metrics: [{ step: 100, loss: 0.91 }, { step: 200, loss: 0.74 }], eval_report: { model: "Qwen/Qwen2.5-Coder-0.5B", mini_pass_rate: 0.72 } }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/runs/r_2024_05_31_a -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "keys-id-usage",
    method: "GET",
    path: "/v1/keys/{id}/usage",
    routeFile: "app/api/v1/keys/[id]/usage/route.ts",
    summary: "Per-key usage feed (by day, by endpoint, optional recent events) for SOC2 access reviews and dead-key revocation runbooks. Filtered to one key in the calling workspace; cross-tenant ids return 404.",
    scope: "usage:read",
    params: [
      { name: "id", kind: "path", required: true, type: "string", description: "API key id from /v1/keys." },
      { name: "days", kind: "query", required: false, type: "integer", description: "Trailing window in days (1..90). Default 7." },
      { name: "recent", kind: "query", required: false, type: "integer", description: "Include up to N most recent events for this key (0..200). Default 0." },
    ],
    sampleResponse: JSON.stringify({ key: { id: "k_abc123", prefix: "ck_live_abcd", label: "ci pipeline", revoked: false, expires_at: null, last_used_at: 1717000000000 }, window_days: 7, total_calls: 42, month_to_date: 211, last_event_at: 1717000000000, by_day: [{ date: "2024-05-31", count: 12 }], by_endpoint: [{ endpoint: "/v1/compare", count: 30, avg_latency_ms: 42.1, total_bytes: 12345 }], recent: [], server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/keys/k_abc123/usage?days=30 -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "allowlist-get",
    method: "GET",
    path: "/v1/allowlist",
    routeFile: "app/api/v1/allowlist/route.ts",
    summary: "Read the workspace IP CIDR allowlist for SOC2 CC6.6 evidence and SIEM reconciliation.",
    scope: "allowlist:read",
    params: [],
    sampleResponse: JSON.stringify({ workspace_id: "w_abc", entries: ["10.0.0.0/8", "203.0.113.4/32"], count: 2, max_entries: 64, enforced: true, server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/allowlist -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "allowlist-replace",
    method: "POST",
    path: "/v1/allowlist",
    routeFile: "app/api/v1/allowlist/route.ts",
    summary: "Append entries to the workspace IP CIDR allowlist. Returns the merged list plus any rejected raw inputs. Workspace owner only.",
    scope: "allowlist:write",
    params: [
      { name: "entries", kind: "body", required: true, type: "string[]", description: "CIDR strings to append (IPv4 or IPv6). Duplicates against the existing list are dropped silently. Malformed inputs are returned in `rejected`. Total list capped at 64." },
    ],
    sampleBody: JSON.stringify({ entries: ["198.51.100.7/32"] }, null, 2),
    sampleResponse: JSON.stringify({ workspace_id: "w_abc", entries: ["10.0.0.0/8", "203.0.113.4/32", "198.51.100.7/32"], count: 3, added: ["198.51.100.7/32"], rejected: [], max_entries: 64, enforced: true, server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS -X POST ${host}/v1/allowlist -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"entries":["198.51.100.7/32"]}'`,
  },
  {
    id: "lockdown-get",
    method: "GET",
    path: "/v1/lockdown",
    routeFile: "app/api/v1/lockdown/route.ts",
    summary: "Read this workspace's break-glass lockdown status for SOAR polling and SOC2 CC7.3 evidence.",
    scope: "lockdown:read",
    params: [],
    sampleResponse: JSON.stringify({ workspace_id: "w_abc", locked: true, lockdown: { active: true, reason: "Suspected key compromise: see PD-1042.", case_ref: "PD-1042", placed_at: 1717000000000, placed_by: "u_alice" }, server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS ${host}/v1/lockdown -H "Authorization: Bearer ${key}"`,
  },
  {
    id: "lockdown-place",
    method: "POST",
    path: "/v1/lockdown",
    routeFile: "app/api/v1/lockdown/route.ts",
    summary: "Place the workspace under break-glass lockdown. While active, every /v1 endpoint refuses calls bound to this workspace with HTTP 423. Workspace owner only.",
    scope: "lockdown:write",
    params: [
      { name: "reason", kind: "body", required: true, type: "string", description: "Human-readable cause, 3 to 500 chars. Recorded in the audit chain." },
      { name: "caseRef", kind: "body", required: false, type: "string", description: "Optional ticket id (PagerDuty, Jira, ServiceNow). Max 120 chars, [A-Za-z0-9 _-./#:]." },
    ],
    sampleBody: JSON.stringify({ reason: "Suspected key compromise: see PD-1042.", caseRef: "PD-1042" }, null, 2),
    sampleResponse: JSON.stringify({ workspace_id: "w_abc", locked: true, lockdown: { active: true, reason: "Suspected key compromise: see PD-1042.", case_ref: "PD-1042", placed_at: 1717000000000, placed_by: "u_alice" }, server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS -X POST ${host}/v1/lockdown -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"reason":"Suspected key compromise: see PD-1042.","caseRef":"PD-1042"}'`,
  },
  {
    id: "lockdown-release",
    method: "DELETE",
    path: "/v1/lockdown",
    routeFile: "app/api/v1/lockdown/route.ts",
    summary: "Lift an active break-glass lockdown. Body must include the workspace slug as confirmation. Workspace owner only.",
    scope: "lockdown:write",
    params: [
      { name: "confirm", kind: "body", required: true, type: "string", description: "Must equal the workspace slug. Guards against accidental release in a SOAR misconfiguration." },
    ],
    sampleBody: JSON.stringify({ confirm: "acme" }, null, 2),
    sampleResponse: JSON.stringify({ workspace_id: "w_abc", locked: false, lockdown: null, server_time: 1717000000000 }, null, 2),
    curl: (host, key) => `curl -sS -X DELETE ${host}/v1/lockdown -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"confirm":"acme"}'`,
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
