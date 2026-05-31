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
