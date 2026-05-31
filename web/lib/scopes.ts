/**
 * Client-safe scope constants.
 *
 * Kept in its own module so the docs page and other React Server Components
 * can import scope identifiers and descriptions without pulling in the
 * node:fs / node:path machinery used by lib/api-keys.ts at runtime.
 *
 * lib/api-keys.ts re-exports from here to keep a single source of truth.
 */
export const ALL_SCOPES = [
  "compare:write",
  "batch:write",
  "shares:read",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "compare:write": "Call POST /v1/compare on two snippets.",
  "batch:write": "Call POST /v1/batch for bulk pairwise comparisons.",
  "shares:read": "List and fetch saved comparison results via /v1/shares.",
};
