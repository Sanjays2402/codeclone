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
  "sessions:read",
  "sessions:write",
  "runs:read",
  "allowlist:read",
  "allowlist:write",
  "lockdown:read",
  "lockdown:write",
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
  "keys:write": "Rotate, revoke, or edit this workspace's API keys via POST /v1/keys/:id/rotate, DELETE /v1/keys/:id, and PATCH /v1/keys/:id (narrow scopes, retune rpm, tighten ipAllowlist, shift expiresAt, rename) for automated SOC2 90-day rotation and continuous least-privilege.",
  "collections:read": "List and fetch this workspace's share collections via GET /v1/collections and GET /v1/collections/:id.",
  "collections:write": "Create, update, and delete this workspace's share collections via POST/PATCH/DELETE /v1/collections.",
  "sessions:read": "List active dashboard sessions for every member of this workspace via GET /v1/sessions for SecOps incident triage and SOC2 CC6.1 access reviews.",
  "sessions:write": "Revoke individual or all dashboard sessions for a member of this workspace via DELETE /v1/sessions/:jti and POST /v1/sessions/revoke-all for credential-compromise containment.",
  "runs:read": "Read training run metadata, hyperparameters, and per-step metrics via GET /v1/runs and GET /v1/runs/:id for MLflow / Weights & Biases / SIEM ingest.",
  "allowlist:read": "Read this workspace's IP CIDR allowlist via GET /v1/allowlist for SecOps compliance evidence and SIEM reconciliation.",
  "allowlist:write": "Replace, append, or clear this workspace's IP CIDR allowlist via PUT/POST/DELETE /v1/allowlist for SOAR-driven incident response (block attacker IPs, sync VPN egress ranges). Caller's API key must belong to a workspace owner.",
  "lockdown:read": "Read this workspace's break-glass lockdown status via GET /v1/lockdown for SOAR polling and SOC2 CC7.3 incident-response evidence.",
  "lockdown:write": "Place or release this workspace's break-glass lockdown via POST/DELETE /v1/lockdown so a SIEM-fired SOAR playbook can halt all /v1 traffic during a credential-compromise incident without a human dashboard login. Caller's API key must belong to a workspace owner.",
};
