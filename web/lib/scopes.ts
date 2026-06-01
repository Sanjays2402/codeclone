/**
 * Client-safe scope constants.
 *
 * Kept in its own module so the docs page and other React Server Components
 * can import scope identifiers and descriptions without pulling in the
 * node:fs / node:path machinery used by lib/api-keys.ts at runtime.
 *
 * lib/api-keys.ts mirrors this list; tests/docs.test.ts asserts the two
 * modules stay in lockstep.
 */
export const ALL_SCOPES = [
  "compare:write",
  "batch:write",
  "shares:read",
  "shares:write",
  "usage:read",
  "audit:read",
  "webhooks:read",
  "webhooks:write",
  "members:read",
  "members:write",
  "export:read",
  "erasure:write",
  "snippets:read",
  "snippets:write",
  "keys:read",
  "keys:write",
  "collections:read",
  "collections:write",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "compare:write": "Call POST /v1/compare on two snippets.",
  "batch:write": "Call POST /v1/batch for bulk pairwise comparisons.",
  "shares:read": "List and fetch saved comparison results via /v1/shares.",
  "shares:write": "Delete saved comparison results via DELETE /v1/shares/:id.",
  "usage:read": "Read this workspace's /v1 usage and plan state via GET /v1/usage.",
  "audit:read": "Stream this workspace's audit log to a SIEM via GET /v1/audit.",
  "webhooks:read": "List and fetch this workspace's webhook endpoints via GET /v1/webhooks.",
  "webhooks:write": "Create and delete webhook endpoints via POST/DELETE /v1/webhooks.",
  "members:read": "List this workspace's members and their roles via GET /v1/members for IGA reconciliation.",
  "members:write": "Invite, change role, suspend, reinstate, or remove members via POST /v1/members and PATCH/DELETE /v1/members/:user_id. Caller must be an owner of the workspace.",
  "export:read": "Download this workspace's GDPR Article 20 data portability bundle via GET /v1/export.",
  "erasure:write": "Execute GDPR Article 17 (right to erasure) bulk deletion of this workspace's saved comparisons via POST /v1/erasure.",
  "snippets:read": "List and fetch the calling user's saved snippets via GET /v1/snippets and GET /v1/snippets/:id.",
  "snippets:write": "Create, update, and delete the calling user's saved snippets via POST/PATCH/DELETE /v1/snippets.",
  "keys:read": "List this workspace's API keys via GET /v1/keys for SOC2 key inventory and rotation tracking.",
  "keys:write": "Rotate or revoke this workspace's API keys via POST /v1/keys/:id/rotate and DELETE /v1/keys/:id for automated SOC2 90-day rotation.",
  "collections:read": "List and fetch this workspace's share collections via GET /v1/collections and GET /v1/collections/:id.",
  "collections:write": "Create, update, and delete this workspace's share collections via POST/PATCH/DELETE /v1/collections.",
};
