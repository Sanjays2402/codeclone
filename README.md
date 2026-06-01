# codeclone

Fine-tune a small code model on your own GitHub commit history, eval it on a mini suite, and serve it behind an OpenAI-compatible API. Ships a Next.js dashboard for browsing clone pairs, datasets, adapters, and eval runs.

![landing](docs/screenshots/landing.png)

## What it does

Walks your authored git history, extracts (prefix, completion) pairs from real commits, normalizes and dedupes them, and trains a LoRA adapter on top of a small code base model (Qwen2.5-Coder-1.5B by default). Trains via MLX on Apple Silicon or PEFT/transformers everywhere else, with a deterministic mock fallback when neither is installed so the pipeline stays testable. Adapters land in a local registry with recipe hash and metrics. Eval computes perplexity plus a mini HumanEval-style pass/fail grid. Serve exposes `/v1/chat/completions` and `/v1/completions` (streaming). The web dashboard browses pairs with a diff viewer, lists datasets and adapters, shows eval runs with charts, and streams chat against the local serve.

## Features

- Programmatic training-run feed via `GET /v1/runs` and `GET /v1/runs/{id}`, behind the new `runs:read` scope. MLOps platforms (MLflow, Weights & Biases, internal model registries) and ML supply-chain SIEM ingest need a stable, scoped, audited way to enumerate every fine-tuning run on the host and pull its hyperparameters, per-step metrics, and eval report. Until this change the dashboard's `/api/runs` route was the only programmatic surface and it is unauthenticated browser scaffolding, not something a procurement reviewer will sign off on. The list endpoint accepts `status` (queued/running/passed/failed), `limit`, and `offset`; the detail endpoint returns params, the full metrics timeline, and the eval report when present. Both endpoints run the standard `/v1` enforcement chain (lockdown, workspace + per-key IP allowlists, residency, API-key policy, DPA, per-key rate-limit **enforce** so the call is metered), write a `v1.runs.list` / `v1.runs.read` audit row, and post a billable usage event so the integration shows up in `/usage` timelines. The detail route additionally clamps the path id to a slug regex so traversal attempts (`../etc/passwd`) fail with 400 before any disk access. Pinned by `web/tests/v1-runs.test.ts` (scope registration in both `lib/api-keys` and the client-safe `lib/scopes` mirror, RBAC at the lib layer, route-source wiring of scope/rate-limit/enforcement chain/audit/usage, traversal-guard regex, and api-spec registration).

  ### Try it: stream training runs into MLflow / W&B / SIEM

  ```bash
  # 1. List recent runs (filter by status if you only want completed ones).
  curl -sS "https://codeclone.example.com/v1/runs?status=passed&limit=50" \
    -H "Authorization: Bearer $CODECLONE_API_KEY"

  # 2. Pull params + per-step metrics + eval report for one run.
  curl -sS https://codeclone.example.com/v1/runs/r_2024_05_31_a \
    -H "Authorization: Bearer $CODECLONE_API_KEY"
  ```

- Programmatic workspace dashboard session inventory and revoke via `GET /v1/sessions`, `DELETE /v1/sessions/{jti}`, and `POST /v1/sessions/revoke-all`, behind the new `sessions:read` and `sessions:write` scopes. SecOps teams running CodeClone need a machine-driven way to answer "who is currently signed into the dashboard?" during incident triage, after a phishing report, on offboarding, and on a recurring SOC2 CC6.1 access-review cadence; doing that one user at a time through the settings UI does not scale past the first audit. The list endpoint enumerates every non-expired, non-revoked dashboard session for every member of the calling key's workspace, returning jti, user_id, created_at, expires_at, last_seen_at, ip, and user_agent. The single-revoke endpoint resolves the owning user_id server-side from the jti via `findSessionOwner` (the caller never names a user_id) and the bulk-revoke endpoint validates the supplied user_id is an active member of the calling key's workspace before any revoke fires. Tenant scope is structural: the workspace is always derived from `key.workspaceId`, the set of in-scope users is the workspace roster, and any jti or user_id that belongs to a foreign workspace surfaces as 404 (not 403) so cross-tenant existence cannot be probed by watching status codes. Every revoke writes a `v1.sessions.revoke` or `v1.sessions.revoke_all` audit row with the actor key and target; every read writes `v1.sessions.read`. The full /v1 enforcement chain runs first (lockdown, workspace + per-key IP allowlists, residency, API-key policy, per-key rate limit enforce-not-peek so the route is metered in billing). Pinned by `web/tests/v1-sessions-tenant-isolation.test.ts` (live cross-tenant isolation on a shared on-disk session store, plus source-level wiring checks that fail on regression if the scope, enforcement chain, audit, or workspace-from-key derivation is dropped).

  ### Try it: force-logout a phished user from a SOAR playbook

  ```bash
  # 1. Enumerate active sessions in the workspace.
  curl -sS https://codeclone.example.com/v1/sessions \
    -H "Authorization: Bearer $CODECLONE_API_KEY"

  # 2. Revoke a single suspicious session by jti.
  curl -sS -X DELETE https://codeclone.example.com/v1/sessions/k7Q1abcDEF \
    -H "Authorization: Bearer $CODECLONE_API_KEY"

  # 3. Or kill every session for a compromised member in one call.
  curl -sS -X POST https://codeclone.example.com/v1/sessions/revoke-all \
    -H "Authorization: Bearer $CODECLONE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"user_id":"u_42"}'
  ```

- Programmatic workspace member management via `POST /v1/members` (invite), `PATCH /v1/members/{user_id}` (change role or suspend), and `DELETE /v1/members/{user_id}` (remove). Until this change, `GET /v1/members` was the read half of the IGA contract (Okta Lifecycle, SailPoint, Workday joiner/mover/leaver pipelines) but the write half required a human in the dashboard, so the joiner side of an automation pipeline could not actually land an invite or the leaver side cut access. These routes expose invite, role flip, suspend, reinstate, and remove against the same workspace store the dashboard writes to, behind the new `members:write` scope. RBAC is enforced server-side: the calling key must be bound to an active **owner** of the workspace (editor and viewer keys are denied with a stable `v1.members.{invite,update,remove}` audit row marked `status="denied"`), and a caller can never demote, suspend, or remove themselves through this endpoint so a leaver script cannot lock the workspace out by accident. Owner role transfers and sole-owner removals are blocked at the lib layer (`only_owner` invariant). Tenant scope is structural: the workspace is always derived from `key.workspaceId` (no body field can override it), targets are looked up inside that workspace's roster, and cross-tenant user ids return 404 (not 403) so foreign user ids cannot be probed. Every mutation writes the audit chain; the full `/v1` enforcement chain (lockdown, workspace + per-key IP allowlists, residency, API-key policy, per-key rate limit) runs before any side effect. Pinned by `web/tests/v1-members-write-tenant-isolation.test.ts` (live tenant partitioning at the lib layer, RBAC denial under non-owner keys, only-owner invariants, plus source-level wiring checks that fail on regression if the scope, RBAC gate, rate-limit, audit, or workspace-from-key derivation is dropped).

  ### Try it: provision a new hire from a Workday joiner webhook

  ```bash
  # Mint an owner-bound key with members:read + members:write scopes from
  # /api-keys, then invite a new editor:
  curl -sS -X POST http://localhost:3000/v1/members \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"email":"carol@acme.com","role":"editor"}' \
    | jq '.invite | {id, email, role, accept_url, expires_at}'

  # Flip a member to viewer when their team changes:
  curl -sS -X PATCH http://localhost:3000/v1/members/u_91 \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"role":"viewer"}' | jq .member

  # Workday leaver event: suspend (preserves audit trail) then remove:
  curl -sS -X PATCH http://localhost:3000/v1/members/u_91 \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"status":"suspended","reason":"Workday leaver event"}' | jq .member

  curl -sS -X DELETE http://localhost:3000/v1/members/u_91 \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq .

  # Non-owner keys get a 403 with a stable audit row; cross-tenant user
  # ids return 404 so foreign user ids cannot be probed.
  ```

- Programmatic share-collection management via `GET/POST /v1/collections` and `GET/PATCH/DELETE /v1/collections/{id}`. Until this change, share collections (the `/c/<id>` URLs that bundle a sprint's worth of `/r/<id>` shares) could only be assembled by a human clicking through the `/collections` dashboard with a session cookie. Customers wiring CodeClone into release engineering and CI wanted to mint a single "every near-duplicate we flagged this sprint" URL straight from a pipeline. These routes expose list/create over the same store the dashboard uses behind the `collections:read` and `collections:write` scopes, so a collection POSTed from CI shows up immediately under `/collections`. Tenant scope is structural: every store call passes `key.workspaceId` (rejected with `invalid_request` if the key has no workspace), `listCollections` is invoked with `allowLegacy: false` so unscoped single-tenant records are invisible, and the `[id]` route runs a `workspaceOwns` check that returns a flat 404 on cross-workspace ids so the existence of another workspace's collection id cannot be probed. Every mutation writes to the audit chain under stable `v1.collections.{list,create,update,delete}` action ids; the full `/v1` enforcement chain (lockdown, workspace + per-key IP allowlists, residency, API-key policy, DPA, per-key rate limit with `X-RateLimit-*` and `Retry-After`) runs before any side effect. Pinned by `web/tests/v1-collections-tenant-isolation.test.ts` (live per-workspace partitioning at the lib layer plus source-level wiring checks that fail on regression if the scope, workspace gate, rate-limit, audit, IP/residency, or `allowLegacy: false` calls are dropped).

  ### Try it: assemble a sprint dupes collection from CI

  ```bash
  # Mint a key with collections:read + collections:write scopes from /api-keys,
  # then create a collection seeded with the shares CI flagged this sprint:
  curl -sS -X POST http://localhost:3000/v1/collections \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"title":"sprint 42 near-duplicates","description":"flagged by CI 2026-05-30","shareIds":["abc1234567"]}' \
    | jq '.collection | {id, title, items: (.shareIds | length)}'

  # List every collection in the workspace, newest-first:
  curl -sS "http://localhost:3000/v1/collections?limit=10" \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq '.items[] | {id, title, count}'

  # Cross-workspace ids return 404, not 403, so existence never leaks:
  curl -sS -o /dev/null -w "%{http_code}\n" \
    http://localhost:3000/v1/collections/someone-elses-id \
    -H "Authorization: Bearer $CODECLONE_KEY"
  ```

- Programmatic webhook signing-secret rotation via `POST /v1/webhooks/{id}/rotate` (initiate, returns the new plaintext exactly once), `PUT /v1/webhooks/{id}/rotate` (finalize, promote the pending secret to primary), and `DELETE /v1/webhooks/{id}/rotate` (cancel a pending rotation). SOC2 CC6.1 requires evidence that shared secrets are rotated on a defined cadence; the dashboard route at `/api/webhooks/{id}/rotate` covers the human path, but until this change there was no way for a SOAR or IGA pipeline to roll a webhook secret without a cookie session, so most customers either skipped the control or hand-rolled a session-impersonation shim. All three verbs accept the same Bearer (or `x-api-key`) credential as the rest of `/v1`, behind the existing `webhooks:write` scope (no new scope to provision, no new dashboard surface to learn) and the full workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy, per-key rate limit). Tenant scope is structural: every store call goes through `rotateSecret(id, key.workspaceId)`, `finalizeRotation(id, key.workspaceId)`, and `cancelRotation(id, key.workspaceId)`, all of which refuse cross-tenant ids at the lib layer with a flat 404 so the existence of another workspace's webhook id cannot be probed; keys with no workspace binding get `tenant_required` instead of falling through. Initiate accepts an optional `graceMs` (1 minute to 30 days, default 24h) and seeds a pending secret that signs deliveries alongside the primary until finalize promotes it; receivers can roll forward with zero dropped events. The plaintext is returned exactly once and only a sha256 hash is persisted, matching create-time semantics. Every initiate, finalize, and cancel writes a `v1.webhooks.secret.rotate_initiate` / `_finalize` / `_cancel` row to the tamper-evident audit chain with the actor key id, target webhook id and label, workspace id, and a before/after diff of the secret prefixes and pending expiry, so a SOC2 reviewer can reconstruct the full rotation timeline of any endpoint from the audit log alone. Pinned by `web/tests/v1-webhooks-rotate-tenant-isolation.test.ts` (cross-tenant rotate, finalize, and cancel all denied at the lib level without mutating the target, same-tenant rotate + finalize round-trip succeeds, plus source-level wiring checks that fail on regression if the scope, workspace gate, audit rows, or rate-limit/IP/residency/lockdown enforcement are dropped).

  ### Try it: rotate a webhook secret from a SOAR runbook

  ```bash
  # Mint a key with the webhooks:write scope from /api-keys, then resolve
  # the webhook id you want to roll:
  WH_ID=$(curl -sS http://localhost:3000/v1/webhooks \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq -r '.items[0].id')

  # 1. Initiate a 1h rotation. Capture the new secret IMMEDIATELY; it is
  #    never shown again. Receivers should now accept either prefix.
  curl -sS -X POST "http://localhost:3000/v1/webhooks/$WH_ID/rotate" \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    -H 'content-type: application/json' \
    -d '{"graceMs": 3600000}'

  # 2. After your receivers are deployed with the new secret, finalize:
  curl -sS -X PUT "http://localhost:3000/v1/webhooks/$WH_ID/rotate" \
    -H "Authorization: Bearer $CODECLONE_KEY"

  # 2'. ...or roll back if anything went wrong:
  curl -sS -X DELETE "http://localhost:3000/v1/webhooks/$WH_ID/rotate" \
    -H "Authorization: Bearer $CODECLONE_KEY"
  ```

- Programmatic webhook delivery log and replay via `/v1/webhooks/{id}/deliveries` and `/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver`. Until this change, the only way to inspect a webhook's recent attempt history or re-fire a failed delivery was the cookie-authenticated `/api/webhooks` dashboard, which blocked SRE runbooks, SIEM forwarders, and incident-response automation from acting without a human session. `GET /v1/webhooks/{id}/deliveries` returns the newest-first attempt log (status, attempts, latency, error, request and response body previews) behind the `webhooks:read` scope; `POST /v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` re-fires the recorded request body against the webhook's current URL with a fresh signature behind the `webhooks:write` scope, and supports `dry_run=true` (query or body) which runs every auth/policy/quota check then returns a preview without making a network call. Tenant scope is structural: both endpoints call `loadWebhookForWorkspace(id, key.workspaceId)` and `listDeliveriesForWorkspace(id, key.workspaceId)` / `redeliverDelivery(id, deliveryId, key.workspaceId)`, all of which refuse cross-tenant access at the lib layer; cross-tenant ids return a flat 404 so the existence of another workspace's webhook id cannot be probed. Keys with no workspace binding receive `tenant_required` instead of falling through. Every real replay and every dry-run probe writes to the tamper-evident audit chain as `v1.webhooks.redeliver` or `v1.webhooks.redeliver.dry_run` with event, status, ok, and target url, so a SOC2 reviewer can pivot from any redelivery back to which key fired it. The full `/v1` enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy, rate limit) runs before the route ever touches webhook state. Pinned by `web/tests/v1-webhook-deliveries-tenant-isolation.test.ts` (cross-tenant list and redeliver denied at the lib level via a hermetic stub fetch, plus source-level wiring checks that fail on regression if the scope, workspace gate, dry-run, audit, or rate-limit/IP/residency calls are dropped).

  ### Try it: list and replay deliveries from a CI script

  ```bash
  # Mint a key with webhooks:read + webhooks:write scopes from /api-keys,
  # then resolve a webhook id you already own:
  WH_ID=$(curl -sS http://localhost:3000/v1/webhooks \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq -r '.items[0].id')

  # List the most recent 50 delivery attempts for that webhook:
  curl -sS "http://localhost:3000/v1/webhooks/$WH_ID/deliveries?limit=50" \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq '{total, items: (.items | length)}'

  # Grab the most recent failed delivery and preview a redeliver (dry-run):
  DELIV=$(curl -sS "http://localhost:3000/v1/webhooks/$WH_ID/deliveries" \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    | jq -r '.items[] | select(.ok==false) | .id' | head -1)
  curl -sS -X POST "http://localhost:3000/v1/webhooks/$WH_ID/deliveries/$DELIV/redeliver?dry_run=true" \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq

  # Then re-fire for real:
  curl -sS -X POST "http://localhost:3000/v1/webhooks/$WH_ID/deliveries/$DELIV/redeliver" \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq '.delivery | {status, ok, attempts, redeliveredFrom}'
  ```

- Programmatic SIEM-friendly webhook failure feed via `GET /v1/webhooks/failures`. Until this change, the only way to see which webhook deliveries had failed across the whole workspace was the cookie-authenticated `/api/webhooks/recent-failures` route powering the in-app toaster, which blocked Datadog, Splunk, PagerDuty, and Opsgenie pipelines from polling for failures without a human session. The new route returns the most recent failed delivery attempts (newest first, status, attempts, error, event, target url) across every webhook in the calling workspace as NDJSON by default so a SIEM forwarder can pipe the body straight into its ingestor, with `?format=json` available for ad-hoc curl and `?limit=`, `?since=` for cursoring. Auth is the same Bearer (or `x-api-key`) the rest of `/v1` accepts behind the `webhooks:read` scope. Tenant scope is structural: the aggregator is called with `workspaceId: key.workspaceId`, which delegates to `listWebhooksForWorkspace` and refuses to enumerate any other tenant's hooks at the lib layer; keys with no workspace receive `tenant_required` instead of falling through to a platform-wide feed. Every poll writes one `v1.webhooks.failures.read` audit row (so the SOC2 reviewer can pivot from any read back to which key polled it), increments the per-key rate-limit window, and logs one usage row but does not charge plan quota. The full `/v1` enforcement chain (lockdown, workspace + per-key IP allowlists, residency, API-key policy, rate limit) runs before the route ever touches webhook state. Pinned by `web/tests/v1-webhook-failures-tenant-isolation.test.ts` (live cross-tenant aggregation denied at the lib layer via a hermetic 503-stub fetch, plus source-level wiring checks that fail on regression if the scope, workspace gate, audit, NDJSON default, or rate-limit/IP/residency/lockdown calls are dropped).

  ### Try it: page recent webhook failures into PagerDuty

  ```bash
  # Mint a key with webhooks:read from /api-keys, then poll on a cron:
  curl -sS "http://localhost:3000/v1/webhooks/failures?limit=100" \
    -H "Authorization: Bearer $CODECLONE_KEY" \
    | tee -a /var/log/codeclone-webhook-failures.ndjson \
    | jq -r 'select(.status>=500) | "\(.attemptedAt) \(.label) \(.event) \(.status) attempts=\(.attempts)"'

  # Or grab the last hour as JSON for an incident-response notebook:
  SINCE=$(($(date +%s%3N) - 3600000))
  curl -sS "http://localhost:3000/v1/webhooks/failures?since=$SINCE&format=json" \
    -H "Authorization: Bearer $CODECLONE_KEY" | jq '{count, items: (.items|length)}'
  ```

- Public, unauthenticated `GET /v1/discovery` manifest that lets enterprise procurement, SecOps, and SDK generators inspect the entire `/v1` surface without credentials. Returns API version and base URL, accepted auth schemes (Bearer plus `x-api-key`), the documented rate-limit envelope (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`, 429 throttled status, default RPM, 60s window), a plain-English summary of each workspace policy (tenant isolation, audit chain, idempotency replay, IP allowlist, residency, lockdown, dry-run), the full scope catalog with descriptions and a reverse index of which endpoints each scope unlocks, and every endpoint with method, path, params, and the scope it requires. Sourced from the same `ENDPOINTS` table the `/docs` page renders, so it cannot drift from real routes. Side-effect free: no auth, no audit row, no rate-limit slot, cached for 60s, safe to share with a security questionnaire. Surfaced as a "discovery manifest" link on `/docs`. Pinned by `web/tests/v1-discovery.test.ts` (every documented endpoint and scope appears in the manifest, reverse index matches forward index, rate-limit headers match what every `/v1` route advertises, and a source-level assertion that the route does not import auth, audit, rate-limit, usage, or webhook machinery so credential-free scanners can hit it safely).

  ### Try it: pull the manifest into a procurement review

  ```bash
  curl -sS http://localhost:3000/v1/discovery | jq '{api, scopes: (.scopes | length), endpoints: (.endpoints | length)}'
  # {"api":{"name":"CodeClone","version":"v1","base_url":"http://localhost:3000",...},"scopes":15,"endpoints":17}

  # Just the scope catalog for a SecOps spreadsheet:
  curl -sS http://localhost:3000/v1/discovery | jq '.scopes[] | {id, description, endpoints}'
  ```

- Programmatic workspace API key inventory and rotation via `GET /v1/keys`, `GET /v1/keys/{id}`, `POST /v1/keys/{id}/rotate`, and `DELETE /v1/keys/{id}`. SOC2 CC6.1 and CC6.3 require evidence that API keys are inventoried and rotated on a defined cadence (commonly 90 days), and security teams want to wire CodeClone into the same SOAR / IGA pipelines they already use for cloud IAM keys instead of clicking through the `/api-keys` dashboard on every rotation. These routes expose the same key store the dashboard uses, with two new least-privilege scopes: `keys:read` for inventory and inspect, `keys:write` for rotate and revoke. Tenant scope is structural and per-workspace: every store call goes through `loadKeyForWorkspace` / `rotateKeyForWorkspace` / `revokeKeyForWorkspace` and rejects cross-tenant ids with a 404 (not 403) so the existence of another workspace's key ids cannot be inferred from status codes; keys with no `workspaceId` binding get 403 `tenant_required`. Self-target protection rejects a caller's attempt to rotate or revoke the key it is currently authenticating with, so an automation cannot brick itself mid-flight or lock the workspace out of its own bot path. Rotation returns the new plaintext exactly once, swaps the prefix and hash on disk, and the old secret stops working immediately. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any side effect, the per-key rate-limit window is enforced (not peeked), and every call writes a `v1.keys.read` / `v1.keys.inspect` / `v1.keys.rotate` / `v1.keys.revoke` row to the tamper-evident audit chain with the actor key id, target key id, label, and a before/after diff of the rotated prefix or revoked flag. Pinned by `web/tests/v1-keys-tenant-isolation.test.ts` (live per-workspace cross-tenant isolation across list / inspect / rotate / revoke proving workspace B cannot read, mutate, or even probe workspace A's keys, scope rejection for keys missing the new scopes, mirroring between `lib/scopes.ts` and `lib/api-keys.ts`, and a source-level wiring check that fails on regression if the scope filters, the rate-limit `enforce` call, the workspace enforcement chain, the `key.workspaceId` tenant scope, self-target protection, or the audit rows are dropped).

  ### Try it: rotate a workspace API key from a SOC2 rotation bot

  ```bash
  # Mint an admin key on /api-keys with keys:read + keys:write scopes,
  # then list keys past their 90-day rotation SLA:
  curl -sS http://localhost:3000/v1/keys \
    -H "Authorization: Bearer cck_<your-admin-key>"
  # {"workspace_id":"ws_acme","count":3,"items":[{"id":"a1b2c3d4e5","label":"ci-bot","prefix":"cck_ABCDEF12","createdAt":1717000000000,"scopes":["compare:write"],...}]}

  # Rotate a stale key. The new secret is returned exactly once; the
  # old secret stops working immediately. Store the secret in your
  # secrets manager before the response leaves your script.
  curl -sS -X POST http://localhost:3000/v1/keys/a1b2c3d4e5/rotate \
    -H "Authorization: Bearer cck_<your-admin-key>"
  # {"key":{"id":"a1b2c3d4e5","prefix":"cck_ZYXWVU98",...},"secret":"cck_<new-plaintext>","secret_notice":"Store this secret now. It will never be shown again. The old secret stops working immediately."}

  # Revoke a leaked key (idempotent):
  curl -sS -X DELETE http://localhost:3000/v1/keys/a1b2c3d4e5 \
    -H "Authorization: Bearer cck_<your-admin-key>"
  # {"id":"a1b2c3d4e5","revoked":true}
  ```

  A caller cannot rotate or revoke the key it is authenticating with; use a separate admin key.

 - Programmatic snippet corpus management via `GET/POST /v1/snippets` and `GET/PATCH/DELETE /v1/snippets/{id}`. Enterprise customers running CodeClone in CI, IDE plugins, and migration pipelines need to load and curate the baseline corpus (canonical implementations, internal templates, "known good" reference code) without pasting snippets through the `/snippets` dashboard one entry at a time. These routes expose the same per-user snippet store the dashboard uses, so a snippet POSTed through the API shows up immediately in `/snippets` and is usable as a baseline in `/compare`. Auth is the same Bearer token (or `x-api-key`) as the rest of `/v1`, with two new least-privilege scopes: `snippets:read` for list and fetch, `snippets:write` for create, partial update, and delete. Tenant scope is structural and per-identity: every store call passes `key.userId` into `lib/snippets`, which uses it as both the on-disk directory and a defensive `rec.userId === userId` recheck on every load, so a key minted by user A can never list, read, mutate, or delete user B's snippets; cross-tenant id guesses return 404 with no "exists but not yours" distinction. Keys with no userId binding are rejected with `invalid_request` rather than falling through to an empty corpus. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy, DPA) runs before any side effect, the per-key rate-limit window is enforced (not peeked) so corpus housekeeping cannot be used as a free heartbeat, and every call writes a `v1.snippets.list` / `v1.snippets.create` / `v1.snippets.read` / `v1.snippets.update` / `v1.snippets.delete` row to the tamper-evident audit chain with the actor user id, key prefix, snippet id, and the fields touched. Workspace plan quota is intentionally not charged: snippet management is corpus housekeeping, not a billable model call. Pinned by `web/tests/v1-snippets-tenant-isolation.test.ts` (live per-user cross-tenant isolation across read/list/update/delete, scope rejection for keys missing the new scopes, mirroring between `lib/scopes.ts` and `lib/api-keys.ts`, and a source-level wiring check that fails on regression if the scope filters, the rate-limit `enforce` call, the workspace enforcement chain, the `key.userId` tenant scope, or the audit rows are dropped).

  ### Try it: bulk-load a baseline corpus from a CI pipeline

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Mint a least-privilege key on /api-keys with snippets:read + snippets:write.

  # Create a baseline snippet from a CI job.
  curl -sS -X POST http://localhost:3000/v1/snippets \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -H "Content-Type: application/json" \
    -d '{"title":"acme baseline parser","language":"python","body":"def parse(s):\n    return s.strip()\n","tags":["baseline"],"classification":"internal"}'
  # {"snippet":{"id":"sn_2k9j1p4q","title":"acme baseline parser",...}}

  # List the corpus (filtered, paginated). Strictly scoped to this key's user.
  curl -sS "http://localhost:3000/v1/snippets?language=python&limit=10" \
    -H "Authorization: Bearer ck_live_your_key_here"
  # {"count":1,"limit":10,"offset":0,"items":[{"id":"sn_2k9j1p4q",...}]}

  # Promote a snippet's classification after review.
  curl -sS -X PATCH http://localhost:3000/v1/snippets/sn_2k9j1p4q \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -H "Content-Type: application/json" \
    -d '{"classification":"confidential","tags":["baseline","reviewed"]}'

  # Retire a snippet from the corpus.
  curl -sS -X DELETE http://localhost:3000/v1/snippets/sn_2k9j1p4q \
    -H "Authorization: Bearer ck_live_your_key_here"
  # {"ok":true,"id":"sn_2k9j1p4q"}
  ```

- Programmatic GDPR Article 17 (right to erasure) execution via `POST /v1/erasure`. `GET /v1/export` covers Article 20 (portability); this is the symmetric write path enterprise privacy teams need to fulfill data-subject erasure requests on a schedule (nightly retention sweeps, DSAR closeouts, contractual purge after customer offboarding) without poking the dashboard one row at a time. The endpoint accepts the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires the new least-privilege `erasure:write` scope, and bulk-deletes saved comparisons in the calling key's workspace via either an explicit `ids: [...]` list (for DSAR pipelines that already know which records to forget) or a `filter` object (`tag`, `language`, `created_before` epoch ms) for bulk retention sweeps. Tenant scope is structural: every load and delete passes a `{ workspaceId: key.workspaceId, allowLegacy: false }` scope hint to `loadShare`/`deleteShare`, so a key minted in workspace B can never erase workspace A's records even when the body contains workspace-A ids; foreign ids are silently skipped (no cross-tenant existence leak), not 404ed. Keys with no workspace binding receive `invalid_request`; legacy unscoped shares are never erasable via the public API. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any deletion, and the per-key rate-limit window is enforced (not peeked) because bulk delete is heavier than a single-row write. `dry_run: true` (query or body) supports a no-op preview that runs every auth/scope/rate-limit check and returns the would-be erased id list under the standard `x-codeclone-dry-run: true` header. Every live call writes a single `v1.erasure.execute` audit row carrying the actor key id, mode, requested/erased/skipped/failed counts, and the full erased id list; every dry-run writes `v1.erasure.dry_run`. The audit row is the DPO erasure receipt and is itself retained under workspace audit retention so the erased payloads are gone but the attribution survives, matching SOC 2 and GDPR guidance. Pinned by `web/tests/v1-erasure-tenant-isolation.test.ts` (cross-tenant load/delete denied at the lib level, scope rejection for keys missing `erasure:write`, mirroring between `lib/scopes.ts` and `lib/api-keys.ts`, and a source-level wiring check that fails on regression if the scope filter, the rate-limit `enforce` call, the workspace-bound scope hint, the workspace gates, the dry-run preview, or the audit rows are dropped).

  ### Try it: fulfill an Article 17 erasure request from a DSAR pipeline

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Mint a least-privilege key on /api-keys with only the erasure:write scope.

  # Preview: which saved comparisons would a bulk retention sweep delete?
  curl -sS -X POST http://localhost:3000/v1/erasure \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -H "Content-Type: application/json" \
    -d '{"filter":{"tag":"customer-acme","created_before":1717000000000},"dry_run":true}'
  # {"dry_run":true,"mode":"filter","workspace_id":"ws_acme","would":{"erase_share_ids":[...],"erase_count":12,"skipped":[]}}

  # Execute: erase a specific list of share ids from a DSAR ticket.
  curl -sS -X POST http://localhost:3000/v1/erasure \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -H "Content-Type: application/json" \
    -d '{"ids":["abc1234567","def8901234"]}'
  # {"mode":"ids","workspace_id":"ws_acme","erased":{"ids":["abc1234567","def8901234"],"count":2},"skipped":[],"failed":[],"receipt":{"action":"v1.erasure.execute",...}}
  ```

- Programmatic GDPR Article 20 portability bundle via `GET /v1/export`. Enterprise privacy and compliance teams running CodeClone need a machine-readable way to produce a full data portability artifact for a workspace on demand: DSAR fulfillment, DPA evidence packets, scheduled SOC 2 export-on-request drills, and pre-termination data egress. The dashboard already exposed `GET /api/workspaces/:id/export` to a logged-in owner via cookie; this is the same bundle, scoped to the calling API key's workspace, callable from a CI job, a privacy ops runbook, or a customer's own DSAR pipeline. `GET /v1/export` accepts the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires the new least-privilege `export:read` scope, and returns the workspace record (with `sso.clientSecret` stripped), all open invites, the metadata view of all API keys scoped to the workspace (never the hash), the full retained audit log for the workspace, and the SCIM directory mirror. Tenant scope is structural: the route always calls `getWorkspace(key.workspaceId)` and then `exportWorkspace(ws)`; no query string can redirect the bundle target, so a key minted in workspace B can never download workspace A's data even though both tenants share the same store. Keys with no workspace binding receive `invalid_request` rather than falling through to a foreign tenant. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any data is read, the per-key rate-limit window is enforced (not peeked) because portability fans out across multiple stores and must spend a slot, and every call writes a `v1.export.read` row carrying the bundle row counts (invites, apiKeys, audit, scimUsers) and the requested format so a DPO can prove the portability request was served from the audit log alone. `?format=json` (default) returns the full bundle; `?format=csv` returns just the audit log flattened to CSV, which is the most-requested artifact for DPA review packets. Pinned by `web/tests/v1-export-tenant-isolation.test.ts` (live cross-tenant isolation against `exportWorkspace`, scope rejection for keys missing `export:read`, mirroring between `lib/scopes.ts` and `lib/api-keys.ts`, and a source-level wiring check that fails on regression if the scope filter, the rate-limit `enforce` call, the tenant scope, the workspace gates, or the audit row is dropped).

  ### Try it: pull a workspace portability bundle from a DSAR pipeline

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Full JSON bundle (workspace, invites, API key metadata, audit, SCIM mirror)
  curl -sS "http://localhost:3000/v1/export?format=json" \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -o workspace-export.json

  # Audit-only CSV for a DPA review packet
  curl -sS "http://localhost:3000/v1/export?format=csv" \
    -H "Authorization: Bearer ck_live_your_key_here" \
    -o workspace-audit.csv
  ```

- Programmatic workspace roster via `GET /v1/members`. Enterprise identity teams wiring CodeClone into Okta Lifecycle, SailPoint, or Workday joiner/mover/leaver pipelines need a scoped, machine-readable pull channel for reconciliation against their source of truth. SCIM at `/scim/v2` is the push channel from the IdP; this is the pull channel. `GET /v1/members` accepts the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires the new least-privilege `members:read` scope, and returns the calling workspace's roster (user id, email, role, status, joined timestamp, plus suspension and just-in-time support grant fields). Tenant scope is structural: the route always calls `getWorkspace(key.workspaceId)`; no query string can override the workspace target, so a key minted in workspace B can never enumerate workspace A even though both tenants share the same store. Keys with no workspace binding receive `invalid_request` rather than falling through to an empty list. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any member is read, the per-key rate-limit window is enforced (not peeked) so this endpoint cannot be used as a free heartbeat, and every call writes a `v1.members.read` row (with member count and include flags) to the tamper-evident audit chain. Suspended members and just-in-time support grants are excluded by default for clean IGA payloads; `?include_suspended=true` and `?include_support=true` surface them when forensic continuity matters. Pinned by `web/tests/v1-members-tenant-isolation.test.ts` (live cross-tenant isolation, scope rejection, and a source-level wiring check that fails on regression if the scope filter, the rate-limit enforce, the tenant scope, the workspace gates, or the audit row is dropped).

  ### Try it: reconcile a workspace roster from an IGA pipeline

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Mint a least-privilege key on /api-keys with only the members:read scope.

  # Pull the active roster (default: excludes suspended and expired support grants):
  curl -sS http://localhost:3000/v1/members \
    -H "Authorization: Bearer cc_live_..."
  # {"workspace":{"id":"ws_acme",...},"count":2,"items":[{"user_id":"u_42","email":"alice@acme.com","role":"owner","status":"active",...}]}

  # Include suspended members for forensic reconciliation:
  curl -sS "http://localhost:3000/v1/members?include_suspended=true&include_support=true" \
    -H "Authorization: Bearer cc_live_..."
  ```

- Programmatic webhook provisioning via `/v1/webhooks`. Until this change, the only way to create or delete a webhook endpoint was the cookie-authenticated `/api/webhooks` dashboard surface, which blocks Terraform, internal control planes, and CI tooling from rotating receivers without a human in the loop. `GET /v1/webhooks`, `POST /v1/webhooks`, `GET /v1/webhooks/{id}`, and `DELETE /v1/webhooks/{id}` now accept the same Bearer (or `x-api-key`) credential as the rest of `/v1`, behind two least-privilege scopes (`webhooks:read`, `webhooks:write`) and the standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy, rate limit). Tenant scope is structural: list and load delegate to `listWebhooksForWorkspace` / `loadWebhookForWorkspace(id, workspaceId)`, and the destructive path calls `deleteWebhook(id, workspaceId)` which refuses on mismatch without touching disk. Cross-tenant ids return a flat 404 so the existence of another workspace's webhook id cannot be probed. Keys with no workspace binding receive `tenant_required` instead of falling through. Creation honours the workspace's webhook domain allowlist and returns the signing secret exactly once (matching the dashboard create flow). Both mutating verbs support `dry_run=true` (query or body) which runs every auth/policy/quota check then returns a preview without creating or deleting; every probe and every real action writes to the tamper-evident audit chain as `v1.webhooks.create`, `v1.webhooks.delete`, or the matching `*.dry_run` variant. Pinned by `web/tests/v1-webhooks-tenant-isolation.test.ts` (cross-tenant list/load/delete denied at the lib level, plus source-level wiring checks that fail on regression if the scope, workspace gate, or audit/rate-limit/IP/residency calls are dropped).

  ### Try it: provision a webhook from outside the dashboard

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Mint a key with webhooks:read + webhooks:write scopes from /api-keys.

  # Create an endpoint (signing secret is returned once, never again):
  curl -sS -X POST http://localhost:3000/v1/webhooks \
    -H "Authorization: Bearer cc_live_..." \
    -H "Content-Type: application/json" \
    -d '{"label":"prod-pagerduty","url":"https://example.com/hooks/codeclone","events":["compare.completed","audit.recorded"]}'
  # -> {"webhook":{...},"secret":"whsec_...","secret_notice":"Store this signing secret now..."}

  # List this workspace's webhooks (returns 404, not 403, for ids in other tenants):
  curl -sS http://localhost:3000/v1/webhooks \
    -H "Authorization: Bearer cc_live_..."

  # Dry-run a delete to validate scope + policy without removing anything:
  curl -sS -X DELETE "http://localhost:3000/v1/webhooks/wh_2a9k1p4q?dry_run=true" \
    -H "Authorization: Bearer cc_live_..."
  ```

- SIEM-friendly audit stream with `GET /v1/audit`. Enterprise security teams need to ingest CodeClone's audit log into Splunk, Datadog, Elastic, or a generic NDJSON HTTP collector on a polling cron; the dashboard `/api/audit` route is cookie-authenticated and meant for humans, so until this change there was no machine-readable way for a SIEM forwarder to pull workspace activity. `GET /v1/audit` now accepts the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires the new least-privilege `audit:read` scope, and emits the calling key's workspace entries as NDJSON by default (`format=ndjson`, one entry per line) or as a JSON object with an `items` array (`format=json`). Tenant scope is structural: the route builds an `allowedWorkspaceIds` set containing only the key's own `workspaceId` and passes it to `listAudit()`, so a key minted in workspace A can never tail workspace B's audit log even though both tenants share the same JSONL store. Keys with no workspace binding get an empty scope and see nothing; Bearer callers are explicitly not admitted to null-workspace user events (`selfActorId: undefined`). The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any entry is read, owner-configured retention is honoured so consumers can never read entries the dashboard already hides as expired, the per-key rate-limit window is *enforced* (not peeked) so this endpoint cannot be used as a free heartbeat, and every call writes a `v1.audit.read` row to the tamper-evident audit chain (audit reads are themselves auditable). Cursor pagination is exposed via the `X-Next-Until` response header (newest-first by `ts`; pass it back as `?until=` to walk backwards). Pinned by `web/tests/v1-audit-tenant-isolation.test.ts` (cross-tenant isolation via `allowedWorkspaceIds`, scope rejection for keys missing `audit:read`, and a source-level wiring check that fails on regression if the scope filter, the rate-limit `enforce` call, the tenant scope, or any of the workspace gates is dropped).

### Try it: stream this workspace's audit log into a SIEM

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Mint a least-privilege key in the API Keys page with only the
# audit:read scope (and your workspace IP allowlist, if you use one).
# Then tail the workspace audit log as NDJSON:
curl -sS "http://localhost:3000/v1/audit?limit=100" \
  -H "Authorization: Bearer cc_live_..."
# {"v":1,"id":"a1b2c3d4e5","ts":1717000000000,"actorId":"u_42","workspaceId":"ws_acme","action":"share.create",...}
# {"v":1,"id":"f6g7h8i9j0","ts":1716999940000,"actorId":"k_abc1234","workspaceId":"ws_acme","action":"v1.compare.ok",...}

# Only surface policy denials (e.g. for a Splunk rule on IP-allowlist drops):
curl -sS "http://localhost:3000/v1/audit?status=denied&action=v1." \
  -H "Authorization: Bearer cc_live_..."

# Page backwards using the X-Next-Until header from the previous response:
curl -sS -D - "http://localhost:3000/v1/audit?limit=100&until=1716999940000" \
  -H "Authorization: Bearer cc_live_..."
```

- Tenant-scoped share history closes a cross-workspace read/write leak. Saved comparisons (`/r/[id]`, `/api/share`, `/api/share/export`, `/v1/shares`) previously loaded any record by id regardless of which workspace the caller belonged to, so a signed-in user or API key in workspace B could list, read, patch, delete, and export workspace A's saved diffs. Records now carry a `workspaceId` stamped at creation time (schema v3, legacy v1/v2 records load as unscoped and remain readable through the public `/r/[id]` link only). Every mutating dashboard route and the entire `/v1/shares` surface now resolves the caller's workspace and passes a `ScopeHint` into `loadShare`/`updateShare`/`deleteShare`/`listSharesPage`/`exportShares`; cross-tenant ids return 404 instead of leaking the title or score, and tenant-local facet counts (languages, clone labels) no longer reveal the cardinality of other tenants' history. Pinned by `web/tests/share-tenant-isolation.test.ts` (cross-tenant read, patch, delete, list, and export all denied; legacy back-compat preserved).

  ```bash
  pnpm dev   # web dashboard on http://localhost:3000

  # Save a comparison in workspace A:
  curl -sS -X POST http://localhost:3000/api/share \
    -H "Content-Type: application/json" \
    -b cookie-ws-a.txt \
    -d '{"a":"function f(){return 1}","b":"function f(){return 2}","language":"javascript","title":"alpha-only"}'
  # -> {"id":"abc123def456","url":"/r/abc123def456"}

  # A user in workspace B is refused even though they know the id:
  curl -sS -i -X PATCH http://localhost:3000/api/share/abc123def456 \
    -H "Content-Type: application/json" \
    -b cookie-ws-b.txt \
    -d '{"title":"pwned"}'
  # HTTP/1.1 404 Not Found
  # {"error":"Share not found."}
  ```

- Programmatic FinOps with `GET /v1/usage`. Enterprise customers running codeclone through chargeback / FinOps systems need a stable, machine-readable view of their own /v1 usage that can be called from a finance pipeline, not just from a browser session. The existing dashboard route `/api/usage` is cookie-authenticated, so it can only be hit by a human; until this change there was no way for a customer service account to fetch its workspace's call volumes, plan state, or per-endpoint roll-ups without scraping HTML. `GET /v1/usage` now accepts the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires the new least-privilege `usage:read` scope, and returns the calling key's workspace usage summary (`by_day`, `by_key`, `by_endpoint`), the current month-to-date count and remaining plan quota, and optionally the most recent N events for incident triage (`?recent=50`, capped at 200). Tenant scope is structural: the route builds a `WorkspaceScope` containing only the key's own `workspaceId` and hands it to `summarize()` / `recentEvents()`, so a key minted in workspace A can never see workspace B's `keyId`s or call volumes even when both tenants share the same node's usage store. A key with no workspace binding gets an empty scope and sees nothing. The standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy) runs before any data is read, the per-key rate-limit window is *enforced* (not peeked) so this endpoint cannot be used as a free heartbeat, and every call writes a `v1.usage.read` row to the tamper-evident audit chain with the calling key's prefix, the window queried, and the total calls returned. Pinned by `web/tests/v1-usage.test.ts` (cross-tenant isolation via `WorkspaceScope`, scope rejection for keys missing `usage:read`, and a source-level wiring check that fails on regression if the scope filter, the rate-limit `enforce` call, or any of the workspace gates is dropped).

### Try it: pull your own usage from CI without a browser session

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Create a key on /api-keys with the new "usage" scope checked, then:
curl -sS "http://localhost:3000/api/v1/usage?days=7&recent=20" \
  -H "Authorization: Bearer $CODECLONE_KEY" -i

# Response includes X-RateLimit-* and x-codeclone-plan-* headers and:
# {
#   "workspace":     { "id": "ws_...", "name": "acme-prod", "plan": "pro" },
#   "window_days":   7,
#   "total_calls":   1284,
#   "month_to_date": 4127,
#   "plan":          { "id": "pro", "monthly_limit": 50000,
#                      "month_to_date": 4127, "remaining": 45873 },
#   "by_day":        [ { "date": "2026-05-25", "count": 142 }, ... ],
#   "by_endpoint":   [ { "endpoint": "/v1/compare", "count": 1108,
#                        "avg_latency_ms": 41.7, "total_bytes": 8421033 }, ... ],
#   "recent":        [ { "ts": 1717000000000, "key_id": "...",
#                        "endpoint": "/v1/compare",
#                        "latency_ms": 38, "bytes": 7421 }, ... ]
# }

# A key missing the usage:read scope is refused:
#   HTTP/1.1 403 Forbidden
#   { "error": { "type": "forbidden",
#                "message": "This key is missing the 'usage:read' scope.",
#                "required_scope": "usage:read" } }
```

- Tenant-scoped usage dashboard. Until this change, `GET /api/usage` and `/api/usage/recent` were unauthenticated and folded every key's usage rows in `$CODECLONE_KEYS_DIR/usage/*.jsonl` into a single global view, leaking another tenant's `keyId`s, endpoints, latencies, and byte totals to anyone who hit the URL. The routes now require a signed-in session, resolve the caller's active workspace memberships (`listWorkspacesForUser` honouring suspended + expired support grants), and pass that allowlist as a `WorkspaceScope` into `summarize()` and `recentEvents()` so the aggregation engine drops any row whose `workspaceId` is not in the caller's set. Legacy unscoped rows (older keys with no `workspaceId`) are excluded from any scoped view rather than silently attributed. The dashboard at `/usage` adds a workspace picker so customers can either see totals across every workspace they belong to or scope to one, and the route writes `usage.read` / `usage.read.denied` rows to the tamper-evident audit chain so security teams can see exactly who looked at whose usage. Pinned by `web/tests/usage-tenant-isolation.test.ts`.

### Try it: confirm one tenant cannot see another tenant's usage rows

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Anonymous callers are refused with a structured error:
curl -sS http://localhost:3000/api/usage | jq
# { "error": { "type": "unauthorized", "message": "sign in required" } }

# Sign in, then scope to a workspace you do not belong to:
curl -sS -b cookies.txt "http://localhost:3000/api/usage?workspaceId=ws_someoneElses" -i
# HTTP/1.1 403 Forbidden
# { "error": { "type": "forbidden", "message": "not a member of that workspace" } }
# (also writes a usage.read.denied audit row visible at /audit)

# Without a workspaceId, totals are auto-scoped to every workspace you belong to:
curl -sS -b cookies.txt http://localhost:3000/api/usage | jq '.scope.workspaceIds, .totalCalls'
```

- Read-only key introspection at `GET /v1/whoami`. Customers running codeclone in CI need a cheap way to confirm a Bearer token is the one they think it is, see which scopes it carries, and check how close they are to their per-minute and monthly limits, without burning a rate-limit slot or a billable usage event. The endpoint is authenticated by the same Bearer token (or `x-api-key`) as the rest of `/v1`, requires no scope (any valid key may introspect itself, mirroring OIDC `/userinfo`), and runs the standard workspace enforcement chain (lockdown, workspace IP allowlist, per-key IP allowlist, residency, API-key policy). The rate-limit window is *peeked*, not incremented, so a CI health check can run every minute without touching the customer budget. Every call writes a `v1.whoami.read` row to the tamper-evident audit chain and refreshes `recordUse` so leaked-key triage stays accurate. The response is derived strictly from the authenticated key record so the endpoint cannot be coaxed into echoing another tenant's metadata. Pinned by `web/tests/v1-whoami.test.ts` (cross-tenant lookup isolation, revoked + expired rejection, peek() never consumes a slot, route wires the full enforcement chain and never calls `logUsage`).

### Try it: introspect a key without burning a slot

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Create a key on /api-keys, then:
curl -sS http://localhost:3000/api/v1/whoami \
  -H "Authorization: Bearer $CODECLONE_KEY" -i

# Response includes X-RateLimit-* headers and:
# {
#   "key":        { "id": "...", "label": "...", "prefix": "cc_live_...",
#                   "scopes": ["compare:write"], "revoked": false,
#                   "workspace_id": null, "ip_allowlist_count": 0, ... },
#   "workspace":  null,
#   "rate_limit": { "limit": 60, "remaining": 60, "reset_at": 1735689600, "window_seconds": 60 },
#   "plan":       null,
#   "request_ip": "203.0.113.7",
#   "server_time": 1735689553000
# }
```

- Public `DELETE /v1/shares/:id` with dry-run preview. The public API can now permanently remove a saved comparison record under a new `shares:write` scope, separate from `shares:read`, so a key that lists shares cannot also destroy them. Every call (live or preview) runs the full auth, IP allowlist, residency, lockdown, API-key-policy, and per-key rate-limit chain that the other `/v1` routes run, and writes a `v1.shares.delete` (or `v1.shares.delete.dry_run`) entry to the tamper-evident audit chain with the API key id, actor id, source IP, share id, language, and original creation timestamp. Passing `?dry_run=true` (or `{ "dry_run": true }` in a JSON body) returns the same shape a live delete would return, including the `x-codeclone-dry-run: true` header and the same `X-RateLimit-*` budget headers, but never touches storage and never bumps usage. Customers can wire deletion into CI pipelines and confirm contract shape end to end without burning real records. The `/api-keys` issuer surfaces the new scope as a separate checkbox so an owner can grant read-only or write-only access deliberately. Pinned by `web/tests/v1-shares.test.ts` (`shares:write is a registered scope`, `DELETE requires shares:write scope (RBAC)`, `dry_run preview leaves the share intact`).

### Try it: dry-run a share deletion without losing the record

```bash
# Create a key with the new scope on /api-keys, then preview a delete:
curl -sS -X DELETE "http://localhost:3000/v1/shares/$ID?dry_run=true" \
  -H "Authorization: Bearer $CODECLONE_KEY" -i
# Response includes:  x-codeclone-dry-run: true
# Body: { "dry_run": true, "would": { "delete_share": true, ... }, "share": { ... } }
# The share is still fetchable at GET /v1/shares/$ID. Re-run without ?dry_run=true to actually delete.
```

- Periodic access reviews. Every workspace owner can open a SOC 2 CC6.3 / ISO 27001 A.9.2.5 attestation cycle: `POST /api/workspaces/<id>/access-reviews` snapshots the current active membership (support grants excluded because they already auto-expire) into a sealed review record, `POST .../decisions` records keep or revoke per member with an optional 280-char note, and `POST .../complete` seals the review and suspends only the members marked revoke through the existing `suspendMember` machinery (so session revocation, key disablement, and audit chain entries flow exactly as they would from the members route). Only one review per workspace may be in-flight to keep the audit narrative unambiguous, complete refuses while any decision is still pending, and the sole-owner safety check still applies (a revoke that would leave the workspace owner-less throws `only_owner`, leaves the owner active, and keeps the review open so the actor can retract). Reviews live in a per-workspace directory (`$CODECLONE_WORKSPACES_DIR/_access_reviews/<workspaceId>/<reviewId>.json`) and `getReview` reads only from that directory, so a `reviewId` leaked from workspace A cannot be loaded or mutated through workspace B's routes even if a caller forgets the membership gate; every workspace route also runs through `enforceWorkspaceAllowlistForSession`, owner-gates the writes, and emits `workspace.access_review_open|decide|complete|cancel` audit entries (with explicit `denied` rows for owner-required refusals) so the workspace produces a defensible "who reviewed access, when, and what they decided" artifact for a procurement packet. The workspace page surfaces an Access reviews card with an open / decide / complete flow and a history of sealed reviews. Four regression tests in `web/tests/access-reviews.test.ts` cover the full lifecycle (snapshot, decide, complete suspends only revoked, second open conflicts), pending-guard on complete, sole-owner safety (review stays open, owner stays active), and cross-tenant isolation (workspace B sees zero reviews from A, `getReview(b, aReviewId)` returns null, and `decide` against the wrong workspace cannot mutate A's record).

### Try it: complete a quarterly access review and watch the revoked member get suspended

```bash
pnpm dev   # web dashboard on http://localhost:3000
# As workspace owner:
curl -s -b cc_session=... -H 'content-type: application/json' \
  -X POST http://localhost:3000/api/workspaces/<ws_id>/access-reviews \
  -d '{"title":"Q1 access review"}'
# Mark decisions (keep/revoke per userId):
curl -s -b cc_session=... -H 'content-type: application/json' \
  -X POST http://localhost:3000/api/workspaces/<ws_id>/access-reviews/<rv_id>/decisions \
  -d '{"decisions":[{"userId":"u_owner...","decision":"keep"},{"userId":"u_offboarded...","decision":"revoke","note":"left the company"}]}'
# Seal and apply revokes:
curl -s -b cc_session=... -X POST http://localhost:3000/api/workspaces/<ws_id>/access-reviews/<rv_id>/complete
# The revoked member is now suspended; the sealed review remains visible as an audit artifact.
```

- Recent source IPs per API key. Every successful call through `/v1/compare`, `/v1/batch`, `/v1/shares`, and `/v1/shares/[id]` now records the caller's source IP against the key in a bounded ring buffer (most-recent five distinct IPs, each with first-seen, last-seen, and call count). The `/api-keys` settings page exposes a per-key disclosure that lists the IPs the key has been used from, so an owner who suspects a leak can immediately see whether the key is being exercised from an unexpected network without having to scrape the audit log. Storage is capped per key (no unbounded growth), the buffer is updated alongside the existing `usageCount` and `lastUsedAt` fields, and the new data is only ever returned to the key's owner via the existing GET `/api/api-keys/:id` route, which already does owner scoping. Pinned by `web/tests/api-keys.test.ts` ("recordUse tracks recent source IPs as a bounded ring buffer"): same-IP coalescing, distinct-IP fan-out, empty/null IP no-op, ring eviction at the cap, and summarize ordering newest-first. Maps to the standard SOC 2 CC7.2 / ISO 27001 A.9.4.2 procurement ask: "customer must be able to detect anomalous credential use."

### Try it: see which IPs a key has been used from

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Call /v1/compare a few times from your machine using a real key:
curl -s -X POST http://localhost:3000/api/v1/compare \
  -H "Authorization: Bearer $CC_KEY" -H 'content-type: application/json' \
  -d '{"a":"def f():\n  return 1\n","b":"def g():\n  return 1\n","language":"python"}'

# Then read the key's detail record (owner-scoped):
curl -s http://localhost:3000/api/api-keys/$KEY_ID -b "$COOKIE" \
  | jq '.recentIps'
# [
#   { "ip": "203.0.113.10", "firstSeenAt": ..., "lastSeenAt": ..., "count": 3 }
# ]
```

Open `/api-keys` and click **recent source ips** under any key row to see the same list in the UI.

- Snippet data classification with a workspace share ceiling. Every saved snippet now carries a standard four-level sensitivity tag (public, internal, confidential, restricted) and defaults to internal. The workspace owner sets the most permissive label that members may turn into an outbound share at `/workspaces/<id>`; the default ceiling is internal so confidential and restricted snippets are blocked until policy is loosened. The decision is centralised in `web/lib/snippets-policy.ts` and consumed by both the snippets UI (a share-check button surfaces allowed/blocked plus the reason) and the `GET /api/snippets/:id/share-policy` endpoint that future PDF or share paths must call. Owner mutations write `workspace.snippet_share_policy_update` to the tamper-evident audit log with a before/after diff; snippet create and update audit rows now include the classification too. Cross-tenant: a user belonging to multiple workspaces gets the most permissive ceiling among them, and a restricted snippet is still blocked when no workspace allows it, proved in `web/tests/snippet-classification.test.ts`. Maps to the standard SOC 2 CC6.7 / ISO 27001 A.5.12 / NIST 800-53 MP-3 procurement ask: "every stored artifact must carry a classification label and egress must be gated against that label."

### Try it: tag a snippet and check the workspace share ceiling

```bash
# Create a snippet labelled "restricted":
curl -s -X POST http://localhost:3000/api/snippets \
  -H 'content-type: application/json' \
  -H "cookie: $COOKIE" \
  -d '{"title":"prod key sample","language":"python","body":"AWS=\"...\"","classification":"restricted"}' | jq

# Ask the policy whether it can leave the workspace as a share:
curl -s http://localhost:3000/api/snippets/$ID/share-policy -H "cookie: $COOKIE" | jq
# => { "allowed": false, "classification": "restricted", "ceiling": "internal",
#      "reason": "Workspace policy blocks sharing of restricted snippets..." }

# Owner relaxes the ceiling for ws_acme:
curl -s -X PUT http://localhost:3000/api/workspaces/$WS_ID/snippet-share-policy \
  -H 'content-type: application/json' \
  -H "cookie: $COOKIE" \
  -d '{"level":"restricted"}' | jq
```

- Enforce SSO at sign-in. A workspace owner who flips `sso.enforced = true` now blocks magic-link sign-in two ways: at issue time (the existing domain-claim check) and, critically, at consume time. The verify route re-evaluates membership before minting a session, so a contractor invited from a non-corporate address (`contractor@gmail.com` joined to an SSO-enforced `globex.io` workspace) cannot bypass SSO by requesting a link from a personal inbox, and a magic link that was already on its way when an admin tightened policy is refused on click with a 303 back to `/signin?error=sso_required` plus the workspace-specific IdP start URL. The dashboard surfaces the redirect as a one-click `Continue with single sign-on` button so the user is funneled into the configured OIDC provider with no support ticket. Every block writes `auth.magic_link_blocked_sso` to the tamper-evident audit log with actor, workspace, IP, and `stage: "verify"` so a SOC 2 reviewer can prove no out-of-band auth path existed even during the race window. Cross-tenant isolation is structural: an unrelated user with no membership and no domain match is never funneled into another tenant's SSO, proved in `web/tests/sso.test.ts`. Maps to the standard procurement ask: "customer must be able to force every user, including contractors and existing members, through the corporate IdP with no fallback."

### Try it: block a magic-link bypass on an SSO-enforced workspace

```bash
# Owner has already enabled OIDC + enforcement on workspace ws_globex.
# A contractor on gmail tries to request a magic link:
curl -s -X POST http://localhost:3000/api/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"contractor@gmail.com"}' | jq
# => { "error": { "type": "sso_required", ... }, "ssoStartUrl": "http://localhost:3000/api/auth/sso/ws_globex/start", "workspaceName": "Globex" }

# Even if a link was minted before enforcement was toggled on, hitting
# /api/auth/verify?token=... now 303-redirects to:
#   /signin?error=sso_required&workspace=Globex&sso_start=/api/auth/sso/ws_globex/start
# and writes an audit row: action=auth.magic_link_blocked_sso, stage=verify.
```

- Workspace break-glass lockdown. When an owner suspects an API key compromise, sees a spike in /v1 traffic they can't explain, or has to halt programmatic access while incident response runs, they open `/workspaces/<id>`, type a reason, complete an MFA step-up, and click Engage lockdown. Every subsequent `/v1/compare`, `/v1/batch`, `/v1/shares`, and `/v1/shares/[id]` call presenting a key bound to that workspace is refused with HTTP 423 `workspace_locked`, a `Retry-After: 3600` hint, and a structured body that names the placement timestamp and case reference so the customer's automation can surface the incident to operators instead of silently retrying. Dashboard sessions keep working so the owner can rotate keys, review the audit log, and lift the lockdown without locking themselves out; lifting requires typing the workspace slug as confirmation plus a fresh MFA step-up, mirroring the legal-hold pattern. Every place, lift, and individual /v1 block writes to the tamper-evident audit chain (`workspace.lockdown_place`, `workspace.lockdown_release`, `workspace.lockdown_block`) with actor, IP, target key id, and route so a SOC2 reviewer can reconstruct exactly which keys hit the gate and when. Cross-tenant isolation is structural: a lockdown on workspace A never affects /v1 calls bound to workspace B even when both keys live on the same node, proven in `web/tests/workspaces-lockdown.test.ts`. Legacy keys with no workspace binding are exempt so single-tenant installs that never adopted workspaces keep working. Endpoints: `GET/POST/DELETE /api/workspaces/:id/lockdown`. Maps to the standard SOC 2 CC7.3 / ISO 27001 A.5.26 / NIST 800-53 IR-4 procurement ask: "the customer must be able to halt programmatic access immediately during a security incident."

- Workspace Data Processing Agreement (DPA) acceptance gate. Enterprise procurement and security reviews block onboarding until the vendor can produce a defensible record that an authorized representative accepted the DPA / Terms before any production data flowed through the platform (SOC 2 CC1.1, ISO 27001 A.5.20, most vendor questionnaires). codeclone now requires every workspace owner to accept the current version (`DPA_CURRENT_VERSION` in `web/lib/dpa.ts`) before `/v1/compare` and `/v1/batch` will process snippets. The acceptance record pins the version string, the signatory's user id and email, the server-stamped timestamp, and the source IP. Bumping the version invalidates every older acceptance and forces a fresh re-accept on the next dashboard visit and the next `/v1` call. Owners review and toggle acceptance under the workspace settings DPA panel; the endpoint is `GET/POST/DELETE /api/workspaces/:id/dpa` with owner-only writes, MFA step-up when the workspace MFA policy is on, and the version explicitly echoed in the POST body so a stale tab cannot silently accept a newer revision. Every accept, re-accept, and withdrawal lands in the tamper-evident audit log; every `/v1` rejection records `workspace.dpa_block` with the route, the current version, and the pinned version so a security team can pivot from the audit log to the offending key. Cross-tenant isolation: an acceptance recorded on workspace A never satisfies workspace B's gate, proved in `web/tests/workspaces-dpa.test.ts`.

### Try it: accept the DPA and unblock /v1 calls

```bash
# Check the gate status (any active member):
curl -s http://localhost:3000/api/workspaces/$WS_ID/dpa -H "cookie: $COOKIE"
# => { "status": { "currentVersion": "2025-01-01", "accepted": false, "required": true, ... }, "canEdit": true }

# Without acceptance, /v1/compare refuses with 403 dpa_required:
curl -s -X POST http://localhost:3000/v1/compare \
  -H "authorization: Bearer $CC_KEY" -H "content-type: application/json" \
  -d '{"a":"x=1","b":"x=2"}'
# => { "error": { "type": "dpa_required", "current_version": "2025-01-01", ... } }

# Owner accepts (must echo the current version explicitly):
curl -s -X POST http://localhost:3000/api/workspaces/$WS_ID/dpa \
  -H "cookie: $OWNER_COOKIE" -H "content-type: application/json" \
  -d '{"version":"2025-01-01"}'
# => { "status": { "accepted": true, "acceptance": { "acceptedByEmail": "owner@example.com", ... } } }

# /v1/compare now succeeds normally.
```

- Dual-control approvals (separation of duties / four-eyes) for the most destructive workspace actions. Enterprise procurement teams refuse to sign without this: a single compromised owner credential should not be enough to hand the workspace to an attacker or wipe it. Workspace owners opt in per operation under Settings -> Dual-control approvals; today the gated operations are `workspace.wipe` and `workspace.transfer_ownership`. When the policy is on, the destructive endpoint refuses the call with HTTP 403 `approval_required` unless the body carries a fresh `approval_token` minted by a *different* owner. Tokens are single-use, expire in 30 minutes, are bound by SHA-256 hash to the exact request payload (an approval for "transfer to Alice" cannot be replayed to transfer to Eve), are constant-time compared, and are stored only as their hash so a leak of the approvals.json cannot mint authority. Every state transition (request, approve, cancel, consume, denied) writes to the tamper-evident audit chain. Approvals live under `$CODECLONE_APPROVALS_DIR` (defaults to `$CODECLONE_WORKSPACES_DIR/_approvals/<workspaceId>/`) so cross-tenant queries are not representable at the storage layer. Maps to SOC 2 CC6.3, ISO 27001 A.5.3, NIST 800-53 AC-5. Regression coverage in `web/tests/workspaces-dual-control.test.ts` proves cross-tenant isolation (a token approved in workspace A cannot be consumed in workspace B even when slugs collide), self-approval rejection, payload binding, single-use semantics, and cancel-invalidates-approved-token.

### Try it: require a second owner to approve a workspace wipe

```bash
# 1. As an owner, turn on dual control for wipe (Settings page or:)
curl -s -X PUT http://localhost:3000/api/workspaces/$WS_ID/dual-control \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d '{"operations":["workspace.wipe"]}'

# 2. Open a request (audited as workspace.approval_requested):
curl -s -X POST http://localhost:3000/api/workspaces/$WS_ID/approvals \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d '{"operation":"workspace.wipe","reason":"Decommissioning per SEC-204"}'

# 3. A *different* owner approves (returns the one-time token):
curl -s -X POST http://localhost:3000/api/workspaces/$WS_ID/approvals/$APR_ID/approve \
  -H "cookie: $OTHER_OWNER_COOKIE"
# => { "approval": { ... }, "token": "...one-shot token..." }

# 4. The wipe call now succeeds; without the token it returns 403 approval_required:
curl -s -X POST http://localhost:3000/api/workspaces/$WS_ID/wipe \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d "{\"confirm\":\"$WS_SLUG\",\"approval_token\":\"$TOKEN\"}"
```

- Stripe-style Idempotency-Key on `/v1/compare` and `/v1/batch`. Customers retry POSTs on network blips, proxy 502s, and client timeouts; without an idempotency contract those retries double-charge plan quota and fire webhook subscribers twice. Pass `Idempotency-Key: <client-string>` on a write and codeclone records a per-API-key slot with a SHA-256 fingerprint of the canonical request body. A duplicate request with the same key replays the original status code and JSON body (and sets `Idempotent-Replayed: true`) without re-running similarity, without bumping `lastUsedAt`, without charging plan quota, and without fanning out a second webhook. A reuse with a different body returns HTTP 409 `idempotency_conflict` and writes a `v1.compare.idempotency_conflict` (or `v1.batch.idempotency_conflict`) audit row so operators can pivot from the audit log to the offending client. A duplicate that arrives while the first is still inflight returns HTTP 409 `idempotency_in_progress` with `Retry-After: 2`. Slots are scoped per API key (two keys cannot collide on the same idempotency value), expire after 24 hours, and live on the filesystem under `$CODECLONE_IDEMPOTENCY_DIR` (defaults to `runs/_idempotency`). Dry-run probes deliberately do NOT consume an idempotency slot, so wiring `?dry_run=true` in CI cannot lock out a later real call. 22 regression tests in `web/tests/idempotency.test.ts` cover header parsing (length and printable-ASCII bounds), body-hash stability across object key order, fresh/replay/conflict_body/conflict_inflight outcomes, per-key isolation, replay header echo, and source-level wiring on both `/v1/compare` and `/v1/batch` including the dry-run ordering invariant.

### Try it: retry a compare on flaky wifi without double-charging

```bash
KEY=$(cat api-keys/keys.json | jq -r '.[0].plaintext // empty')
curl -s -X POST http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-2026-05-31-abc123" \
  -d '{"a":"def add(x,y):return x+y","b":"def add(a,b):return a+b"}' -i | head -20

# Now replay the same request. Body is byte-identical, so codeclone
# returns the stored response with Idempotent-Replayed: true and does
# NOT charge plan quota again.
curl -s -X POST http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-2026-05-31-abc123" \
  -d '{"a":"def add(x,y):return x+y","b":"def add(a,b):return a+b"}' -i | grep -i 'idempotent\|HTTP'

# Reuse the same key with a different body and codeclone refuses with
# 409 idempotency_conflict, then writes an audit row.
curl -s -X POST http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-2026-05-31-abc123" \
  -d '{"a":"different","b":"payload"}' -i | head -5
```

- Workspace invite-domain allowlist. Owners can restrict which email domains may join a workspace, enforced on every member entry path: manual invite issuance (`POST /api/workspaces/:id/invites` returns 403 `invite_domain_not_allowed`), invite acceptance (a token issued before the policy tightened can no longer be redeemed if the recipient is now off-list), domain auto-join (an SSO sign-in whose email matches `autoJoinDomains` but not the stricter allowlist is skipped), and SCIM 2.0 user provisioning (`POST /scim/v2/<wsId>/Users` with an off-policy `userName` returns SCIM 400 `invalidValue`). Existing members are never evicted by a policy change. Managed via `GET/PUT /api/workspaces/:id/invite-domain-allowlist`; every mutation lands in the audit log as `workspace.invite_domain_allowlist_update` with a before/after diff and every denied invite as `workspace.invite_create` with status `denied`. The workspace settings page surfaces a dedicated editor; non-owners see it read-only. Seven regression tests in `web/tests/workspaces-invite-domain-allowlist.test.ts` cover sanitiser normalisation, all four enforcement paths, the existing-member carve-out, and cross-tenant isolation (a policy on workspace A never constrains workspace B). Closes the standard SOC2 / ISO 27001 procurement ask: "the customer must be able to restrict access to corporate identity domains only."

### Try it: lock a workspace to your corporate email domain

```bash
# Owner sets the allowlist.
curl -i -b cc_session=... -H 'content-type: application/json' \
  -X PUT 'http://localhost:3000/api/workspaces/<ws_id>/invite-domain-allowlist' \
  -d '{"domains":["acme.com"]}'
# {"domains":["acme.com"],"rejected":[]}

# A manual invite to an off-policy address is refused with 403.
curl -i -b cc_session=... -H 'content-type: application/json' \
  -X POST 'http://localhost:3000/api/workspaces/<ws_id>/invites' \
  -d '{"email":"intruder@evil.com","role":"viewer"}'
# HTTP/1.1 403 Forbidden
# {"error":"invite_domain_not_allowed","message":"This workspace restricts member email domains. The invitee's domain is not on the allowlist."}

# An on-policy invite issues normally.
curl -i -b cc_session=... -H 'content-type: application/json' \
  -X POST 'http://localhost:3000/api/workspaces/<ws_id>/invites' \
  -d '{"email":"alice@acme.com","role":"viewer"}'
# HTTP/1.1 201 Created
```

The denied attempt is preserved in the audit log as `workspace.invite_create` with status `denied` and reason `invite_domain_not_allowed`. Pass an empty `domains` array to disable enforcement.

- Per-workspace request payload size policy on /v1. Owners can now cap the maximum request body in bytes for any /v1 call made with an API key bound to their workspace. The policy lives on the workspace record as `payloadPolicy.maxBodyBytes` (bounds: 1 KiB to 10 MiB, 0 clears) and is enforced twice in `web/lib/payload-policy-enforce.ts` on every /v1 request: pre-parse via the inbound `Content-Length` header so the server never has to hold an over-limit body in memory, and post-parse against the serialized JSON payload as defence in depth for chunked requests where `Content-Length` is missing or understated. Over-limit requests return HTTP 413 with a structured `payload_too_large` error that echoes `limit_bytes` and `claimed_bytes` so SDKs can surface a precise message, and every rejection writes a `v1.payload_blocked` audit entry tagged with the route (`/v1/compare` or `/v1/batch`), claimed bytes, configured limit, and detection source. Wired into `/v1/compare` and `/v1/batch`; `/v1/shares` is read-only. Owner-only `GET/PUT/DELETE /api/workspaces/:id/payload-policy` writes `workspace.payload_policy_update` audit entries with a before/after diff. The workspace settings page surfaces a dedicated editor with live KiB/MiB formatting; non-owners see it disabled. Five regression tests in `web/tests/workspaces-payload-policy.test.ts` cover the sanitiser bounds and 0-clears, persistence round-trip, cross-tenant isolation (a workspace A 2 KiB cap rejects payloads that workspace B's 1 MiB cap accepts, and clearing B does not loosen A), and the under/over body-size decision used by the enforcer.

### Try it: cap /v1 request bodies at 8 KiB for a workspace

```bash
# Owner sets a 8 KiB cap on the workspace.
curl -i -b cc_session=... -H 'content-type: application/json' \
  -X PUT 'http://localhost:3000/api/workspaces/<ws_id>/payload-policy' \
  -d '{"maxBodyBytes":8192}'

# Caller sends a 50 KiB compare body with a key bound to that workspace.
# Pre-parse Content-Length check fires; the server never reads the body.
BIG=$(python3 -c 'print("x"*50000)')
curl -i -H "authorization: Bearer cc_live_..." -H 'content-type: application/json' \
  -X POST http://localhost:3000/v1/compare \
  -d "{\"a\":\"$BIG\",\"b\":\"$BIG\"}"
# HTTP/1.1 413 Payload Too Large
# {"error":{"type":"payload_too_large","limit_bytes":8192,"claimed_bytes":...}}
```

The rejection lands in the audit log as `v1.payload_blocked` with the route, claimed bytes, and configured limit. `DELETE /api/workspaces/<ws_id>/payload-policy` clears the cap.

- Secret-scan DLP policy on every snippet. Workspace owners can now require codeclone to scan every code snippet submitted to compare and batch for hardcoded credentials (AWS keys, GitHub PATs, Stripe keys, JWTs, PEM private keys, Slack/SendGrid/Twilio tokens, npm tokens, and more) before any similarity work runs. The policy lives on the workspace record as `secretScanPolicy` with four modes: `off` (default, zero added latency), `warn` (return findings on the response without altering behaviour), `redact` (replace each match with `[REDACTED:<rule>]` so similarity is scored against the post-redaction text), and `block` (reject the request with HTTP 422 `secrets_detected` and never persist the snippet, fire webhooks, or charge quota). Enforcement is centralised in `web/lib/secret-scan-enforce.ts` and wired into every customer-facing snippet route: `/api/compare`, `/v1/compare`, and `/v1/batch`; the dashboard `/api/compare` path uses the strictest policy across the signed-in user's workspaces so a member of a `block` workspace can't bypass it by running compare without selecting that workspace. Pattern rules are vendor-prefix anchored (AKIA, ghp_, sk-ant-, AIza, xox[abprs]-, SG., etc.) to keep false-positive rate low on real source code, and findings carry only rule id, label, span, and last-4 of the matched value, so neither the 422 body nor the audit row ever echoes the raw secret. Every non-empty finding set lands in the tamper-evident audit chain as `compare.secrets_detected` / `v1.compare.secrets_detected` / `v1.batch.secrets_detected` (or `*.secrets_blocked` when the request was refused) with the rule ids and the chosen mode, so a SOC2 reviewer can pivot from any audit row back to which workspace policy fired. Responses carry `x-codeclone-secret-scan-mode` and `x-codeclone-secret-scan-findings` headers plus an embedded `secret_scan` block so SDK clients can surface the DLP outcome without parsing audit logs. The owner-only editor at `/workspaces/<id>` exposes the four modes, the in-force mode, and a coverage list of every detection rule by id and label; non-owners see the section disabled. Ten regression tests in `web/tests/secret-scan.test.ts` pin the contract (pattern coverage and de-overlap on overlapping rules, no false positives on plain source, exact redaction substitution, mode semantics for off/warn/redact/block, policy round-trip including the sanitiser's strictest-mode fallback, source-grep proof that every snippet-accepting route imports `scanInputs` so a new compare-like route added later fails the test on day one, and a check that the blocked response shape never leaks the raw matched value). Endpoints: `GET/PUT/DELETE /api/workspaces/:id/secret-scan-policy`. Covers the standard procurement ask (SOC 2 CC6.7, ISO 27001 A.8.12, NIST 800-53 SC-28): "sensitive information transmitted to or stored by third-party services must be protected from inadvertent disclosure."

### Try it: block AWS keys from leaving your laptop

```sh
cd web && npm run dev   # http://localhost:3000

# Owner turns the policy to block.
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/secret-scan-policy \
  -H 'cookie: cc_session=...' \
  -H 'content-type: application/json' \
  -d '{"mode":"block"}'

# Any member that POSTs a snippet containing a credential gets a 422
# back with the rule id and the last-4 of the matched value, never
# the raw secret.
curl -si -X POST http://localhost:3000/v1/compare \
  -H "authorization: Bearer $CODECLONE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"a":"const k = \"AKIAEXAMPLEKEY123456\"","b":"const k = \"other\"","language":"javascript"}'
# HTTP/1.1 422 Unprocessable Entity
# {"error":{"type":"secrets_detected","findings":[{"rule":"aws_access_key_id","label":"AWS Access Key ID","tail_4":"3456","start":11,"end":31}], ...}}

# Flip to redact instead and similarity is computed against the marker.
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/secret-scan-policy \
  -H 'cookie: cc_session=...' -H 'content-type: application/json' \
  -d '{"mode":"redact"}'
```

- SSO group to role mapping. Workspace owners can now pin an id_token claim name (e.g. `groups`, `roles`) and a table of IdP group to codeclone role rules on top of the existing OIDC config, so the user's workspace role is re-synced from their IdP on every SSO sign-in. The policy is sanitized and persisted by `setSsoGroupMappings` (web/lib/workspaces.ts): blank groups, unknown roles, overlong names, and duplicates are dropped, and the table is capped at `SSO_GROUP_MAPPINGS_MAX` so a typo can't blow up the workspace doc. The role decision lives in `resolveRoleFromSsoGroups`, which accepts both array claims (`["okta-admins", "okta-eng"]`) and OAuth-style space-separated strings, ignores everything else, and picks the highest-ranked matching role (`owner > editor > viewer`). The SSO callback (`/api/auth/sso/[workspaceId]/callback`) reloads the workspace after auto-join, calls the resolver, and only writes when the desired role differs from the current one; the change goes through `setMemberRole` so the sole-owner safeguard still rejects a demotion that would orphan a tenant. Every flip writes a `workspace.role_synced_from_sso` audit row with a before/after diff and the source claim, and rejected attempts (e.g. only-owner) write the same action with `status: "denied"` so a SOC2 reviewer can reconstruct exactly which IdP group ever flipped a role. The owner-only editor at `/workspaces/<id>` adds the claim field plus the mapping table behind RBAC, the dashboard IP allowlist, and the rest of the workspace surface; non-owners see a read-only view. Endpoints: `GET/PUT/DELETE /api/workspaces/:id/sso/groups`. Five regression tests in `web/tests/workspaces-sso-groups.test.ts` pin the contract (refusal without an SSO config, sanitization of bad mappings and the size cap, resolver coverage for array/string/miss/ranked-tie inputs, end-to-end role update with sole-owner protection, and cross-tenant isolation across two unrelated workspaces). Covers the standard procurement ask (SOC 2 CC6.3, NIST 800-53 AC-2(7)): "the application supports role provisioning from the corporate identity provider."

### Try it: map Okta groups to workspace roles

```sh
cd web && npm run dev   # http://localhost:3000

# Owner sets the claim + mappings (SSO must already be configured on the workspace).
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/sso/groups \
  -H 'cookie: cc_session=...' \
  -H 'content-type: application/json' \
  -d '{"groupClaim":"groups","groupMappings":[
        {"group":"okta-admins","role":"owner"},
        {"group":"okta-eng","role":"editor"},
        {"group":"okta-readonly","role":"viewer"}]}'

# Members can read the policy (canEdit=false for non-owners).
curl -s http://localhost:3000/api/workspaces/$WS_ID/sso/groups \
  -H 'cookie: cc_session=...' | jq '.sso.groupMappings'

# Sign in via SSO and watch /audit for workspace.role_synced_from_sso rows
# carrying the before/after role and the source claim.
```

- Concurrent session cap per member. Workspace owners now set a maximum number of simultaneously active server-side sessions any one member may hold (1 to 20, or 0 for no cap), enforced on every sign-in path. The cap lives on the existing `sessionPolicy` record alongside `maxLifetimeSec` and `idleTimeoutSec`, sanitized server-side, persisted by `setSessionPolicy`, and surfaced read-only via `effectiveSessionPolicyForUser` which picks the strictest non-zero cap across only the workspaces the user is an active member of. Cross-tenant isolation is structural: sessions are stored per userId, so a workspace cap can never reach into a non-member's sessions. Enforcement runs in `enforceConcurrentSessionCap` (web/lib/sessions.ts), which is called from both `/api/auth/verify` (magic link) and `/api/auth/sso/[workspaceId]/callback` (OIDC) immediately after `createSession`. When the cap is exceeded, the oldest sessions are revoked first (ordered by `createdAt`, jti as tie-breaker), the just-issued session is preserved by jti, and every eviction writes a `session.evicted_for_cap` audit row with the cap, source workspace, evicted jti, original IP, and login channel (`magic_link` or `sso`) so a SOC2 reviewer can reconstruct exactly who was forced off. The session-policy editor at `/workspaces/<id>` exposes a third field with a clear "oldest session is revoked on a new sign-in" hint and shows the effective cap below the inputs. Four regression tests in `web/tests/workspaces-session-cap.test.ts` pin the contract (sanitize bounds and zero default, persist and clear on all-zero, strictest-cap selection with cross-tenant isolation between two unrelated workspace owners, and end-to-end eviction that revokes the oldest two of four sessions while leaving another user's session untouched). Covers the standard procurement ask (SOC 2 CC6.1, NIST 800-53 AC-10): "the number of concurrent sessions for a user account is limited."

### Try it: cap members at one active session

```sh
cd web && npm run dev   # http://localhost:3000

# Owner sets the cap at 1 (also keeps any existing lifetime/idle limits).
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/session-policy \
  -H 'cookie: cc_session=...' \
  -H 'content-type: application/json' \
  -d '{"maxLifetimeSec": 0, "idleTimeoutSec": 0, "maxConcurrentSessions": 1}'

# Members can read the effective cap (strictest non-zero across their workspaces).
curl -s http://localhost:3000/api/workspaces/$WS_ID/session-policy \
  -H 'cookie: cc_session=...' | jq '.effective.maxConcurrentSessions'
# 1

# Sign in a second time and watch /audit for a session.evicted_for_cap row
# pointing at the older jti. The newer session keeps working.
```

- Trust center and baseline security headers. Every dashboard and API response now carries the headers an enterprise procurement review checks for: a strict `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, locked `base-uri` and `form-action`), `Strict-Transport-Security` with preload, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a hardware-denying `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`. The header set is built by `web/lib/security-headers.ts::buildSecurityHeaders`, applied by the existing Edge middleware on every route, and pinned by `web/tests/security-headers.test.ts` so a regression that drops one fails CI. A new server-rendered `/trust` page reads the same function and renders the live header values next to a shipped-controls matrix (SSO, SCIM, MFA, RBAC, tamper-evident audit, residency, IP allowlists, rate limits, redaction, GDPR export, webhook HMAC), the subprocessor list, and the vulnerability disclosure contacts so a security reviewer can verify the posture in one URL. The disclosure policy is also published machine-readably at `/.well-known/security.txt` (RFC 9116) with `Contact`, `Expires`, `Canonical`, `Policy`, and `Acknowledgments` lines pointing back at SECURITY.md and the trust page. Covers the standard procurement ask (SOC 2 CC6.7, OWASP ASVS V14.4): "the application sets the documented set of security response headers and publishes a vulnerability disclosure channel."

### Try it: inspect the trust posture

```sh
cd web && npm run dev   # http://localhost:3000

# Browse the live posture page.
open http://localhost:3000/trust

# Headers on any response, dashboard or API.
curl -sI http://localhost:3000/ | grep -iE 'content-security-policy|strict-transport|x-frame-options|permissions-policy|referrer-policy'

# Machine-readable disclosure policy.
curl -s http://localhost:3000/.well-known/security.txt
```

- Tamper-evident inference audit log. Every row written by the `/v1/*` audit middleware now carries `seq`, `prev_hash`, and `hash` (sha256 over canonical JSON of the row payload chained from the previous row's hash), with a sidecar `audit.log.state` for crash recovery and chain resume on restart. A new admin-scoped endpoint `GET /v1/audit/verify` walks the on-disk JSONL, recomputes every link, and returns `{ok, total_entries, chained_entries, legacy_entries, last_hash, last_seq, broken_at_seq, broken_reason, chain_head}` with HTTP 200 on a clean chain and 409 plus `X-Audit-Chain-Status: broken` on tampering. Compliance teams pin `last_hash` externally so any silent rewrite of the log fails verification on the next run; rotation is preserved because the chain extends across rotated files as the writer reloads its tail. The audit dashboard at `/audit` grows a `verify serve chain` button next to the existing web chain verifier; the new Next.js route `/api/audit/serve-verify` proxies to the serve service using `CODECLONE_SERVE_ADMIN_KEY` so the admin token never reaches the browser, and the verification call itself is audited. Pinned by `services/serve/tests/test_audit_chain.py` (every row chains, endpoint returns ok on clean log, non-admin keys get 403, payload tampering surfaces `broken_at_seq` with HTTP 409). Covers the standard procurement ask (SOC 2 CC7.2, NIST 800-53 AU-9): "audit records are protected from unauthorized modification and integrity can be independently verified."

### Try it: verify the inference audit chain

```sh
codeclone serve --port 7461 &
curl -i -H 'authorization: Bearer sk-admin' http://localhost:7461/v1/models  # generate a row
curl -s -H 'authorization: Bearer sk-admin' http://localhost:7461/v1/audit/verify | jq
# {"enabled": true, "ok": true, "total_entries": 1, "chained_entries": 1,
#  "legacy_entries": 0, "last_hash": "...", "last_seq": 1, ...}
```

Then open `http://localhost:3000/audit` and click **verify serve chain** (set `CODECLONE_SERVE_ADMIN_KEY=sk-admin` in the web env first).

- Just-in-time support access grants at `/workspaces/<id>`: every workspace owner can drop a named vendor engineer into the workspace as a viewer for a bounded window (15 minutes to 24 hours, hard-capped server side) without ever making them a permanent member. `POST /api/workspaces/<id>/support-access` resolves the engineer's account, refuses to overwrite an existing permanent member (`409 already_member`) so a real teammate can never be silently downgraded into a support row, and writes a new `Member` with `role: "viewer"`, `status: "support"`, and an immutable `expiresAt`, `grantedBy`, `grantReason`, and optional `grantCaseRef`. The existing `isMemberActive` predicate that gates `getActiveMember`, `canInvite`, and `canManage` now honours `expiresAt`, so the moment the window closes the engineer falls off the workspace with no background job and no extra request; until then they read with no privilege creep (`canInvite` and `canManage` stay false by construction). `DELETE /api/workspaces/<id>/support-access?userId=...` revokes early; it refuses to touch any non-support row (`409 not_support_grant`) so the support console cannot be used to delete a teammate. Both writes require owner role plus a fresh MFA step-up grant, both run through the workspace IP allowlist enforcer, and every placement, replacement, and revocation writes an audit entry (`workspace.support_grant_create`, `workspace.support_grant_revoke`) with the engineer's email, reason, case reference, and old or new expiry, so the workspace produces a defensible "who entered our data, when, and why" timeline for SOC 2 CC6.1 and any DPA review. The workspace page surfaces a live countdown for each grant and a one-click revoke. Five regression tests in `web/tests/workspaces-support-access.test.ts` cover the happy path (grant resolves as active member, cannot invite or manage, deactivates after expiry), the no-downgrade refusal, in-place extension without duplicate rows, the support-only revoke guard, and the input contract. Try it: open `/workspaces/<ws_id>`, scroll to **support access**, enter `vendor@codeclone.support`, 60 minutes, `Investigating ticket SUP-1`, **Grant access**. `curl -i -b cc_session=... -H 'content-type: application/json' -X POST 'http://localhost:3000/api/workspaces/<ws_id>/support-access' -d '{"email":"vendor@codeclone.support","minutes":60,"reason":"Investigating ticket SUP-1","caseRef":"SUP-1"}'`.

- Dashboard IP allowlist enforcement. The per-workspace CIDR allowlist previously only gated API key traffic, leaving the cookie-authenticated dashboard and the session-backed `/api/workspaces/:id/**` admin endpoints open to anyone with valid credentials from any network. This release closes the gap: every workspace management route runs through `enforceWorkspaceAllowlistForSession` in `web/lib/dashboard-allowlist-enforce.ts`, which evaluates the request IP against `workspace.ipAllowlist` and returns `403 ip_not_allowed` with the blocked IP echoed back so the user can ask an owner to add it. Blocks write a `workspace.ip_block` audit entry tagged `channel:"dashboard"` with the surface name (members, sso, retention, etc.) so owners can tell dashboard blocks apart from API key blocks. Lockout safety is built in: the allowlist edit endpoint itself opts out of enforcement, so an owner who pins themselves to the wrong CIDR can still rewrite the list from wherever they are (with the recovery edit also recorded to the audit log). The workspace detail page surfaces the friendly message inline instead of a generic `HTTP 403`. Pinned by `web/tests/dashboard-allowlist-enforce.test.ts` (open allowlist, off-list block with structured payload, on-list allow, bypass lockout safety, cross-tenant isolation, audit entry shape). Covers the standard procurement ask (SOC 2 CC6.6, ISO 27001 A.13.1): "administrative access to tenant data is restricted to approved networks."

### Try it: pin a workspace dashboard to your office CIDR

```sh
cd web && pnpm dev   # http://localhost:3000

# Owner pins the allowlist. The allowlist edit endpoint itself is never
# gated, so the owner cannot get permanently locked out.
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/allowlist \
  -H 'cookie: cc_session=...' \
  -H 'content-type: application/json' \
  -d '{"entries": ["203.0.113.0/24"]}'

# A request from an off-list IP now sees the dashboard route refuse:
curl -si http://localhost:3000/api/workspaces/$WS_ID \
  -H 'cookie: cc_session=...' \
  -H 'x-forwarded-for: 198.51.100.7'
# HTTP/1.1 403 Forbidden
# {"error":{"type":"ip_not_allowed","ip":"198.51.100.7",
#   "message":"Your current IP is not on this workspace's allowlist..."}}
```

- Workspace MFA enrollment policy. Owners flip on a workspace-wide requirement that every active member enroll TOTP before they can create API keys, webhooks, or snippets, with a configurable grace window (0 to 90 days) measured from policy enablement or member join time, whichever is later. After the deadline, sensitive mutating endpoints refuse the user's requests with HTTP 403 `mfa_enrollment_required` and an audit row, while read-only endpoints stay open so users can self-remediate at /settings/security. The dashboard polls `/api/auth/mfa/required` to render a banner long before requests start being blocked. Cross-workspace scoping is strict: a policy in workspace A only constrains its own active members, never users who only belong to workspace B. Owner-only configuration via PUT /api/workspaces/:id/mfa-policy with a before/after audit diff; runtime decision in `lib/mfa-policy-decide.ts` and the NextResponse wrapper in `lib/mfa-enforce.ts`. Pinned by `web/tests/workspaces-mfa-policy.test.ts` (sanitize/clamp, persist/clear, cross-tenant isolation, the four-way required/enrolled/grace/block matrix). Covers the standard procurement ask (SOC 2 CC6.1, NIST 800-53 IA-2(1)): "multifactor authentication is required for all privileged users."

### Try it: require TOTP for everyone in a workspace

```sh
cd web && pnpm dev   # http://localhost:3000

# Owner enables the policy with a 7-day grace window.
curl -si -X PUT http://localhost:3000/api/workspaces/$WS_ID/mfa-policy \
  -H 'cookie: cc_session=...' \
  -H 'content-type: application/json' \
  -d '{"requireEnrollment": true, "gracePeriodDays": 7}'

# Any member can see their own status (banner data source).
curl -si http://localhost:3000/api/auth/mfa/required -H 'cookie: cc_session=...'
# {"required":true,"blocked":false,"enrolled":false,"workspaceId":"ws_...",
#  "gracePeriodDays":7,"deadline":1717000000000,"secondsRemaining":604800}
```

- Idempotency keys on POST `/v1/chat/completions` and `/v1/completions`. Clients pass `Idempotency-Key: <opaque>` and any retry within 24h that sends the same body replays the original response verbatim with `Idempotency-Replayed: true`, so flaky network retries no longer double-charge tokens or duplicate inference work. Reuse of the same key with a different body returns `409 Conflict` (`{error:{type:"idempotency_conflict"}}`) instead of silently serving stale data. The cache is partitioned by `(tenant, key)` so the same opaque string from two tenants stays isolated, replays and conflicts both stream to the audit log as `idempotency.replay` / `idempotency.conflict`, and streaming requests are accepted but not cached because byte-replay of SSE bodies is unsafe. Configured via `CODECLONE_IDEMPOTENCY_ENABLED` / `_STATE_PATH` / `_TTL_SECONDS` in `packages/config/codeclone_config/settings.py` and pinned by `services/serve/tests/test_idempotency.py` (key shape, fingerprint stability, store-level tenant isolation, end-to-end replay, conflict, cross-tenant non-leak, audit emission). Covers the standard Stripe-style procurement ask: “non-idempotent paid POSTs must be safely retryable.”

### Try it: replay a chat completion safely on retry

```sh
CODECLONE_API_KEYS=sk-acme:infer@acme uv run uvicorn codeclone_serve.app:create_app --factory --port 8000

# First call processes normally.
curl -si -X POST http://localhost:8000/v1/completions \
  -H 'Authorization: Bearer sk-acme' \
  -H 'Idempotency-Key: order-42' \
  -H 'content-type: application/json' \
  -d '{"model":"codeclone","prompt":"def add(a,b):","max_tokens":16}'
# HTTP/1.1 200 OK

# Same key + same body within 24h: replayed from cache.
curl -si -X POST http://localhost:8000/v1/completions \
  -H 'Authorization: Bearer sk-acme' \
  -H 'Idempotency-Key: order-42' \
  -H 'content-type: application/json' \
  -d '{"model":"codeclone","prompt":"def add(a,b):","max_tokens":16}'
# HTTP/1.1 200 OK
# Idempotency-Replayed: true

# Same key + different body: 409, no silent stale data.
curl -si -X POST http://localhost:8000/v1/completions \
  -H 'Authorization: Bearer sk-acme' \
  -H 'Idempotency-Key: order-42' \
  -H 'content-type: application/json' \
  -d '{"model":"codeclone","prompt":"DIFFERENT","max_tokens":16}'
# HTTP/1.1 409 Conflict
# {"error":{"type":"idempotency_conflict",...}}
```

- Workspace API key max-age policy enforced at issue time and on every `/v1` call. Owners cap how long any API key minted in the workspace may live (1 to 365 days) under the workspace settings page; the policy clamps the `expiresAt` of every new key as it is created in `web/lib/api-keys.ts#createKey`, and a second guard (`web/lib/api-key-policy-enforce.ts`) runs on `/v1/compare`, `/v1/batch`, `/v1/shares`, and `/v1/shares/[id]` so legacy keys that pre-date the policy are refused with HTTP 401 and a structured `{error:{type:"api_key_policy_expired", max_age_days, age_days}}` body until rotated. Members hit the same audit chain everything else uses: every policy change emits `workspace.api_key_policy_update` with a before/after diff, every runtime block emits `workspace.api_key_policy_block` with the offending key id and computed age in days, and members who try to PUT the policy endpoint without owner permission get a denied entry so owners can see attempted privilege escalation. Covers the common SOC 2 CC6.1 / ISO 27001 A.9.2.6 procurement ask: “API credentials must expire within N days and be rotated.” Pinned by `web/tests/workspaces-api-key-policy.test.ts` (sanitization clamping, persist + clear round-trip, createKey clamping a 365-day request down to the workspace cap even when no expiry was requested, drift-key deadline math used by the enforcer).

### Try it: cap workspace API keys at 30 days and watch a stale key get refused

```sh
pnpm dev   # web dashboard on http://localhost:3000

# As the workspace owner, set the policy:
curl -s -X PUT http://localhost:3000/api/workspaces/$WS_ID/api-key-policy \
  -b "$COOKIE" -H 'content-type: application/json' \
  -d '{"maxAgeDays":30}' | jq
# { "policy": { "maxAgeDays": 30, "updatedAt": ..., "updatedBy": "u_..." } }

# A brand-new key in this workspace gets expiresAt clamped to ~30d even
# if the caller asks for 365d:
curl -s -X POST http://localhost:3000/api/api-keys \
  -b "$COOKIE" -H 'content-type: application/json' \
  -d "{\"label\":\"ci\",\"workspaceId\":\"$WS_ID\",\"expiresInDays\":365}" | jq '.key.expiresAt'

# Any /v1 call from a key whose createdAt is older than 30d is refused:
curl -si -X POST http://localhost:3000/api/v1/compare \
  -H "Authorization: Bearer $OLD_WS_KEY" -H 'content-type: application/json' \
  -d '{"a":"x","b":"y"}'
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
# {"error":{"type":"api_key_policy_expired","max_age_days":30,"age_days":47,...}}
```

- Workspace data residency policy with per-region enforcement on the public API. Owners pin a workspace to `us`, `eu`, `apac`, or `global` under the workspace settings page; flipping `enforced` causes every `/v1/*` request served by a node whose `CODECLONE_REGION` does not match to be refused with HTTP 451 (Unavailable For Legal Reasons) and a structured `{error:{type:"residency_violation", pinned_region, serving_region}}` body. Non-enforced mismatches still succeed but emit a `workspace.residency_warn` audit entry so ops can watch drift before flipping the policy on. Enforcement runs inside the same `enforceWorkspace*ForKey` chain as the IP allowlist and per-key allowlist (`web/lib/residency-enforce.ts`) and is wired into every existing v1 surface (`/v1/compare`, `/v1/batch`, `/v1/shares`, `/v1/shares/[id]`), not just one new route, so a half-migrated EU workspace cannot leak through a forgotten endpoint. The settings card shows the current serving region next to the pinned region with a banner that calls out a live mismatch, so an EU customer staring at a US node sees the problem before their first call fails. Every change writes a tamper-evident audit entry (`workspace.residency_update`, `workspace.residency_clear`) with a before/after diff of the policy, and members trying to PUT the endpoint get a denied entry so owners can see attempted privilege escalation. Pinned by `web/tests/residency.test.ts` (sanitization, persistence, decision matrix, 451 body shape, cross-tenant isolation between an EU-pinned and US-pinned workspace on the same node).

### Try it: pin a workspace to EU and watch a US node refuse the call

```sh
pnpm dev   # web dashboard on http://localhost:3000

# As the workspace owner, set the policy:
curl -s -X PUT http://localhost:3000/api/workspaces/$WS_ID/residency \
  -b "$COOKIE" -H 'content-type: application/json' \
  -d '{"region":"eu","enforced":true}' | jq
# { "residency": { "region": "eu", "enforced": true, ... }, "servingRegion": "us" }

# Any v1 call from a key bound to that workspace, served by a US node, now fails:
CODECLONE_REGION=us pnpm dev
curl -si -X POST http://localhost:3000/api/v1/compare \
  -H "Authorization: Bearer $WS_KEY" -H 'content-type: application/json' \
  -d '{"a":"x","b":"y"}'
# HTTP/1.1 451 Unavailable For Legal Reasons
# {"error":{"type":"residency_violation","pinned_region":"eu","serving_region":"us",...}}
```

- Inbound prompt redaction for PII and secrets. Every request that hits `/v1/chat/completions` or `/v1/completions` is scanned before it reaches the model and rewritten in place using deterministic placeholders (`[REDACTED_AWS_ACCESS_KEY_ID]`, `[REDACTED_GITHUB_TOKEN]`, `[REDACTED_JWT]`, `[REDACTED_PRIVATE_KEY]`, `[REDACTED_EMAIL]`, `[REDACTED_IPV4]`, ...). Operators set the default policy with `CODECLONE_REDACT_POLICY=off|redact|block` and override per tenant with `CODECLONE_REDACT_OVERRIDES=acme=block,beta=redact`. In `redact` mode the rewritten prompt is sent to the model and the response carries `X-Codeclone-Redactions: N` plus an `X-Codeclone-Redaction-Categories` breakdown; in `block` mode the request is rejected with HTTP 422 and a structured `{error:{type:"redaction_blocked", findings}}` body so a leaking client cannot silently retry around the policy. Every scan emits a `redaction.scan` audit entry (request id, tenant, route, mode, blocked flag, per-category counts) so security teams can prove DLP enforcement after the fact. Detectors cover AWS access keys + secret keys, GitHub PAT/fine-grained tokens, OpenAI/Anthropic/Slack prefixed keys, JWTs, `Authorization: Bearer ...` headers, PEM private key blocks, emails, and IPv4 literals. Tenant overrides are isolated end to end: a key bound to `@acme` with policy `block` cannot leak the same secret that another tenant with policy `off` is allowed to send through. Pinned by `services/serve/tests/test_redaction.py` (17 cases: per-detector accuracy, policy parser shape, three-mode HTTP integration, cross-tenant isolation).

### Try it: scan and block a leaked secret

```sh
export CODECLONE_API_KEY=sk-test
export CODECLONE_REDACT_POLICY=block
uv run uvicorn codeclone_serve.app:create_app --factory --port 8000

curl -si -X POST http://localhost:8000/v1/completions \
  -H 'Authorization: Bearer sk-test' \
  -H 'content-type: application/json' \
  -d '{"model":"codeclone","prompt":"deploy with aws_secret=AKIAIOSFODNN7EXAMPLE","max_tokens":8}'
# HTTP/1.1 422 Unprocessable Entity
# X-Codeclone-Redactions: 1
# X-Codeclone-Redaction-Categories: aws_access_key_id=1
# {"error":{"type":"redaction_blocked","findings":{"aws_access_key_id":1},"total":1}}

# Switch to redact mode and the same call succeeds with the secret rewritten:
CODECLONE_REDACT_POLICY=redact uv run uvicorn codeclone_serve.app:create_app --factory --port 8000
curl -si -X POST http://localhost:8000/v1/completions \
  -H 'Authorization: Bearer sk-test' -H 'content-type: application/json' \
  -d '{"model":"codeclone","prompt":"aws_secret=AKIAIOSFODNN7EXAMPLE","max_tokens":8}' \
  | grep -i codeclone-redactions
# X-Codeclone-Redactions: 1
```

- Per-user session rate limits on browser-driven endpoints. The public `/v1/*` API already enforces per-API-key ceilings, but the cookie-session routes the dashboard calls (`/api/compare`, `/api/snippets`) had no per-tenant cap, so a single signed-in user could DOS the comparator from a tight loop in the UI. A new sliding-window limiter (`web/lib/session-rate-limit.ts`) buckets each authenticated user into named pools (default: 60 rpm for compare, 30 rpm for snippet writes) and falls back to a per-IP bucket for anonymous callers, so unauthenticated probes cannot bypass the ceiling. Counters are filesystem-backed under `$CODECLONE_SESSION_RATELIMIT_DIR`, separate from the API-key limiter, so ops can tune the two surfaces independently with `CODECLONE_SESSION_RATELIMIT_COMPARE_RPM` / `CODECLONE_SESSION_RATELIMIT_SNIPPETS_RPM`. Every response carries the standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Policy` headers; over-limit calls return HTTP 429 with `Retry-After`, a structured `{error:{type:"rate_limited", bucket, limit, retry_after_seconds}}` body, and an immutable audit entry (`compare.rate_limited` / `snippet.rate_limited`) so SOC reviewers can see when a tenant was throttled. Settings -> Security renders a live card showing the buckets in effect, and a new introspection endpoint `/api/session-rate-limits` returns the same data for programmatic clients. Pinned by `web/tests/session-rate-limit.test.ts` (5 cases: env override, per-user isolation, 429 headers, bucket independence, anonymous IP fallback).

### Try it: hit the per-user compare ceiling

```sh
pnpm dev   # web dashboard on http://localhost:3000

# Sign in, then introspect the effective limits:
curl -s http://localhost:3000/api/session-rate-limits -b "$COOKIE" | jq
# { "buckets": [
#   { "bucket": "compare",        "label": "Compare requests",  "limit_rpm": 60, "window_seconds": 60 },
#   { "bucket": "snippets-write", "label": "Snippet writes",    "limit_rpm": 30, "window_seconds": 60 },
#   { "bucket": "default",        "label": "Default session bucket", "limit_rpm": 120, "window_seconds": 60 }
# ] }

# Watch the headers on a normal compare request:
curl -si -X POST http://localhost:3000/api/compare \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"a":"int x=1;","b":"int x=2;","language":"c"}' | grep -i ratelimit
# X-RateLimit-Limit: 60
# X-RateLimit-Remaining: 59
# X-RateLimit-Reset: 1717282860
# X-RateLimit-Policy: 60;w=60

# Tighten the limit for the demo and burst until 429:
CODECLONE_SESSION_RATELIMIT_COMPARE_RPM=3 pnpm dev
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:3000/api/compare \
    -H 'content-type: application/json' -b "$COOKIE" \
    -d '{"a":"a","b":"b","language":"c"}'
done
echo
# 200 200 200 429
```

- Rotate webhook signing secrets with zero dropped deliveries. Workspace editors and owners open a registered webhook under `/webhooks` and click Rotate to issue a fresh `whsec_...` secret. The plaintext is shown exactly once, only its SHA-256 hash is persisted, and the existing secret stays primary so nothing breaks. For the next 24 hours (configurable per call, 1m to 30d) every delivery is signed with BOTH secrets: the existing one in `X-CodeClone-Signature` / `X-CodeClone-Hash`, and the new one in `X-CodeClone-Signature-Next` / `X-CodeClone-Hash-Next`. Receivers verify with whichever secret they already have, deploy a verifier that accepts the new secret, then the operator clicks Finalize to promote the pending secret to primary and stop dual-signing. Cancel discards the pending secret without touching primary. Every initiate/finalize/cancel writes an immutable audit entry (`webhook.secret.rotate_initiate|finalize|cancel`) with the rotating prefixes in the diff, the same call flows through `audit.recorded` for SIEM streaming, and viewers are denied at the API layer. Cross-workspace callers see a 404 because rotation is workspace-scoped end to end. Pinned by `web/tests/webhooks-rotate.test.ts` (plaintext-once, dual-sign header verification with HMAC re-derivation, finalize promotion, cancel no-op on primary, cross-tenant isolation).

### Try it: rotate a webhook signing secret

```sh
pnpm dev   # web dashboard on http://localhost:3000

# 1. Sign in, create or open a webhook at http://localhost:3000/webhooks,
#    expand the row, and click Rotate. The new secret is shown once.
#
# 2. Or rotate from the CLI (editor/owner cookie required). A 24h grace
#    window is the default; override with graceMs in the body.
WH=wh_xxxxxxxx        # webhook id
WS=ws_yyyyyyyyyyy     # workspace id
curl -s -X POST "http://localhost:3000/api/webhooks/$WH/rotate?workspaceId=$WS" \
  -H 'content-type: application/json' \
  -b "$COOKIE" -d '{"graceMs": 86400000}' | jq
# { "record": { "pendingSecretPrefix": "whsec_abcd", "pendingExpiresAt": 1717282800000, ... },
#   "secret": "whsec_...",  # shown ONCE, store it
#   "expiresAt": 1717282800000 }

# 3. Every delivery during the grace window now carries dual signatures:
#    X-CodeClone-Signature:      t=...,v1=<hmac-with-old-secret>
#    X-CodeClone-Signature-Next: t=...,v1=<hmac-with-new-secret>
#    X-CodeClone-Hash, X-CodeClone-Hash-Next

# 4. Once receivers accept the new secret, finalize:
curl -s -X PUT "http://localhost:3000/api/webhooks/$WH/rotate?workspaceId=$WS" -b "$COOKIE" | jq
# Or cancel and keep the old secret:
curl -s -X DELETE "http://localhost:3000/api/webhooks/$WH/rotate?workspaceId=$WS" -b "$COOKIE" | jq
```

- Webhook test ping for pre-launch HMAC verification. Workspace editors and owners click the new Ping button on any registered webhook under `/webhooks` to fire a single, fully-signed `webhook.ping` delivery against the live URL. Same signing pipeline, headers, and retry budget as a real event, so a passing ping is real proof the receiver verifies the HMAC and is reachable; counters and the delivery log update exactly like a live dispatch, and the dashboard renders the HTTP status, latency, and any error inline next to the row. Disabled webhooks are refused with HTTP 409 `webhook_disabled` so a ping cannot mask a paused integration, viewers get 403, and cross-workspace callers see 404 with no side effects. Every attempt (ok, error, denied) writes a `webhook.ping` audit row with the delivery id, HTTP status, attempts, duration, and error message so a procurement reviewer can pivot from the audit log to which integrator validated their endpoint and when. Pinned by `web/tests/webhooks-ping.test.ts` (signature verifies against the documented HMAC algorithm using the primary secret hash, failure path bumps `failureCount` and records `lastError`, cross-tenant ping returns null with no HTTP call and no counter change).

### Try it: send a webhook test ping

```sh
pnpm dev   # web dashboard on http://localhost:3000

# 1. From the dashboard: open /webhooks, click Ping on the row. The result
#    (HTTP status, latency, error) appears inline.
#
# 2. Or from the CLI (editor/owner cookie required):
WH=wh_xxxxxxxx        # webhook id
WS=ws_yyyyyyyyyyy     # workspace id
curl -s -X POST "http://localhost:3000/api/webhooks/$WH/ping?workspaceId=$WS" \
  -b "$COOKIE" | jq
# { "delivery": {
#     "id": "...", "event": "webhook.ping", "ok": true,
#     "status": 200, "attempts": 1, "durationMs": 42,
#     "requestBodyPreview": "{\"event\":\"webhook.ping\",...}"
#   } }
#
# The receiver gets the standard signed envelope:
#   X-CodeClone-Event:     webhook.ping
#   X-CodeClone-Signature: t=<unix>,v1=<hmac-sha256>
#   X-CodeClone-Hash:      <first 16 of secret hash>
```

- Brute-force protection on the sign-in endpoint with per-email and per-IP fixed-window counters. Magic link issuance at `POST /api/auth/request` evaluates both scopes before doing any work, returns a structured 429 with `Retry-After` and `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `X-RateLimit-Policy` headers when either ceiling is exceeded, and records `auth.magic_link_throttled_email` or `auth.magic_link_throttled_ip` audit entries (which flow through the same SIEM webhook pipeline as every other security event). Tripping the limit promotes the source to a lockout for the remainder of the window so an attacker cannot enumerate accounts or bomb a user's inbox. Defaults are 5 attempts per email and 20 per IP in 15 minutes, all overridable via `CODECLONE_AUTH_THROTTLE_EMAIL_MAX`, `CODECLONE_AUTH_THROTTLE_IP_MAX`, `CODECLONE_AUTH_THROTTLE_WINDOW_SEC`, and `CODECLONE_AUTH_THROTTLE_LOCKOUT_SEC`; setting any maximum to 0 disables that scope. Workspace owners get a console at `/settings/security/lockouts` that shows active blocks as opaque hashes (so the UI itself never leaks raw emails or IPs) with countdowns until they clear, and `GET /api/security/lockouts` returns the same data for automation. Cross-scope independence, lockout semantics, header shape, and active-lockout enumeration are pinned by `web/tests/auth-throttle.test.ts`.

### Try it: trip and inspect a sign-in lockout

```sh
pnpm dev   # web dashboard on http://localhost:3000

# 1. Hammer the magic link endpoint past the email ceiling (default 5).
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "%{http_code} %header{Retry-After}\n" \
    -X POST http://localhost:3000/api/auth/request \
    -H 'content-type: application/json' \
    -d '{"email":"victim@acme.com"}'
done
# Expect: 200, 200, 200, 200, 200, 429 <seconds>, 429 <seconds>

# 2. Sign in as a workspace owner, then inspect the lockouts API.
curl -s http://localhost:3000/api/security/lockouts -b "$COOKIE" | jq
#   {
#     "config": { "emailMax": 5, "ipMax": 20, "windowSec": 900, "lockoutSec": 900 },
#     "lockouts": [ { "scope": "email", "hash": "<sha256-prefix>",
#                    "count": 6, "lockedUntil": 1717197300000 } ]
#   }

# 3. Or open http://localhost:3000/settings/security/lockouts for the UI.
```

- Stream the audit log to your SIEM in real time via `audit.recorded` webhooks. Workspace owners register an HTTPS endpoint under `/webhooks`, tick the `audit.recorded` event, and every audit entry written for that workspace is fanned out as a signed delivery (HMAC-SHA256 over `t.{body}` in `X-CodeClone-Signature`, plus `X-CodeClone-Hash` for secret pinning, with three retries on failure and the existing SSRF guardrails on the target URL). The forwarded payload includes `id`, `seq`, `hash`, `prevHash`, `action`, `status`, `actorId`, `actorEmail`, `workspaceId`, `target`, `ip`, and `requestId` so the receiving Splunk/Datadog/S3 sink can re-verify the tamper-evident chain end to end; `diff` and `meta` are omitted to keep SIEM volume bounded and are still fetchable via `GET /api/audit?id=...`. Audit entries with no workspaceId (anonymous sign-in attempts and similar) are never forwarded, and entries for workspace A never reach a webhook registered in workspace B. Forwarding is fire-and-forget so an unhealthy SIEM never blocks an audit write, and a downstream outage cannot fail an underlying mutation. Set `CODECLONE_AUDIT_FORWARD=0` for air-gapped installs. Cross-tenant isolation, payload shape, and the no-workspace skip rule are pinned by `web/tests/audit-webhook-forward.test.ts`.

### Try it: stream audit events to a SIEM

```sh
pnpm dev   # web dashboard on http://localhost:3000

# 1. Sign in, open http://localhost:3000/webhooks, pick a workspace, paste
#    your SIEM URL (https://logs.example.com/codeclone), tick the
#    `audit.recorded` checkbox, and click Create webhook. Copy the
#    signing secret shown once.
#
# 2. Trigger any mutating action (create a snippet, rotate an API key,
#    invite a teammate) and your SIEM endpoint receives a signed POST
#    within milliseconds:
#
#    POST /codeclone
#    Content-Type: application/json
#    X-CodeClone-Event: audit.recorded
#    X-CodeClone-Signature: t=1717196400,v1=<hmac-sha256>
#    X-CodeClone-Hash: <first 16 hex chars of the secret hash>
#    {
#      "event": "audit.recorded",
#      "created_at": 1717196400,
#      "data": {
#        "id": "...", "seq": 42, "hash": "...", "prevHash": "...",
#        "action": "snippet.create", "status": "ok",
#        "actorId": "u_...", "actorEmail": "alice@acme.com",
#        "workspaceId": "ws_...", "target": {"type":"snippet","id":"..."},
#        "ip": "203.0.113.7", "requestId": "req_..."
#      }
#    }
#
# 3. Verify each delivery on the receiver:
#       hmac_sha256(secret, "<ts>.<raw_body>") == v1 in X-CodeClone-Signature
#    and pin the webhook to your tenant by checking data.workspaceId.
```

- Per-tenant monthly request quotas on the serve API: enterprise contracts specify a calendar-month ceiling distinct from per-minute rate limits, and the serve API now enforces one. Set `CODECLONE_QUOTA_PER_TENANT_MONTHLY=100000` for a global default, or `CODECLONE_QUOTA_OVERRIDES="acme=1000000,trial=1000"` for per-tenant caps. Every authenticated response carries `X-RateLimit-Limit-Month`, `X-RateLimit-Remaining-Month`, `X-RateLimit-Reset-Month`, and `X-RateLimit-Period` so customer SDKs can render usage without a side call. Once a tenant exhausts its cap the next request gets HTTP 429 with a structured `quota_exceeded` body and a `Retry-After` pointing at the next UTC month boundary, while other tenants are unaffected. The counter is persisted at `CODECLONE_QUOTA_STATE_PATH` (defaults to `runs/quota_state.json`) via atomic file rewrites so the cap survives restarts and rolling redeploys, and rolls over automatically at the first UTC midnight of each calendar month. `GET /v1/quota` returns the caller's current period, used count, limit, remaining, and reset epoch; admin-scope holders can introspect any tenant via `?tenant=<id>`, non-admin callers cannot, so cross-tenant disclosure is blocked. Default of `0` is unlimited, so existing deployments are unaffected until an operator opts in. Cross-tenant isolation, persistence, and the admin RBAC boundary are pinned by `services/serve/tests/test_quota.py`.

### Try it: enforce a monthly request cap

```
export CODECLONE_API_KEYS="sk-acme:models:read+infer@acme"
export CODECLONE_QUOTA_PER_TENANT_MONTHLY=3
codeclone serve --port 7461 &

# Three calls succeed and report decreasing remaining quota.
for i in 1 2 3; do
  curl -is http://localhost:7461/v1/models -H 'Authorization: Bearer sk-acme' \
    | grep -E '^(HTTP|X-RateLimit-)'
done

# Fourth call is rejected with the standard quota-exceeded payload.
curl -i http://localhost:7461/v1/models -H 'Authorization: Bearer sk-acme'

# Inspect remaining quota without spending any.
curl -s http://localhost:7461/v1/quota -H 'Authorization: Bearer sk-acme'
```

- Workspace member role changes and forced removals on `/workspaces/<id>` now sever credentials the moment privilege drops. `PATCH /api/workspaces/:id` with `{member:{userId,role}}` requires MFA step-up, records a before/after role diff to the audit log under `workspace.member_role_change`, and on any actual role change calls `revokeAllSessions(userId)` so the affected user's next request re-authenticates against their new role (no quiet window where a freshly demoted editor keeps writing). `DELETE /api/workspaces/:id?userId=<uid>` for forced removal (owner removing someone else) similarly requires MFA step-up and, after `removeMember`, calls both `revokeAllSessions` and `revokeKey` over every key returned by `listKeys` so a removed employee cannot keep using cookies or API keys they already held. Sole-owner demotion and last-owner removal are rejected (`only_owner`) and both denials and the per-removal `sessionsRevoked` / `apiKeysRevoked` counts land in the audit log so reviewers can see exactly what was torn down. The privilege-boundary contract (`setMemberRole` + revocation, sole-owner safety, forced removal + revocation, and a source-level assertion that the route still wires MFA, revocation, and audit diffs) is pinned by `web/tests/workspaces-role-change.test.ts`.
- Workspace member suspension on `/workspaces/<id>`: owners can pause a member's access without losing the audit trail. The roster row stays put with `status: "suspended"` so every historical event keeps its actor link, but every gating helper (`getActiveMember`, `canInvite`, `canManage`) treats the user as a non-member. On suspend the server also revokes every active session for that user (`revokeAllSessions`) and revokes every API key they own (`listKeys` then `revokeKey`), and the audit log captures both counts. Owner-only `POST /api/workspaces/:id/members/:userId/suspend` (with MFA step-up) does the suspension; `DELETE` on the same path reinstates the member. Sole-owner self-suspend is blocked (`only_owner`) and owners cannot suspend themselves (`cannot_suspend_self`); reinstating does not auto-restore the revoked sessions or keys. Cross-tenant isolation, audit-row preservation, and the sole-owner safety check are pinned by `web/tests/workspaces-suspend.test.ts`.

### Try it: suspend a departing teammate

```sh
pnpm dev   # web dashboard on http://localhost:3000

# 1. Sign in as the workspace owner and open
#    http://localhost:3000/workspaces/<id>. Each member row now has a pause
#    button next to the trash icon. Click it, enter an optional reason
#    ("offboarded 2026-05-31"), and confirm. After MFA step-up the row dims,
#    a "suspended" badge appears, and their email is struck through.
#
# 2. Same flow over the API (owner cookie, MFA-stepped-up session):
curl -X POST http://localhost:3000/api/workspaces/$WS/members/$UID/suspend \
  -H 'content-type: application/json' \
  -b cookies.txt \
  -d '{"reason":"offboarded"}'
# => {"ok":true,"suspended":true,"sessionsRevoked":2,"apiKeysRevoked":1}
#
# 3. The audit log records `workspace.member_suspend` with sessionsRevoked,
#    apiKeysRevoked, and the reason. The user's existing browser session
#    starts failing on the next request (cookie jti is in the revoked set)
#    and any API key they were carrying returns 401 invalid_key.
#
# 4. Reinstating restores access. Sessions and keys stay revoked so the
#    user must sign back in fresh.
curl -X DELETE http://localhost:3000/api/workspaces/$WS/members/$UID/suspend \
  -b cookies.txt
# => {"ok":true,"suspended":false}
```

- Workspace webhook destination domain allowlist on `/workspaces/<id>`: owners can restrict which hostnames any webhook in the workspace may target, using exact hosts (`hooks.partner.com`) or wildcard suffixes (`*.partner.com`). Enforced at two points so the policy is real: `POST /api/webhooks` rejects a new webhook whose URL host is not in the list with a 400 and a descriptive error, and the dispatcher re-checks on every attempt of `dispatchEvent` and `redeliverDelivery` so tightening the policy immediately blocks in-flight deliveries to a now-disallowed host (the delivery is logged with `blocked: "<host>" not in workspace webhook domain allowlist` and `fetch` is never called). SSRF rules (no loopback / RFC1918 / link-local / cloud metadata) still apply on top. Sanitisation rejects IP literals, schemes, paths, and labels without an alphabetic TLD so junk inputs never widen the policy. Owner-only PUT `/api/workspaces/:id/webhook-domains` records full before/after diffs in the tamper-evident audit chain as `workspace.webhook_domains_update`; non-owner PUTs are logged as `status: denied`. Cross-tenant isolation and the late-tightening delivery block are pinned by `web/tests/workspaces-webhook-domains.test.ts`.

### Try it: lock webhooks to a vendor domain

```bash
cd web && npm run dev

# 1. Sign in, open http://localhost:3000/workspaces/<id>, and under
#    "webhook domain allowlist" add `*.partner.com`.

# 2. Creating a webhook to a different host now fails:
curl -i -H 'content-type: application/json' \
     -b "$COOKIE" \
     -X POST http://localhost:3000/api/webhooks \
     -d '{"workspaceId":"ws_...","label":"leak","url":"https://attacker.example.com/hook","events":["compare.completed"]}'
# => HTTP/1.1 400
# => {"error":"URL host \"attacker.example.com\" is not in this workspace's webhook domain allowlist."}

# 3. An in-list URL is accepted:
curl -s -H 'content-type: application/json' -b "$COOKIE" \
     -X POST http://localhost:3000/api/webhooks \
     -d '{"workspaceId":"ws_...","label":"prod","url":"https://hooks.partner.com/intake","events":["compare.completed"]}'
```

- Per-API-key source IP allowlist on `/api-keys`: every API key can now carry its own list of allowed source CIDRs, independent of (and stricter than) the workspace IP allowlist. Set it at key creation (paste CIDRs into the new `Source IP allowlist` row) or on any live key from the row's shield button. Every public `/v1` route (`POST /v1/compare`, `POST /v1/batch`, `GET /v1/shares`, `GET /v1/shares/{id}`) checks the key's allowlist after the workspace allowlist and before the rate limiter, so an IP-locked key cannot be used from a developer laptop even if the workspace policy is open. The check has no loopback bypass (the workspace policy has one for kubelet probes; per-key is for production credentials, where silently permitting 127.0.0.1 would defeat the audit story). Non-matching IPs return HTTP 403 with a structured `ip_not_allowed` body that echoes the caller's IP, and every block writes an `api_key.ip_block` audit entry tagged with the key id, label, and rule count. Mutations write `api_key.update_ip_allowlist` with a full before/after diff. IPv4 and IPv6 CIDRs are accepted, bare IPs are treated as `/32` and `/128`, duplicates and junk are dropped on save, and a patch that contains only junk is refused so a fat-fingered request never widens the policy to open. Cross-key isolation is locked in by `web/tests/api-keys-ip-allowlist.test.ts`: two keys with disjoint allowlists each accept their own source IP and 403 the other's.

### Try it: lock an API key to a specific source IP

```bash
cd web && npm run dev

# 1. Sign in, open http://localhost:3000/api-keys, create a key and paste
#    `203.0.113.0/24` into the new "Source IP allowlist" row before submit.
#    The reveal modal shows the plaintext exactly once.

# 2. A call from inside the allowed CIDR works:
curl -i -H "Authorization: Bearer cc_live_..." \
     -H 'X-Forwarded-For: 203.0.113.10' \
     -H 'content-type: application/json' \
     -X POST http://localhost:3000/api/v1/compare \
     -d '{"a":"x=1","b":"x=2"}'

# 3. The same key from outside the CIDR is refused, and the deny is
#    recorded in the audit log as api_key.ip_block:
curl -i -H "Authorization: Bearer cc_live_..." \
     -H 'X-Forwarded-For: 198.51.100.7' \
     -H 'content-type: application/json' \
     -X POST http://localhost:3000/api/v1/compare \
     -d '{"a":"x=1","b":"x=2"}'
# => HTTP/1.1 403 Forbidden
# => {"error":{"type":"ip_not_allowed","ip":"198.51.100.7",...}}

# 4. Update or clear the allowlist later via PUT:
curl -i -X PUT http://localhost:3000/api/api-keys/<id> \
     -H 'content-type: application/json' -b cc_session=... \
     -d '{"ipAllowlist":["203.0.113.0/24","2001:db8::/32"]}'
curl -i -X PUT http://localhost:3000/api/api-keys/<id> \
     -H 'content-type: application/json' -b cc_session=... \
     -d '{"ipAllowlist":null}'   # clear and return to open
```

- Per-API-key source IP allowlist at `/api-keys`: every API key can now be locked to a specific list of source CIDR ranges, independent of (and stricter than) the workspace-wide allowlist, so a production credential really is unusable from anywhere except the named CI runner, NAT gateway, or office network. Set the list at create time (an extra row on the create form) or change it later from a per-row **N cidr** / **any ip** button on `/api-keys`; enforcement runs on every `/api/v1/compare`, `/api/v1/batch`, `/api/v1/shares`, and `/api/v1/shares/<id>` request and returns `403 ip_not_allowed` with the caller's IP echoed back when the source doesn't match. Loopback bypass is intentionally off for the per-key check (the workspace check keeps it, so kubectl health probes still work) because a procurement reviewer needs the per-key allowlist to be the absolute floor: a leaked key from a laptop on the corporate VPN still can't call the API. Invalid CIDRs are silently dropped at write time and the rejected entries are returned in the API response so the UI can surface them; clearing the list (null or empty array) restores the default open behaviour. `POST /api/api-keys` and `PUT /api/api-keys/<id>` both accept `ipAllowlist: string[] | null`, cross-user mutation is refused, and every create, update, and 403 block writes a structured audit entry (`api_key.create`, `api_key.update_ip_allowlist`, `api_key.ip_block`) so SOC2 reviewers can correlate a denied request back to the key id and source IP. Per-key isolation, CIDR validation, the no-loopback-bypass invariant, and the cross-user refusal are all locked in by `web/tests/api-keys-ip-allowlist.test.ts` (10 cases). Try it: open http://localhost:3000/api-keys, click **any ip** next to a key, enter `203.0.113.0/24`, then `curl -i -H 'Authorization: Bearer <key>' -H 'x-forwarded-for: 198.51.100.1' -X POST 'http://localhost:3000/api/v1/compare' -H 'content-type: application/json' -d '{"a":"a=1","b":"a=2"}'` and watch it 403 with `ip_not_allowed`.

- SCIM 2.0 user provisioning per workspace at `/workspaces/<id>`: every workspace owner can issue a per-workspace bearer token that an enterprise IdP (Okta, Azure AD / Entra ID, JumpCloud, OneLogin, anything that speaks RFC 7644) uses to push, update, deactivate, and remove users without anyone clicking through the codeclone UI. The full IdP-facing surface is live at `/scim/v2/<workspaceId>/...` and implements `Users` create + list with filter + pagination + get + put + patch + delete, plus `ServiceProviderConfig`, `Schemas`, and `ResourceTypes` discovery docs, all returning `application/scim+json` with proper SCIM error bodies and `WWW-Authenticate: Bearer` on 401. Auth is a per-workspace bearer token issued from the settings page; the plaintext is shown exactly once at issue or rotate (only a sha256 hash and a 14-char prefix are persisted) and the stored record is bound to a single `workspaceId` so a token leaked from workspace A is rejected at workspace B's URL by both the path match and the stored binding (covered by `web/tests/scim.test.ts: issued token validates only for its own workspace` and `provisioned users are isolated per workspace`). Filter parsing supports the equality forms IdPs actually send (`userName eq "alice@acme.com"`, `externalId eq "okta-123"`, `active eq "true"`); anything richer is refused with `400 invalidFilter` so connector authors stay honest. PATCH handles both Okta's whole-resource shape (`{op:"replace", value:{active:false}}`) and the path-scoped shape (`{op:"replace", path:"active", value:false}`); duplicates on create return `409 uniqueness` with a `Location` header pointing at the existing resource for idempotent retries. Every mutation (create, replace, patch, delete) writes an immutable audit entry tagged with the workspace id and the SCIM resource id, and every rejected bearer is logged as `scim.auth_denied` so a reviewer can see provisioning probes. Issue, rotate, and revoke are owner-only (`canManage` check); members see a read-only summary. Workspace hard-delete also wipes the SCIM token and the provisioned-user mirror for that workspace (`workspaces-gdpr` path) and the workspace export bundle includes the SCIM user mirror so a DPA response is one download. Try it: open `/workspaces/<ws_id>`, click **issue token** under SCIM provisioning, copy the token, then `curl -i -H "Authorization: Bearer <token>" 'http://localhost:3000/scim/v2/<ws_id>/ServiceProviderConfig'` and `curl -i -H "Authorization: Bearer <token>" -H 'content-type: application/scim+json' -X POST 'http://localhost:3000/scim/v2/<ws_id>/Users' -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"alice@acme.com","active":true}'`.

- Workspace audit retention policy at `/workspaces/<id>`: every workspace owner can cap how long old audit entries remain visible. Set a window of 1 to 3650 days under **audit retention** on the workspace page; once saved, every read path that loads workspace-scoped audit entries (the `/audit` UI, `GET /api/audit`, the CSV export, the workspace data export bundle) silently drops rows older than `now - auditDays` for that tenant. The underlying sha256 hash-chained JSONL on disk is never modified so `GET /api/audit/verify` still reports `ok: true` and SOC2 reviewers keep tamper evidence end to end; enforcement is at the access layer, which is what GDPR data minimisation actually requires. Owners can dry-run the policy from the same panel: **preview hidden** calls `POST /api/workspaces/<id>/retention/purge`, scans every day file under `CODECLONE_AUDIT_DIR`, and returns the count of affected entries, the affected day files, and the oldest and newest timestamps that would be hidden, without changing anything. Cross-tenant isolation is proven in `web/tests/workspaces-retention.test.ts` where setting a 30-day cutoff on workspace A leaves workspace B history untouched. Every save, clear, and preview writes a `workspace.retention_update` or `workspace.retention_purge_preview` entry to the audit log. Try it: `curl -i -b cc_session=... -H content-type:application/json -X PUT http://localhost:3000/api/workspaces/<ws_id>/retention -d '{"auditDays":90}'` then `curl -i -b cc_session=... -X POST http://localhost:3000/api/workspaces/<ws_id>/retention/purge`.

- Workspace session policy at `/workspaces/<id>`: every workspace owner can cap how long any member's sign-in is allowed to live (max lifetime, 5 minutes to 90 days) and how long it can sit idle before it's rejected (idle timeout, 1 minute to 30 days). Enforcement runs inside `lib/auth#currentSessionFromCookieHeader`, which is the single chokepoint every authenticated route already calls, so a tightened policy takes effect on the next request for every member, every device, without rotating cookies or signing anyone out by hand. When a user belongs to multiple workspaces the strictest non-zero value across all of them wins, so a contractor in a customer's enterprise workspace inherits that customer's cap even while signed in to their own personal tenant. The policy survives across legacy cookies that pre-date server-side session tracking (the cookie's `iat` is used in place of `lastSeenAt` and `createdAt`). `GET /api/workspaces/<id>/session-policy` returns the saved policy plus the caller's effective policy (so an admin can see when a stricter policy from another workspace is the reason they keep getting bounced) plus the bounds the UI clamps to. `PUT` saves a new policy, `DELETE` removes it; every mutation writes `workspace.session_policy_update` to the audit log with a full before/after diff. Owner-only. A regression test in `web/tests/workspaces-session-policy.test.ts` proves both the max-lifetime and the idle-timeout enforcement paths reject expired sessions before any user data is returned. Try it: open `/workspaces/<ws_id>`, scroll to **session policy**, set max lifetime to `28800` (8 hours) and idle timeout to `1800` (30 minutes), save. `curl -i -b cc_session=... -H 'content-type: application/json' -X PUT 'http://localhost:3000/api/workspaces/<ws_id>/session-policy' -d '{"maxLifetimeSec":28800,"idleTimeoutSec":1800}'`.

- Workspace-scoped webhooks at `/webhooks`: webhooks used to live in a single global pool, which meant any signed-in user could read, pause, delete, or replay any other tenant's deliveries, and any compare or batch run would fan a payload out to every customer's relay at once. Webhooks are now bound to a `workspaceId` at create time, the field is required and validated against `^ws_[A-Za-z0-9_-]{6,32}$`, and every read, mutation, delivery list, redelivery, and outbound fan-out checks workspace ownership before touching disk. `GET /api/webhooks?workspaceId=<id>` returns only that workspace's hooks; the same query param is required on `GET/PATCH/DELETE /api/webhooks/<id>`, on `GET /api/webhooks/<id>/deliveries`, on `POST /api/webhooks/<id>/deliveries/<deliveryId>/redeliver`, and on `GET /api/webhooks/recent-failures` (the in-app failure toaster now polls per workspace the user belongs to and silently no-ops when signed out). `dispatchEvent` takes a required `workspaceId` and refuses to send when it is missing or invalid, so the v1 compare and batch routes only fan out to the API key's owning workspace; cross-tenant `workspaceId` on a request returns 403 without leaking whether the webhook id exists somewhere else (`loadWebhookForWorkspace` collapses not-found and wrong-tenant into the same null). RBAC piggybacks on the existing workspace roles: owners and editors may create, pause, delete, and redeliver; viewers are read-only and get a 403 with a structured error body. Legacy records that predate the migration carry no `workspaceId` and are hidden from every workspace by default; set `CODECLONE_WEBHOOKS_ALLOW_LEGACY=1` to surface them in dev. Every mutation writes the actor's `workspaceId` into the audit entry so a compliance reviewer can filter the chain per tenant. Three regression tests in `web/tests/webhooks.test.ts` prove the isolation: `list + delete + pause are workspace-scoped` shows `WS_OTHER` cannot mutate or even see `WS`'s hooks, `dispatchEvent does NOT fan out across tenants` proves a compare-completed payload signed for tenant A is never POSTed to tenant B's URL, and `legacy records without workspaceId are hidden by default` locks the dev escape hatch behind an env var. Try it: open http://localhost:3000/webhooks (sign in first), register an endpoint, then `curl -i -b cc_session=... 'http://localhost:3000/api/webhooks?workspaceId=ws_<your-id>'` to read it, and `curl -i -b cc_session=... 'http://localhost:3000/api/webhooks?workspaceId=ws_someoneelse'` to confirm the 403.

- Sandbox `dry_run` on `POST /v1/compare` and `POST /v1/batch`: every enterprise buyer wires the API in CI before they pay, and previously a smoke-test loop would chew through their monthly plan quota and spam their webhook subscribers with junk events. The two public write endpoints now accept `?dry_run=true` (or `{ "dry_run": true }` in the JSON body) and run every validation step the live path runs (bearer auth, scope, IP allowlist, sliding-window rate limit, plan quota, payload size cap, `parseBatch`) but skip `recordUse`, `logUsage`, and `dispatchEvent`. The response includes `dry_run: true`, the real similarity output, a `would` block that names the webhook event that would have fired, and for batch the `pair_count` and `total_bytes` you would have been billed for. Responses carry `x-codeclone-dry-run: true` plus the same `X-RateLimit-*` and `x-codeclone-plan-*` headers a live call emits, so a client can read remaining budget without spending it. Auth, scope, and quota failures still return the same 401/403/429 contract on a dry run so CI smoke tests stay honest. A single audit entry tagged `v1.compare.dry_run` or `v1.batch.dry_run` is still written so security teams see the probe. Try it: `curl -i -H 'Authorization: Bearer <key>' -H 'content-type: application/json' -X POST 'http://localhost:3000/v1/compare?dry_run=true' -d '{"a":"a=1","b":"a=2"}'` and look for `x-codeclone-dry-run: true` and `"dry_run": true` in the body.

- Workspace ownership transfer at `/workspaces/<id>`: the sole-owner invariant used to mean a workspace was orphaned the moment its owner left the company, which is a hard procurement blocker for any buyer whose org charts move. Owners now hand the role to any existing member with a single click in the members list (the crown icon next to each non-owner row). The transfer is atomic at the storage layer: the target is promoted to `owner` and the previous owner is demoted to `editor` in the same write, so the workspace never has zero or two owners. `POST /api/workspaces/<id>/transfer-ownership` is the API surface, gated by three checks: the caller must be the current owner, must hold a fresh MFA step-up grant on the current session (because this is the most destructive workspace operation we expose, ranked alongside `wipe`), and must name an existing member. Self-transfer, non-member targets, and non-owner callers are refused with a 400. Every attempt writes `workspace.transfer_ownership` to the audit log with the before/after owner ids so a compliance reviewer can answer who handed the workspace to whom and when. A regression test in `web/tests/workspaces-transfer.test.ts` proves the single-owner invariant survives a transfer and that the three rejection paths fire. Try it: open `/workspaces/<ws_id>`, click the crown icon next to a teammate, confirm. `curl -X POST http://localhost:3000/api/workspaces/<ws_id>/transfer-ownership -H 'content-type: application/json' -b cc_session=... -d '{"toUserId":"<other-user-id>"}'`.

- Tamper-evident audit hash chain at `/audit` and `GET /api/audit/verify`: every audit entry now carries a per-day monotonic `seq`, a `prevHash` linking to the previous entry, and a sha256 `hash` over its own canonical JSON, so any edit, deletion, insertion, or reordering of the on-disk JSONL is detectable by an external reviewer. Verification walks every file under `CODECLONE_AUDIT_DIR` in order and returns either `ok: true` with the current head hash (which an operator can pin to a compliance mailbox or external notary), or `ok: false` with the exact day, seq, and reason (`hash_mismatch`, `prev_hash_mismatch`, `seq_out_of_order`, `invalid_json`). Legacy entries written before this feature are counted but do not break verify. Writes are serialized so concurrent `recordAudit` calls still produce a valid chain. The audit page has a **verify chain** button that surfaces the result inline, and the verification itself is audited (`audit.verify`) so a tampering attempt cannot quietly self-verify. A regression test in `web/tests/audit-chain.test.ts` proves all four tamper cases are caught. Try it: open http://localhost:3000/audit and click **verify chain**, or `curl -i -b cc_session=... http://localhost:3000/api/audit/verify`.

- Workspace domain auto-join at `/workspaces/<id>`: every workspace owner can pin one or more email domains (e.g. `acme.com`) that auto-add anyone who signs in with a matching address as either an `editor` or a `viewer`. Removes the per-seat invite friction every IT team complains about during onboarding while keeping the audit trail honest: the owner edit writes `workspace.auto_join_update` with a before/after diff, and every actual join writes `workspace.auto_join` with the role and the sign-in path (`magic_link` or `sso`). The matcher runs at sign-in time inside `/api/auth/verify` and the SSO callback, scans every workspace, and only mutates the ones whose owner explicitly listed the user's domain, so a user from `acme.com` is never added to an unrelated tenant. Workspaces that enforce SSO for the user's domain only auto-join via the SSO callback, never via a magic link, so the IdP gate is preserved. Try it: open `/workspaces/<ws_id>`, add `acme.com` under **domain auto-join**, request a magic link for `alice@acme.com`, and watch alice appear in the members list on first sign-in. `curl -X PUT http://localhost:3000/api/workspaces/<ws_id>/auto-join -H 'content-type: application/json' -b cc_session=... -d '{"domains":["acme.com"],"role":"editor"}'`.

- Cross-tenant audit log isolation at `/audit` and `GET /api/audit`: a signed-in caller now only sees audit entries from workspaces they actually belong to, plus their own null-workspace events such as sign-in and session revocation. The previous behavior let any authenticated user list every workspace's history by either omitting `workspaceId` or passing someone else's id, which is a hard blocker for procurement security review. The fix is enforced at the query layer (`listAudit` accepts an `allowedWorkspaceIds` set that filters before any row leaves disk, so an out of band caller cannot bypass the route handler) and on the route handler itself, which derives the membership set from `listWorkspacesForUser`, returns `403 forbidden` with an audited `audit.read.denied` entry when a non-member targets a specific workspace, and continues to log `audit.read` and `audit.export` on success so reading the log still leaves a trail. A regression test in `web/tests/audit.test.ts` (`audit: allowedWorkspaceIds enforces cross-tenant isolation`) writes entries for two workspaces and an out-of-band stranger, then asserts a member of one workspace cannot see the other and a non-member sees zero workspace-scoped rows. Try it: `curl -i -b cc_session=... 'http://localhost:3000/api/audit?workspaceId=<other-tenant-id>'` returns 403.

- Two-factor authentication (TOTP) for destructive actions at `/settings/security`: enroll any RFC 6238 authenticator (1Password, Authy, Google Authenticator) by scanning the otpauth QR or pasting the base32 secret, confirm with a 6-digit code, and receive ten single-use backup codes shown exactly once. Once a user is enrolled, the highest-risk endpoints refuse to run without a fresh **step-up** grant on the current session: `POST /api/settings/wipe`, `POST /api/sessions/revoke-all`, and `DELETE /api/workspaces/<id>?userId=<other>` all return HTTP 401 with `{ "error": "mfa_required" }` and a `WWW-Authenticate: MFA realm="codeclone"` header until the caller POSTs a valid code to `/api/auth/mfa/challenge`. Grants are scoped to a single session id (jti), expire after 5 minutes, and another open session never inherits them. TOTP codes are checked with a 1-step window and a replay guard (a verified step cannot be reused inside the same 30-second period); backup codes are sha-256 hashed at rest and consumed on use. Every enroll, challenge, success, failure, and disable is written to the audit log (`mfa.enroll.start`, `mfa.enroll.confirm`, `mfa.challenge.ok`, `mfa.challenge.fail`, `mfa.disable`). State lives under `CODECLONE_MFA_DIR` (defaults to `../mfa`); users without MFA are unaffected so the upgrade is non-breaking. Try it: open http://localhost:3000/settings/security, then `curl -X POST http://localhost:3000/api/auth/mfa/challenge -H 'content-type: application/json' -b cc_session=... -d '{"token":"123456"}'`.

- Per-workspace billing plans and monthly /v1 quotas at `/workspaces/<id>`: every workspace now has a billing plan (`free` = 1,000 /v1 calls/month, `pro` = 50,000, `enterprise` = unlimited) that the public `/v1/compare` and `/v1/batch` routes enforce per tenant. Two teams hosted on one codeclone install can no longer starve each other: when an API key is bound to a workspace, the limiter counts only that workspace's usage for the current calendar month, returns HTTP 429 with `Retry-After: 3600` and a structured `plan_quota_exceeded` body when the cap is hit, and emits `x-codeclone-plan`, `x-codeclone-plan-limit`, `x-codeclone-plan-remaining`, and `x-codeclone-plan-month-to-date` headers on every successful response so clients can build their own dashboards. Workspace owners switch plans inline from a three-card picker on the workspace page (non-owners see a read-only summary so they can self-diagnose a 429 during a load test); every change writes a `workspace.plan_update` entry to the audit log with the before/after diff. Legacy keys with no workspace binding fall back to the existing global `CODECLONE_FREE_TIER_MONTHLY` counter so existing deployments keep working unchanged. Try it: open `/workspaces/<ws_id>`, pick a plan, then `curl -i -H 'Authorization: Bearer <key>' -X POST http://localhost:3000/api/v1/compare -H 'content-type: application/json' -d '{"a":"a=1","b":"a=1"}'` and read the `x-codeclone-plan-*` headers in the response.

- Workspace IP allowlist: every workspace owner can pin API + dashboard access to a list of IPv4 or IPv6 CIDR ranges from `/workspaces/<id>`. When an API key is bound to a workspace, every call to `/api/v1/compare`, `/api/v1/batch`, and `/api/v1/shares` is checked against that workspace's allowlist before any work runs; non-matching IPs get a structured `403 ip_not_allowed` with the caller's IP echoed back so the on-call engineer can copy it into the rule. Loopback is always permitted so local health checks never lock the owner out, and an empty rule list means no restriction (the prior default). Every edit and every block writes an entry to the audit log (`workspace.allowlist_update`, `workspace.ip_block`) so procurement reviewers can answer who tightened the rule, when, and which IP got rejected. Try it: `curl -X PUT http://localhost:3000/api/workspaces/<ws_id>/allowlist -H 'content-type: application/json' -d '{"entries":["203.0.113.0/24"]}'`.

- Workspace data export and hard-delete (GDPR/DPA) at `/workspaces/<id>`: every workspace owner can download a single JSON bundle that contains the workspace record (members, roles, IP allowlist, SSO config with the client secret redacted), every invite (open + historical), every API key scoped to the workspace (metadata only, never the hash), and every audit log entry tagged with the workspace id, via `GET /api/workspaces/<id>/export`. A second download serves just the audit log as CSV (`?format=csv`) for procurement and DPA reviewers who want a single artifact to attach to a Data Processing Agreement response. The same page exposes a hard-delete control that permanently removes the workspace, every scoped invite, every workspace-bound API key (revoked + deleted from disk), and every member reference, gated by three independent checks: the caller must be an owner, must type the workspace slug to confirm, and must hold a fresh MFA step-up grant on the current session. `POST /api/workspaces/<id>/wipe` also supports `?dry_run=true` so a buyer's IT team can see what would be removed before pulling the trigger. Audit history is intentionally preserved on the immutable jsonl store so the deletion event itself stays attributable forever, and a test that wires up two workspaces side-by-side proves the export and delete paths never cross-contaminate tenants. Try it: `curl -OJ -b cc_session=... http://localhost:3000/api/workspaces/<ws_id>/export`.
- Single sign-on (OIDC) per workspace: every workspace owner can wire one OIDC identity provider (Google Workspace, Okta, Azure AD, Auth0, Keycloak, anything that exposes `/.well-known/openid-configuration`) from `/workspaces/<id>`. The flow uses Authorization Code + PKCE with a signed, HttpOnly state cookie carrying the verifier and nonce; the callback validates the `id_token` against the discovered JWKS (RS256 / ES256 only; `none` and `HS256` are refused), checks `iss`, `aud`, `exp`, `nonce`, and the `email_verified` claim, and enforces the configured `allowedDomain` plus Google's `hd` claim when present. Flip on **Require SSO** and codeclone refuses to send a magic link to any address on that domain: `POST /api/auth/request` returns `403 sso_required` with the workspace's start URL and the signin page redirects the user into the provider so an enterprise can guarantee every employee signs in through their IdP. Client secrets are never returned by `GET /api/workspaces/<id>/sso` (only `clientSecretSet: boolean`) and are redacted from audit diffs. Every event lands in the audit log (`workspace.sso_update`, `workspace.sso_delete`, `auth.sso_start`, `auth.sso_signin`, `auth.sso_callback`, `auth.magic_link_blocked_sso`). Try it: open `/workspaces/<ws_id>`, fill in issuer + clientId + clientSecret + allowedDomain, then `curl -i http://localhost:3000/api/auth/sso/<ws_id>/start` to see the 303 redirect to your provider.

- Active sessions & force logout at `/settings/sessions`: every sign-in now creates a server-side session record (signed cookie carries a `jti`), so users can see every device that has authenticated to their account with IP, user agent, signed-in time, last-seen time, and expiry. Revoke a single session, sign out every other device while staying logged in here, or sign out everywhere in one click — the revoked `jti` is checked on every authenticated request, so a stolen cookie stops working before its TTL expires. Session lifetime is configurable per user (1 hour to 90 days) and applied to new sign-ins. Every event writes a structured audit entry (`auth.signin`, `auth.signout`, `auth.session_revoke`, `auth.session_revoke_others`, `auth.session_revoke_all`, `auth.session_ttl_update`) so workspace owners can answer the procurement question "who signed in from where, and when did we cut them off?" Tracked sessions live on disk under `CODECLONE_SESSIONS_DIR` (defaults to `../sessions`). Legacy cookies issued before this feature stay valid until they expire.

- Commit exporter with author-email filtering, license mode (`strict | permissive_only | off`), and per-language tagging
- Preprocess pipeline: normalize, length/lang filter, exact + MinHash dedupe, train/val/test split, JSON report
- Two LoRA backends behind one `TrainBackend` protocol: `mlx` (mlx-lm) and `peft` (transformers + peft), plus mock fallback
- Streaming step metrics to `runs/<id>/metrics.jsonl`, written incrementally
- Adapter registry under `adapters/<name>/meta.json` with base, backend, recipe hash, final loss
- Eval runner: perplexity (real or proxy), mini suite pass rate, qualitative samples
- OpenAI-compatible serve: `/v1/models`, `/v1/chat/completions`, `/v1/completions`, SSE streaming, API key auth, `/healthz`, `/readyz`, `/metrics`
- Per-tenant IP allowlist on the serve API: enterprise customers can pin a tenant's API keys to a fixed set of egress networks. Set `CODECLONE_IP_ALLOWLIST="acme=10.0.0.0/8+192.0.2.5/32,beta=*"` and any request authenticated as `acme` from outside those CIDRs is rejected with HTTP 403 and a structured `ip_not_allowed` body that echoes the source IP and tenant for fast triage. IPv4 and IPv6 are both supported, the literal `tenant=*` declares an explicit any-source policy (so the audit trail shows the open policy was intentional), tenants with no entry are unrestricted (backward compatible), and `/healthz`, `/readyz`, `/health`, `/ready`, and `/metrics` are never gated so kubelet probes and Prometheus scrapes survive any misconfiguration. The middleware sits between the rate limiter and the audit log, so flood traffic is throttled before CIDRs are evaluated and every denied request is still recorded. Anonymous traffic is left to the route's own auth dependency, so the 401 path does not leak tenant policy. Honors `CODECLONE_RATELIMIT_TRUST_FORWARDED=true` to read the source IP from `X-Forwarded-For` when the service runs behind a trusted reverse proxy. Cross-tenant isolation is locked in by `services/serve/tests/test_ip_allowlist.py`.
- Recipe YAMLs (`quick`, `small`, `standard`, `full`, `python_only`, `ts_js_only`, `cuda_overnight`)
- Next.js 15 dashboard: pairs list with search + lang filter, pair detail with shiki diff viewer, datasets browse, models/adapters registry, eval grid with Recharts sparklines, serve health probe
- Interactive `/compare` page: paste two snippets, see token + shingle Jaccard, containment, shared identifiers, a side-by-side diff, a line-level alignment heatmap that flags exact and moved blocks, and an automatic clone-type verdict (Type-1 exact / Type-2 renamed / Type-3 near-miss / Type-4 semantic candidate) with rationale
- One-click `/demo` landing page: three preloaded sample pairs (rename, restyle, distinct) that hit the live `/api/compare` route on mount and render verdict, confidence, latency, scores, and diff in under a second so a first-time visitor sees the model work without typing anything
- Batch `/batch` page: up to twelve snippets in one shot, pairwise NxN similarity matrix rendered as a heatmap with click-to-inspect cells that expand to the clone-type verdict and a side-by-side diff for the selected pair (powered by `/api/batch`)
- One-click PDF report at `/api/share/<id>/pdf`: every saved `/r/<id>` page now has a **download pdf** button that streams a self-contained A4 PDF report (similarity scores with tone bars, Bellon/Roy clone classification with rationale, coverage stats, and side-by-side source excerpts up to 80 lines per file) generated server-side with `pdf-lib`. No headless Chrome needed, no external service, and the same URL works from `curl` for CI artifacts or as a one-liner in a code-review email. Filenames are stable (`codeclone-<id>.pdf`) so the same report drops into the same Slack thread on a re-run.
- Shareable result links: every `/compare` run can be saved to a public, read-only `/r/<id>` page with a dynamically rendered 1200x630 OG image (similarity score, clone label, token counts, latency, tags) that previews on Twitter, LinkedIn, Slack, and Discord, plus a copy-link button and a one-click "open in compare" entry. The OG image and twitter:summary_large_image card are generated on demand at `/r/<id>/opengraph-image` and `/r/<id>/twitter-image` via `next/og`. Snippets and scores round-trip from a versioned JSON store under `shares/` (override with `CODECLONE_SHARES_DIR`). The score is recomputed server-side at save time so the URL can't lie about similarity.
- Saved comparisons in `/history`: every share you create shows up in a browsable, paginated list with rename, tagging, JSON download, and delete. Search by title, id, language, or clone label. Filter by language, clone label (`Type-1`, `Type-2`, `Type-3`, `Type-4`, `None`), and minimum similarity score with a live range slider. Server-side pagination (25 per page) keeps the page fast even with thousands of saved runs, and the total count plus a Prev/Next pager always tells you exactly where you are. All writes go to the same on-disk store as `/r/<id>`, so links and history stay in sync.
- Programmatic history with `/v1/shares`: pull your saved comparison history from CI, dashboards, or notebooks using the same API key as `/v1/compare`. `GET /v1/shares` returns paginated summaries (id, language, clone label, similarity score, title, tags, byte counts, created timestamp) with the same `q`, `tag`, `language`, `label`, `minScore`, and `maxScore` filters as the `/history` page, plus a `next_offset` cursor for clean pagination. `GET /v1/shares/<id>` returns the full record including both snippets, alignment, and clone classification so you can render your own diff view or pipe results into code review tooling. Both endpoints require the new least-privilege `shares:read` scope: an existing `compare:write`-only key cannot read history without being rotated with the scope enabled, and a `shares:read`-only key can never call `/v1/compare`.
- Public `/v1/compare` and `/v1/batch` API with per-key auth: generate keys in the `/api-keys` page, copy-paste the curl example, call from anywhere. `/v1/batch` runs a full pairwise similarity matrix over 2 to 12 snippets in one authenticated request and fires a `batch.completed` webhook on completion. Keys are scoped to your signed-in account so one user never sees or revokes another user's keys, optionally carry a 1 to 365 day expiry (expired keys stop authenticating and are clearly badged in the UI), and now carry **least-privilege scopes** (`compare:write`, `batch:write`, `shares:read`) that you pick at creation time. Calls with a key that is missing the required scope return HTTP 403 with a structured `insufficient_scope` error, so a CI-only key can be locked to single comparisons without unlocking bulk batch. Each key shows its prefix, granted scopes, total calls, and last-used timestamp with one-click revoke, **rotate** (issue a new secret while keeping the same id, label, scopes, and usage history so dashboards and webhook integrations stay intact), and delete. Legacy keys issued before scopes shipped keep full access. Only the SHA-256 hash of each key is persisted (override the on-disk location with `CODECLONE_KEYS_DIR`).
- Outbound webhooks via `/webhooks`: register a URL, receive a real signed POST every time `/v1/compare` finishes. Each delivery retries up to three times with backoff, includes an HMAC-SHA256 signature (`X-CodeClone-Signature: t=<ts>,v1=<mac>`), and lands in a per-endpoint delivery log (last 50) you can browse from the dashboard. **Click Redeliver on any past delivery to replay that exact signed payload to the endpoint, so receiver bugs can be fixed and retested without re-running the original compare.** Replays are tagged with their source delivery id and update the same success/failure counters. Pause, resume, or delete endpoints inline. **SSRF defense in depth**: webhook URLs are validated at create time and re-checked before every delivery. Loopback (`127.0.0.0/8`, `::1`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), unique-local IPv6 (`fc00::/7`), multicast, `0.0.0.0`, IPv4-mapped IPv6, and internal-only TLDs (`.local`, `.internal`, `.lan`, `.intranet`, `.home.arpa`, `.localhost`) are all blocked, so a tenant cannot point a webhook at the cloud metadata service or your internal network. Blocked deliveries appear in the delivery log with a clear error and increment the failure counter. Override only for local dev with `CODECLONE_WEBHOOKS_ALLOW_PRIVATE=1`. Override the on-disk location with `CODECLONE_WEBHOOKS_DIR`.
- Per-key usage and quota on `/usage`: every authenticated `/v1/compare` call is logged with timestamp, key id, byte count, and latency. The page shows month-to-date calls against a free-tier cap (default 1000, override with `CODECLONE_FREE_TIER_MONTHLY`), a daily bar chart for 7/30/90 day windows, and a per-key breakdown. When the cap is hit the API returns HTTP 429 with `Retry-After` and a structured `quota_exceeded` error, and every 200 response carries `x-codeclone-quota-limit` and `x-codeclone-quota-remaining` headers so clients can rate-limit themselves.
- Per-key rate limiting on every `/v1` endpoint: each API key carries an optional requests-per-minute cap (default 60, configurable 1 to 100000) enforced by a sliding 60-second window. Every authenticated call to `/v1/compare`, `/v1/batch`, `/v1/shares`, and `/v1/shares/{id}` returns the standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Policy` headers so clients can implement adaptive backoff without guessing. Once a key exceeds its limit the next call returns HTTP 429 with a `Retry-After` header in seconds and a structured `rate_limited` error body that includes the limit and retry interval. Owners set or change the limit per key from `/api-keys` (an inline gauge button shows the current value and opens a prompt to change it) or by passing `rpm` at creation time. Limit changes write an `api_key.update_rate_limit` entry to the audit log with the before/after value. The counter store lives under `CODECLONE_RATELIMIT_DIR` (defaults to `../rate-limit`) so quotas survive `next dev` reloads and stay readable for ops without an external Redis.
- Account `/settings`: pick a default language and clone threshold, set retention, toggle alerts, download every share and key record as one JSON file (GDPR export), and wipe everything from a confirmed danger-zone action. Preferences are persisted to a versioned JSON store at `CODECLONE_SETTINGS_FILE` (defaults to `../settings.json`).
- Snippets library at `/snippets`: save the code you keep comparing against (canonical implementations, suspected sources, internal templates) as titled, tagged, language-typed snippets. One click loads any snippet into the left or right pane of `/compare`, so returning users skip the copy-paste step. Backed by a per-user JSON store at `CODECLONE_SNIPPETS_DIR` (defaults to `../snippets`) with full CRUD, search across title, body, and tags, and a 64KB-per-snippet cap.
- Collections at `/collections`: group any number of saved `/r/<id>` comparisons under a single title and ship one public URL (`/c/<id>`) you can hand a teammate. Browse with live search (title + description), sort by last updated, created, title, or item count (asc/desc), and paginate through 20 at a time. Build a collection from the dropdown on any share page, or paste `/r/<id>` URLs straight into the manage view. Rename, edit description, remove items, or delete the whole collection inline. Public view is read-only, deleted shares are flagged inline (no broken links), and everything persists as one JSON per collection at `CODECLONE_COLLECTIONS_DIR` (defaults to `../collections`). The list endpoint accepts `?q=`, `?sort=updated|created|title|count`, `?dir=asc|desc`, `?limit=`, `?offset=`.
- Team workspaces at `/workspaces`: create a workspace, invite teammates by email with a role of `editor` or `viewer`, and accept via a signed `/workspaces/invite/<token>` link. Owners change roles and remove members; editors can also send invites; viewers are read-only. Invite tokens are single-use, expire in 14 days, and only the SHA-256 hash is persisted. Workspaces, the userId->workspace index, and pending invites live under `CODECLONE_WORKSPACES_DIR` (defaults to `../workspaces`). Sole-owner demotion and self-removal of the last owner are refused.
- Mobile-responsive shell: at 375px the dashboard collapses its 18 nav items behind an accessible hamburger that opens a left-side drawer with route-aware highlighting, focus-trap close on Escape, body-scroll lock, and a backdrop tap-to-dismiss. The top status strip becomes horizontally scrollable, the page gutter tightens from 28px to 16px, and the desktop nav re-emerges at `lg` (1024px+). Every existing page (compare, history, batch, api-keys, webhooks, usage, workspaces, settings) is now reachable on a phone without horizontal scroll on the chrome.
- Enterprise audit log at `/audit`: every mutating action across snippets, collections, API keys, webhooks, workspaces, shares, settings, notifications, onboarding, sign-in/out, public `/v1/compare` and `/v1/batch` API calls, and the internal `/api/compare` and `/api/batch` runs is recorded with actor id, actor email, IP, request id, user agent, optional workspace id, and a trimmed before/after diff. Storage is append-only JSONL by UTC day under `CODECLONE_AUDIT_DIR` (defaults to `../audit`); the app never updates or deletes entries. The page filters by action prefix, actor, workspace, and status (ok/denied/error), and a single click streams a CSV export. Denied permission checks (for example a non-owner trying to rename a workspace) are recorded alongside successes so security review can prove enforcement, not just intent. Reading and exporting the log are themselves audited.
- Observability for ops teams at `/status`: every API request goes through a Next.js middleware that assigns a 16-char `X-Request-Id` (or reuses the one a load balancer already set), echoes it on the response, and threads it into the audit log so a customer can hand support one id and get back the full request trail. A `/api/metrics` endpoint emits Prometheus text format 0.0.4 (counters for `codeclone_http_requests_total{method,route,status}`, an in-flight gauge, and an `codeclone_http_request_duration_ms` histogram with 11 buckets from 5ms to 10s), `/api/healthz` is a dependency-free liveness probe, and `/api/readyz` returns 200 with a structured `checks` array only when the on-disk stores (runs, audit, users) are writable; the inference backend is reported but does not hard-fail readiness so the dashboard can still serve auth/docs when serve is down. The `/status` page renders the same numbers as a live tile grid plus a sortable by-route latency table (count, avg, p50, p95) that refreshes every 5 seconds. Route labels are normalized so ids never blow up Prometheus cardinality. Structured one-line JSON logs (level, ts, route, method, status, duration_ms, request_id) are emitted for every instrumented handler so they pipe straight into Datadog, Loki, or CloudWatch without a parser.
- Interactive API reference at `/docs`: every public `/v1` endpoint (`POST /v1/compare`, `POST /v1/batch`, `GET /v1/shares`, `GET /v1/shares/{id}`) is documented in-product with method, path, required scope, parameter table, copy-paste curl example, and a sample JSON response. The page also includes a **Try it** panel that posts the request straight from the browser using your pasted API key, shows the HTTP status, round-trip latency, and pretty-printed response body, and warns you when none of your saved keys carry the scope an endpoint requires. The spec is driven from a single typed module (`web/lib/api-spec.ts`) that the test suite validates against the real route files, so the docs cannot drift from the implementation.

- Workspace legal hold on `/workspaces/<id>`: owners can place a named legal hold (with required reason and optional case reference) on any workspace they own. While the hold is active, every destructive workspace operation refuses with HTTP 409 and a structured `legal_hold` error: the wipe endpoint (including its dry-run preview), the retention policy endpoint when an owner tries to shorten or clear the audit window, and the retention `DELETE`. Both placing and releasing the hold require owner role plus an MFA step-up; release additionally requires typing the workspace slug as confirmation. Every placement, release, and blocked destructive attempt is written to the tamper-evident audit chain with actor, IP, and case reference, so a workspace produces a defensible preservation timeline for litigation, regulator, or DPA review. There is no force override. Cross-tenant safe: a hold on workspace A never gates operations on workspace B.

### Try it: place a legal hold on a workspace

Sign in as the owner of a workspace, open `/workspaces/<id>`, scroll to the Legal hold card, enter a reason (and optional case reference such as `LIT-2026-001`), and confirm. Verify the hold from the API and observe that wipe and retention shortening are now refused:

```bash
cd web && npm run dev

# Read the current hold (any member).
curl -s http://localhost:3000/api/workspaces/WS_ID/legal-hold -b cookies.txt

# Place the hold (owner + MFA step-up required).
curl -s -X POST http://localhost:3000/api/workspaces/WS_ID/legal-hold \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"reason":"pending litigation","caseRef":"LIT-2026-001"}'

# Destructive ops now return 409 legal_hold:
curl -s -X POST http://localhost:3000/api/workspaces/WS_ID/wipe \
  -H 'Content-Type: application/json' -b cookies.txt -d '{"confirm":"WS_SLUG"}'

# Release requires the slug as confirmation.
curl -s -X DELETE http://localhost:3000/api/workspaces/WS_ID/legal-hold \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"confirm":"WS_SLUG"}'
```

- Workspace IP allowlist on `/workspaces/<id>`: workspace owners can paste a list of corporate egress CIDRs (IPv4 and IPv6, bare IPs treated as `/32` and `/128`) to gate every public `/v1` API call made with a key bound to that workspace. Empty list means open; loopback is always permitted so on-host health probes do not lock the owner out. Every `PUT` writes a structured audit entry with the full before/after CIDR set; every blocked call writes a `workspace.ip_block` audit entry with the offending IP, the api-key id, and the rule count, so security teams can prove enforcement during procurement review. Enforced uniformly across `POST /v1/compare`, `POST /v1/batch`, `GET /v1/shares`, and `GET /v1/shares/{id}`; the dashboard editor validates and dedupes CIDRs client-side and surfaces server-side rejects.

### Try it: lock a workspace down to your office IP

Sign in, open `/workspaces`, create or pick a workspace you own, scroll to the IP allowlist card, paste a CIDR per line (for example `203.0.113.0/24`), and save. Then mint an API key scoped to that workspace and watch a request from any other IP return 403:

```bash
cd web && npm run dev

# As workspace owner: set the allowlist.
curl -s -X PUT http://localhost:3000/api/workspaces/WS_ID/allowlist \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"entries":["203.0.113.0/24","2001:db8::/32"]}' | jq

# As the API caller: simulate a request from a blocked IP.
curl -s -i -X POST http://localhost:3000/api/v1/compare \
  -H 'Authorization: Bearer cck_live_...' \
  -H 'X-Forwarded-For: 198.51.100.42' \
  -H 'Content-Type: application/json' \
  -d '{"a":"def f():pass","b":"def g():pass"}'
# => HTTP/1.1 403 Forbidden
# {"error":{"type":"ip_not_allowed",...}}
```

The block is recorded under `workspace.ip_block` in `/audit`, with the api-key id, the rejected IP, and the active rule count.

### Try it: enforce a per-key rate limit

With a signed-in account and an API key (see `/api-keys`), set the key's limit to a very small value and watch the next call return 429:

```bash
cd web && npm run dev

# Set the key to 2 requests per minute (replace KEY_ID).
curl -s -X PUT http://localhost:3000/api/api-keys/KEY_ID \
  -H "Content-Type: application/json" \
  -b "cc_session=YOUR_SESSION_COOKIE" \
  -d '{"rpm": 2}'

# Hit /v1/compare three times in a row. The third call returns 429 with
# Retry-After and full X-RateLimit-* headers.
for i in 1 2 3; do
  curl -i -s -X POST http://localhost:3000/v1/compare \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"a":"def f(x):\n  return x\n","b":"def g(y):\n  return y\n"}' \
    | head -1
done
```

Clear the override at any time by sending `{"rpm": null}` to the same endpoint, which falls back to the default 60 rpm.

### Try it: list active sessions and force a logout

Sign in once (visit `/signin` and open the magic link in the dev mailbox under `runs/magic-links/`), then with the resulting `cc_session` cookie:

```bash
cd web && npm run dev
# in another terminal, after signing in at http://localhost:3000/signin
curl -s http://localhost:3000/api/sessions \
  -H "cookie: cc_session=$CC_SESSION" | jq

# Sign every other device out but stay logged in here
curl -s -X POST http://localhost:3000/api/sessions/revoke-all \
  -H "cookie: cc_session=$CC_SESSION" \
  -H "content-type: application/json" \
  -d '{"includeCurrent":false}'
```

Open `http://localhost:3000/settings/sessions` for the UI version with per-device revoke, session-lifetime presets, and a one-click "sign out everywhere" that ends every cookie immediately.

### Try it: scrape Prometheus metrics and check liveness

```bash
cd web && npm run dev
# in another terminal
curl -sf http://localhost:3000/api/healthz | jq
curl -sf http://localhost:3000/api/readyz  | jq
curl -s  http://localhost:3000/api/metrics | head -20
```

Open `http://localhost:3000/status` for the live dashboard. Every response carries an `X-Request-Id` header you can paste into the audit log filter to trace one request end to end.

### Try it: download a PDF report of a saved comparison

1. `cd web && npm install && npm run dev`, then run a compare at [http://localhost:3000/compare](http://localhost:3000/compare) and click **Save** to get a `/r/<id>` URL.
2. Visit `http://localhost:3000/r/<id>` and click **download pdf**, or pull it from the command line:
   ```bash
   curl -OJ http://localhost:3000/api/share/<id>/pdf
   ```
3. Open the resulting `codeclone-<id>.pdf` to see the full clone-analysis report.

### Try it: review the enterprise audit log

1. `cd web && npm install && npm run dev`, then sign in at [http://localhost:3000/signin](http://localhost:3000/signin).
2. Do anything that mutates state: create a snippet at `/snippets`, rotate a key at `/api-keys`, rename a workspace at `/workspaces/<id>`.
3. Open [http://localhost:3000/audit](http://localhost:3000/audit) and the action will be there with actor email, IP, and a before/after diff. Filter to `api_key.` to see only key activity, or click **csv** to export.
4. From the command line, while signed in (replace `<cookie>` with your `cc_session` cookie):
   ```bash
   curl -s -H "cookie: cc_session=<cookie>" \
     "http://localhost:3000/api/audit?action=api_key.&status=ok&limit=50" | jq
   ```

### Try it: explore the v1 API from the dashboard

1. `cd web && npm install && npm run dev`, sign in at [http://localhost:3000/signin](http://localhost:3000/signin), and create a key at [http://localhost:3000/api-keys](http://localhost:3000/api-keys) with the `compare:write` scope.
2. Open [http://localhost:3000/docs](http://localhost:3000/docs), paste the `cc_live_...` value into the API key field (it stays in your browser only), expand `POST /v1/compare`, edit the sample body if you like, and click **send request** to see status, latency, and the live JSON response.
3. Or skip the UI and run it straight from a terminal:
   ```bash
   curl -sS http://localhost:3000/v1/compare \
     -H "Authorization: Bearer $CODECLONE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"a":"def add(a,b):\n    return a+b\n","b":"def sum_two(x,y):\n    return x+y\n","language":"python"}'
   ```

### Try it: pull your saved comparisons over the API

1. `cd web && npm install && npm run dev`, sign in at [http://localhost:3000/signin](http://localhost:3000/signin) with the dev magic link.
2. Open [http://localhost:3000/api-keys](http://localhost:3000/api-keys), click **new key**, check **shares** (and **compare** if you also want to seed data from the API), and copy the printed `cc_live_...` secret.
3. Save a few comparisons via [http://localhost:3000/compare](http://localhost:3000/compare) so there is history to read.
4. List them:

   ```bash
   curl -s http://localhost:3000/api/v1/shares?limit=10 \
     -H "Authorization: Bearer $CODECLONE_API_KEY" | jq .
   ```

5. Fetch one in full (snippets, alignment, clone label):

   ```bash
   curl -s http://localhost:3000/api/v1/shares/<id> \
     -H "Authorization: Bearer $CODECLONE_API_KEY" | jq .
   ```

6. A key without the `shares:read` scope gets HTTP 403 with `insufficient_scope`. Rotate it from `/api-keys` to add the scope without changing the id or label.

### Try it: invite a teammate to a workspace

1. `cd web && npm install && npm run dev`, sign in at [http://localhost:3000/signin](http://localhost:3000/signin) with your email and click the dev magic link.
2. Open [http://localhost:3000/workspaces](http://localhost:3000/workspaces), click **new workspace**, name it (e.g. `Backend platform`).
3. On the workspace page, enter a teammate email, pick `editor` or `viewer`, click **send invite**. Copy the printed invite URL.
4. Open the URL in an incognito window, sign in as the invited email, and click **accept invite**. The new member shows up immediately on the workspace page.
5. Programmatic:

   ```bash
   # As an authenticated owner (cookie required):
   curl -X POST http://localhost:3000/api/workspaces \
     -H 'Content-Type: application/json' -b "$COOKIE_JAR" \
     -d '{"name":"Backend platform"}'

   curl -X POST http://localhost:3000/api/workspaces/<wsId>/invites \
     -H 'Content-Type: application/json' -b "$COOKIE_JAR" \
     -d '{"email":"teammate@example.com","role":"editor"}'
   ```


### Try it: ship a collection of duplicates

1. `cd web && npm install && npm run dev`, then create a couple of comparisons via [http://localhost:3000/compare](http://localhost:3000/compare) and click **Save** on each so they get `/r/<id>` URLs.
2. Open [http://localhost:3000/collections](http://localhost:3000/collections), click **new collection**, give it a title like `Sprint 14 duplicates`, then open it.
3. Either click **add to collection** on each `/r/<id>` page, or paste `/r/<id>` URLs into the manage view.
4. Open `/c/<id>` in an incognito window. That public URL is what you send to your teammate.
5. Or hit the API directly:

```bash
# create
curl -s -X POST http://localhost:3000/api/collections \
  -H 'content-type: application/json' \
  -d '{"title":"Sprint 14 dupes","description":"refactor candidates"}'

# add a share to it
curl -s -X POST http://localhost:3000/api/collections/<collectionId>/items \
  -H 'content-type: application/json' \
  -d '{"shareId":"<shareId>"}'

# public read
curl -s http://localhost:3000/api/collections/<collectionId>
```


### Try it: build a reusable snippet library

1. `cd web && npm install && npm run dev`, then visit [http://localhost:3000/signin](http://localhost:3000/signin) and sign in (any email works in dev).
2. Open [http://localhost:3000/snippets](http://localhost:3000/snippets), click **New snippet**, paste a canonical implementation, set a language, tag it `baseline`, and save.
3. From the snippet card, click **Left** or **Right** to load it into `/compare` and run a similarity check against fresh code.
4. Or hit the API directly:

```bash
curl -X POST http://localhost:3000/api/snippets \
  -H "Content-Type: application/json" \
  -H "Cookie: cc_session=<your session cookie>" \
  -d '{
    "title": "Canonical quicksort",
    "language": "python",
    "body": "def qs(a):\n    if len(a) <= 1: return a\n    p = a[0]\n    return qs([x for x in a[1:] if x < p]) + [p] + qs([x for x in a[1:] if x >= p])\n",
    "tags": ["baseline", "sorting"]
  }'
```
- Email magic-link sign-in at `/signin`: stateless HMAC session cookies, one-shot tokens with 15-minute expiry, and a user menu in the nav. Dev mode shows the link inline so you can complete the loop locally without an SMTP provider; production swaps in a real mailer. Users persist on disk under `CODECLONE_USERS_DIR` (defaults to `../users`), keyed by a deterministic id derived from the lowercased email. Set `CODECLONE_AUTH_SECRET` in production. Routes: `POST /api/auth/request`, `GET /api/auth/verify`, `GET /api/auth/me`, `POST /api/auth/signout`.
- First-run `/welcome`: a 3-step onboarding flow (create API key, run a comparison, save to history) with a live progress bar and a thin banner that sits under the nav on every page until you finish or dismiss. Step completion is derived from real state on disk (active API keys, a saved share, a `compared` event), so the checklist cannot lie. Override the persisted dismiss/finished state with `CODECLONE_ONBOARDING_FILE` (defaults to `../.onboarding.json`). The welcome page also has a **Load sample comparisons** action that seeds three real shares (near-duplicate, partial overlap, distinct) into history through the live scorer so the app is never empty on a first visit; **Remove samples** cleans them up and only touches shares tagged `sample`.
- Persistent notifications inbox at `/notifications`: per-user activity log for share creations and batch completions, with a bell badge in the top bar that polls unread count every 30 seconds. Filter all/unread, mark read or unread, dismiss, mark-all-read, clear. Stored as one JSON-lines file per user under `CODECLONE_NOTIFICATIONS_DIR` (defaults to `../runs/notifications`), capped at 200 records per user. Routes: `GET /api/notifications`, `POST /api/notifications` (`mark-all-read`/`clear`), `PATCH /api/notifications/<id>`, `DELETE /api/notifications/<id>`. Emission is best-effort, so an inbox write failure never breaks the originating action.
- In-app notification toasts wired to the existing settings prefs: when `notifyOnCompareCompleted` is on, any comparison that takes longer than 2 seconds drops a success toast with the verdict and elapsed time. When `notifyOnWebhookFailure` is on, every page polls `/api/webhooks/recent-failures` every 20 seconds (while the tab is visible) and surfaces fresh failed deliveries as an error toast with a one-click jump to the per-endpoint delivery log. Toasts are dismissable, screen-reader friendly (`aria-live=polite`, `role=alert` for errors), bottom-right on desktop, bottom-center on mobile.

### Try it: filter and paginate your history

Once you have a few saved comparisons, `/history` lets you narrow down without scrolling. Pick a language, a clone label, drag the min-similarity slider, and the page asks the server for just that slice with pagination so it never loads more than 25 records at a time.

```bash
# Start the dashboard
cd web && npm install && npm run dev
# Page two of all python near-misses with similarity >= 60%, in JSON.
curl -s 'http://localhost:3000/api/share?language=python&label=Type-3&minScore=0.6&offset=25&limit=25' | jq '.total, (.items | length), .facets.languages'
```

Response shape: `{ items, count, total, offset, limit, facets: { languages, cloneLabels } }`. Facets are computed across every saved share, not just the current page, so the dropdowns always show every language and label you have on disk with their counts.

### Try it: get notified when a long compare finishes

1. Open `/settings`, tick "In-app toast when a long compare finishes", save.
2. Open `/compare`, paste two big snippets, hit compare.
3. Any run over two seconds shows a toast in the bottom-right with the elapsed time and verdict. Webhook delivery failures (when you have any registered hooks) appear as red toasts with a link to `/webhooks`.

### Try it: your notifications inbox

The in-app toaster is good for the moment something happens. The new `/notifications` page is the persistent record. Every save to `/r/<id>` and every batch run lands in the signed-in user's inbox with a deep link, a kind tag, and an unread badge. A bell in the top bar polls the unread count every 30 seconds.

```bash
# Start the dashboard
cd web && npm install && npm run dev
# In another shell, after signing in at http://localhost:3000/signin and copying your cc_session cookie:
curl -s http://localhost:3000/api/notifications \
  -H 'cookie: cc_session=<paste-your-cookie>' | jq
# Mark everything read
curl -s -X POST http://localhost:3000/api/notifications \
  -H 'content-type: application/json' \
  -H 'cookie: cc_session=<paste-your-cookie>' \
  -d '{"action":"mark-all-read"}'
```

Storage: one JSON-lines file per user under `CODECLONE_NOTIFICATIONS_DIR` (defaults to `../runs/notifications`). Capped at 200 per user. Emission is best-effort, so a notification write failure can never break the originating action.

```bash
# The aggregator endpoint that powers the failure toasts:
curl -s 'http://localhost:3000/api/webhooks/recent-failures?limit=5'
```

### Try it: sign in with a magic link

```bash
cd web && npm run dev                                # http://localhost:3000/signin

# Request a sign-in link. In dev (no CODECLONE_AUTH_SECRET set, or
# CODECLONE_AUTH_DEV=1) the response includes `devLink` so you can
# click straight through without an email provider.
curl -sS http://localhost:3000/api/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}' | jq

# The magic link is also printed to the dev-server stderr. Open it in
# your browser; you land back at `/` with the session cookie set, and
# the nav now shows your email with a sign-out menu.
curl -sS -b 'cc_session=...' http://localhost:3000/api/auth/me | jq
```

### Try it: walk through the welcome flow

```bash
cd web && npm run dev                                # http://localhost:3000/welcome

# 1. Open /welcome to see step 1 of 3 ("create your first API key").
# 2. Inspect the current state from the same JSON the UI reads:
curl -sS http://localhost:3000/api/onboarding | jq

# 3. After you create a key, run a compare, and save a share, the same
#    endpoint reports completed: 3 and stamps finishedAt.

# Seed three real sample comparisons into history (idempotent):
curl -sS -X POST http://localhost:3000/api/onboarding \
  -H 'content-type: application/json' \
  -d '{"action":"seed-samples"}' | jq .seeded

# Browse them at /history?tag=sample and remove with:
curl -sS -X POST http://localhost:3000/api/onboarding \
  -H 'content-type: application/json' \
  -d '{"action":"clear-samples"}' | jq .cleared
```

### Try it: watch usage in real time

```bash
cd web && npm run dev                                # http://localhost:3000/usage

# 1. In /api-keys, create a key and copy the plaintext shown once.
# 2. Hit /v1/compare a few times; /usage refreshes every 30s.
curl -sS http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $CODECLONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"a":"def add(a,b):\n  return a+b\n","b":"def sum(x,y):\n  return x+y\n","language":"python"}' -D -

# Inspect the JSON aggregate directly:
curl -sS http://localhost:3000/api/usage?days=30 | jq .

# Stripe-style recent calls log (newest first, last 7 days):
curl -sS 'http://localhost:3000/api/usage/recent?limit=20&days=7' | jq .
```

The `/usage` page now shows a **per-endpoint breakdown** (calls, average latency, total bytes in) and a live **Recent API calls** log that auto-refreshes every 15 seconds, so you can watch traffic land the moment your client hits `/v1/compare`, `/v1/batch`, or `/v1/shares`.

### Try it: see the OG share card

```bash
cd web && npm run dev

# 1. Create a share from /compare (Save button) and grab the id from the URL.
# 2. Open the rendered PNG directly:
open "http://localhost:3000/r/<id>/opengraph-image"

# 3. Validate the page metadata that Twitter/LinkedIn read:
curl -sS http://localhost:3000/r/<id> | grep -E 'og:image|twitter:card|twitter:image'
```

### Try it: receive a webhook locally

```bash
cd web && npm run dev                                # http://localhost:3000/webhooks
npx -y --package=http-echo-server http-echo-server 4567   # any logging receiver works

# 1. In the dashboard, register https://localhost:4567 (or your tunnel URL) and copy the secret shown once.
# 2. Trigger a compare with an API key:
curl -sS -X POST http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $CODECLONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"a":"def add(a,b):\n return a+b\n","b":"def sum(x,y):\n return x+y\n","language":"python"}'

# 3. Watch the delivery land in your receiver and in /webhooks (success count + latency).
# 4. Kill the receiver, fire one more compare so the delivery fails, then restart the receiver.
# 5. Expand the webhook row in /webhooks and click Redeliver on the failed delivery.
#    The exact same signed payload (X-CodeClone-Signature, X-CodeClone-Hash, body bytes)
#    is reposted; the new row is tagged `replay` and links back to the source delivery id.
#    Or call the endpoint directly:
curl -sS -X POST http://localhost:3000/api/webhooks/$WEBHOOK_ID/deliveries/$DELIVERY_ID/redeliver
```

### Try it: manage account settings

```bash
cd web && npm run dev      # http://localhost:3000/settings

# read current preferences
curl -s http://localhost:3000/api/settings | jq

# patch defaults
curl -s -X PATCH http://localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"defaultLanguage":"python","cloneThreshold":0.75,"notifyOnCompareCompleted":true}' | jq

# download a full GDPR-style export of shares, api key metadata, and webhooks
curl -sOJ http://localhost:3000/api/settings/export

# wipe everything (requires explicit confirm phrase)
curl -s -X POST http://localhost:3000/api/settings/wipe \
  -H 'content-type: application/json' \
  -d '{"confirm":"delete everything"}' | jq
```

### Try it: call the public API

```bash
cd web && npm run dev      # http://localhost:3000/api-keys

# 1. Create a key in the UI, copy the plaintext (shown once)
# 2. Compare two snippets with that key:
curl -sS -X POST http://localhost:3000/v1/compare \
  -H "Authorization: Bearer $CODECLONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "a": "def add(a,b):\n    return a+b\n",
    "b": "def sum(x,y):\n    return x+y\n",
    "language": "python"
  }' | jq '.clone.label, .scores.shingleJaccard'
# -> "Type-2 clone (renamed)"
# -> 0.176
```

### Try it: bulk compare via /v1/batch

```bash
cd web && npm run dev      # http://localhost:3000/api-keys

# Send 2-12 snippets in one authenticated call. Returns a full pairwise
# similarity matrix plus per-pair clone classifications. Counts as one
# request against the free-tier quota and fires a 'batch.completed'
# webhook event.
curl -sS -X POST http://localhost:3000/v1/batch \
  -H "Authorization: Bearer $CODECLONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "python",
    "snippets": [
      {"id":"a","code":"def add(a,b):\n    return a+b\n"},
      {"id":"b","code":"def sum(x,y):\n    return x+y\n"},
      {"id":"c","code":"def mul(a,b):\n    return a*b\n"}
    ]
  }' | jq '.n, .matrix, .cells[0].clone.type'
# -> 3
# -> [[1,0.17,0.08],[0.17,1,0.07],[0.08,0.07,1]]
# -> "type-2"

# Discover endpoints:
curl -sS http://localhost:3000/v1| jq .endpoints
```

Limits: at most 12 snippets, 32 KiB per snippet, 192 KiB total. Quota headers (`x-codeclone-quota-limit`, `x-codeclone-quota-remaining`) and the same `quota_exceeded` 429 contract as `/v1/compare`.

### Try it: share a comparison

```bash
cd web && npm run dev      # http://localhost:3000/compare

# save a result and get a public link
curl -s -X POST http://localhost:3000/api/share \
  -H 'content-type: application/json' \
  -d '{"a":"function add(a,b){return a+b}","b":"function sum(x,y){return x+y}","language":"javascript"}'
# -> {"id":"JRe9kkq8kcY3","url":"/r/JRe9kkq8kcY3"}

# fetch it back
curl -s http://localhost:3000/api/share/JRe9kkq8kcY3 | jq .result.clone.label
# -> "Type-2 clone (renamed)"

# open the public page in a browser
open http://localhost:3000/r/JRe9kkq8kcY3
```

Smoke test: `node web/scripts/test-share.mjs` boots `next dev` against a temp shares dir and round-trips create / read / render / 404 / 400.

### Try it: history, rename, tag, delete

```bash
cd web && pnpm dev          # http://localhost:3000/history

# list every saved comparison (newest first)
curl -s 'http://localhost:3000/api/share?limit=20' | jq '.items[] | {id,title,tags,cloneLabel}'

# rename and tag
curl -s -X PATCH http://localhost:3000/api/share/JRe9kkq8kcY3 \
  -H 'content-type: application/json' \
  -d '{"title":"add vs sum","tags":["javascript","renamed-vars"]}'

# download the full record as JSON
curl -s http://localhost:3000/api/share/JRe9kkq8kcY3 -o codeclone-JRe9kkq8kcY3.json

# delete
curl -s -X DELETE http://localhost:3000/api/share/JRe9kkq8kcY3
```

Unit test: `cd web && pnpm test` runs `node --test --experimental-strip-types tests/share.test.ts` against a temp `CODECLONE_SHARES_DIR` and round-trips create / load / update / list / delete plus input validation.

### Try it: bulk-export your history as CSV or JSON

One-click export of every saved comparison, with the same search and tag filters as the `/history` page. Useful for spreadsheets, BI tools, or seeding a downstream pipeline.

```bash
cd web && pnpm dev          # then click "export csv" / "export json" in the /history toolbar

# all history as CSV (id, created_at, title, language, clone_label, jaccard, bytes_a, bytes_b, tags, url)
curl -sS -OJ 'http://localhost:3000/api/share/export?format=csv'

# filter by tag and search, just like the UI
curl -sS -OJ 'http://localhost:3000/api/share/export?format=json&tag=renamed-vars&q=adders'
```

Response sets `Content-Disposition: attachment; filename="codeclone-history-<ts>.<ext>"` and `X-Codeclone-Export-Count` so scripts can verify the row count without parsing the body. Covered by `tests/share-export.test.ts`.

### Try it: re-run a saved comparison

Every saved comparison in `/history` gets a one-click **re-run** button. It opens `/compare?from=<shareId>`, prefills both editors and the language picker from the stored share, and fires a fresh comparison automatically. Useful for seeing how a tweak to either snippet moves the score, or for replaying yesterday's result against a newer model.

```bash
cd web && pnpm dev          # http://localhost:3000/history

# pick any share id from history, then re-run it directly:
open 'http://localhost:3000/compare?from=JRe9kkq8kcY3'

# the page is wired to /api/share/<id>, which returns the full record:
curl -s http://localhost:3000/api/share/JRe9kkq8kcY3 \
  | jq '{id,language,a_bytes:(.a|length),b_bytes:(.b|length)}'
```

A banner at the top of `/compare` shows which saved comparison the run was loaded from, with a dismiss button. The round-trip contract (snippets + language survive create -> load) is locked down by `tests/share-rerun.test.ts`.
- Prometheus metrics, OTEL hooks, structlog JSON logs

## Stack

- Python 3.10-3.12, Typer CLI, Pydantic v2, FastAPI + uvicorn + sse-starlette
- MLX / mlx-lm (Apple Silicon) or PyTorch + transformers + peft + accelerate (+ bitsandbytes off-darwin)
- datasets, huggingface-hub, GitPython, unidiff, PyGithub, tiktoken, tokenizers
- structlog, prometheus-client, opentelemetry-sdk
- Web: Next.js 15.1 (App Router), React 19, Tailwind v4 (`@tailwindcss/postcss`), SWR 2, Recharts 2, shiki, Phosphor icons
- Hatchling build, ruff, mypy, pytest

## Architecture

Monorepo of small Python packages plus a Next.js app. The CLI orchestrates; services do one thing each; shared schemas and the registry live in `packages/`. Data flows in one direction.

```
GitHub repos
    │  (exporter: GitPython + PyGithub, author-email filter)
    ▼
data/raw/pairs.jsonl
    │  (preprocess: normalize, filter, dedupe, split)
    ▼
data/processed/{train,val,test}.jsonl
    │  (trainer: MLX or PEFT backend, streams metrics)
    ▼
adapters/<name>/  ──►  packages/models registry  ──►  eval runs/<id>/
    │
    ▼
codeclone serve (FastAPI, OpenAI-compatible)
    ▲
    │  REST + SSE
web/ (Next.js dashboard: pairs, datasets, models, eval)
```

See `docs/architecture.md` for the long version.

## Quick start

Python 3.10-3.12 required.

```bash
# Clone + venv
git clone https://github.com/Sanjays2402/codeclone && cd codeclone
uv venv && source .venv/bin/activate

# Pick a backend
uv pip install -e ".[mlx]"     # Apple Silicon
uv pip install -e ".[cuda]"    # Linux + CUDA (also works CPU-only)
uv pip install -e ".[dev]"     # tests + lint

cp .env.example .env           # set GITHUB_TOKEN, AUTHOR_EMAIL

# End-to-end
codeclone export    --user yourname --out data/raw/pairs.jsonl
codeclone preprocess --in data/raw/pairs.jsonl --out data/processed --recipe recipes/small.yaml
codeclone train      --recipe recipes/small.yaml --data data/processed --out adapters/adapter-v1
codeclone eval       --model adapters/adapter-v1 --data data/processed/test.jsonl
codeclone serve      --model adapters/adapter-v1 --port 7461
```

Backend choice (mlx vs peft) is covered in `docs/backends.md`. Default is `auto`: mlx on darwin/arm64, peft otherwise.

Web dashboard:

```bash
cd web
npm install
npm run dev          # http://localhost:3000, expects serve on :7461
```

Set `CODECLONE_SERVE_URL` if serve is elsewhere.

### Try it: interactive compare page

The dashboard ships a `/compare` page that takes two code snippets, a language
picker, and reports three real similarity scores (5-gram shingle Jaccard,
token Jaccard, and containment), a side-by-side diff, a line-alignment
heatmap, and a clone-type classifier that labels the pair as Type-1 (exact
modulo whitespace and comments), Type-2 (renamed identifiers, same
structure), Type-3 (near-miss with edits), Type-4 (semantic candidate), or
none. The classifier compares the raw token Jaccard against a structural
4-gram Jaccard computed on identifier-anonymized tokens, and surfaces a
short rationale so the verdict is auditable. Three preloaded samples
(renamed-variable near-duplicate, restyled algorithm, distinct functions
with shared vocabulary) let a first-time visitor see results in one click.
The same JSON is available over HTTP:

```bash
curl -s http://localhost:3000/api/compare \
  -H 'content-type: application/json' \
  -d '{"a":"def add(a,b):\n  return a+b","b":"def sum(x,y):\n  return x+y","language":"python"}'
```

Scoring uses the same whitespace normalization and 5-character shingling the
offline dedupe pipeline uses in `packages/dataset/codeclone_dataset/dedupe.py`,
so dashboard scores match what the preprocessor sees.

## Configuration

From `.env.example`:

| Var | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | - | GitHub PAT for exporter (public repo scope is enough) |
| `GITHUB_USER` | - | Username to walk |
| `AUTHOR_EMAIL` | - | Required; commits matching this email are kept |
| `AUTHOR_EMAILS_EXTRA` | - | Comma-separated additional emails |
| `CODECLONE_DATA_DIR` | `./data` | Raw + processed data |
| `CODECLONE_ADAPTERS_DIR` | `./adapters` | Adapter registry root |
| `CODECLONE_RUNS_DIR` | `./runs` | Per-run metrics + eval reports |
| `CODECLONE_CACHE_DIR` | `./data/cache` | Tokenizer / dataset cache |
| `CODECLONE_BASE_MODEL` | `Qwen/Qwen2.5-Coder-1.5B` | HF base model id |
| `CODECLONE_TOKENIZER` | same | Tokenizer id |
| `CODECLONE_BACKEND` | `auto` | `auto | mlx | peft` |
| `CODECLONE_API_KEY` | `sk-codeclone-local` | Bearer for `/v1/*` |
| `CODECLONE_SERVE_HOST` | `127.0.0.1` | |
| `CODECLONE_SERVE_PORT` | `7461` | |
| `CODECLONE_MAX_TOKENS` | `2048` | Serve cap |
| `CODECLONE_DEFAULT_TEMPERATURE` | `0.2` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTEL collector |
| `OTEL_SERVICE_NAME` | `codeclone` | |
| `MLFLOW_TRACKING_URI` | - | Optional MLflow |
| `HF_HOME` | `./hf_cache` | HF cache |
| `HUGGING_FACE_HUB_TOKEN` | - | For gated models |
| `LOG_LEVEL` | `INFO` | |
| `LOG_JSON` | `1` | structlog JSON output |

Web also reads `CODECLONE_SERVE_URL` (default `http://127.0.0.1:7461`).

## Scripts

CLI (`codeclone ...`, defined in `src/codeclone_cli/main.py`):

| Command | Description |
|---|---|
| `export` | Walk authored commits, write `pairs.jsonl` |
| `preprocess` | Normalize, filter, dedupe, split |
| `train` | LoRA fine-tune end-to-end |
| `eval` | Perplexity + mini suite + samples |
| `serve` | Start OpenAI-compatible API |
| `models list` | List adapters in registry |
| `models show <name>` | Print adapter `meta.json` |
| `models hash-recipe <recipe.yaml>` | Compute recipe hash |

Makefile wrappers: `make install | dev | test | lint | typecheck | fmt | run-serve | docker-cpu | docker-cuda | compose-up | helm-lint`.

Repo scripts: `scripts/smoke_e2e.sh`, `scripts/docker_smoke.sh`, `scripts/test.sh`, `scripts/daily_retrain.py`, `scripts/run_sparkline.py`.

Web (`web/package.json`): `dev`, `build`, `start`, `lint`, `typecheck`, `seed` (`node scripts/seed-fixtures.mjs`).

## API

### Try `/compare` locally

```
cd web && npm run dev
open http://127.0.0.1:3000/demo     # zero-typing landing, runs samples automatically
open http://127.0.0.1:3000/compare  # bring your own snippets
open http://127.0.0.1:3000/batch    # pairwise similarity matrix across many snippets
```

The `/demo` page auto-runs the first of three preloaded sample pairs (renamed variables, partial overlap, distinct) against the live `/api/compare` route and renders verdict, confidence, latency, scores, shared identifiers, and a diff. Click another sample to switch. The `/compare` page is the same scoring backend behind a paste-your-own editor. For a scripted call:

```
curl -sS -X POST http://127.0.0.1:3000/api/compare \
  -H 'content-type: application/json' \
  -d '{"a":"def f(x):\n  return x+1","b":"def g(y):\n  return y+1","language":"python"}'
```

Response includes the three Jaccard-family scores, shared identifiers, and a `alignment` block with per-line best matches plus moved-block flags. The same payload powers the heatmap above the diff viewer.

The `/batch` page accepts up to twelve snippets and returns an NxN matrix plus the upper-triangular pair details. Cells are click-to-inspect: selecting one reveals the clone-type verdict, raw scores, and a side-by-side diff for that pair. For a scripted call:

```
curl -sS -X POST http://127.0.0.1:3000/api/batch \
  -H 'content-type: application/json' \
  -d '{"snippets":[\
    {"id":"a","label":"two_sum","code":"def two_sum(nums,t):\\n cache={}\\n for i,n in enumerate(nums):\\n  if t-n in cache: return [cache[t-n],i]\\n  cache[n]=i"},\
    {"id":"b","label":"find_pair","code":"def find_pair(vs,g):\\n c={}\\n for i,v in enumerate(vs):\\n  if g-v in c: return [c[g-v],i]\\n  c[v]=i"},\
    {"id":"c","label":"reverse","code":"def reverse(s): return s[::-1]"}],"language":"python"}'
```

### Serve (FastAPI, `services/serve/codeclone_serve/app.py`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` | no | liveness |
| GET | `/readyz` | no | readiness (model loaded) |
| GET | `/metrics` | no | Prometheus |
| GET | `/v1/models` | bearer | OpenAI-style model list |
| POST | `/v1/chat/completions` | bearer | chat, supports `stream: true` (SSE) |
| POST | `/v1/completions` | bearer | text completion, supports `stream: true` |

Auth header: `Authorization: Bearer $CODECLONE_API_KEY`.

### Dashboard BFF (`web/app/api/*`)

| Method | Path | Source |
|---|---|---|
| GET | `/api/pairs?limit&offset&q&lang` | reads pairs JSONL via `loadPairsList` |
| GET | `/api/pairs/[id]` | single pair with diff |
| GET | `/api/datasets` | dataset manifest |
| GET | `/api/adapters` | adapter registry |
| GET | `/api/runs` | training runs |
| GET | `/api/eval` | eval index |
| GET | `/api/eval/[runId]` | single eval report |
| GET | `/api/health` | serve `/healthz` probe + eval health |
| GET | `/api/serve-health` | raw serve probe |

OpenAPI for the serve layer: `docs/openapi.yaml`.

## Backends

Selection precedence (from `docs/backends.md`):

```
recipe.train.backend (yaml) > CLI --backend > CODECLONE_BACKEND env > auto
```

`auto` resolves to `mlx` on Darwin/arm64, `peft` elsewhere.

**MLX (Apple Silicon).** `uv pip install -e ".[mlx]"`. Uses `mlx_lm.lora`. From the docs: "drop `model.context_length` to 1024 if you OOM on a 16 GB machine".

**PEFT (CUDA / CPU).** `uv pip install -e ".[cuda]"`. Uses `peft.get_peft_model(...)` with a hand-rolled AdamW step loop (not `transformers.Trainer`) to keep the streaming metrics contract. `bitsandbytes` is in the extras for 4/8-bit but off by default.

If neither backend imports, the trainer falls back to a deterministic mock (decreasing-loss curve) so the rest of the pipeline still runs in CI and on bare laptops. Both backends implement the same `TrainBackend` protocol in `services/trainer/codeclone_trainer/backends/base.py`: `prepare`, `train` (yields `StepMetrics`), `save_adapter`.

## Eval

Run:

```bash
codeclone eval --model adapters/adapter-v1 \
               --data data/processed/test.jsonl \
               --out runs/eval \
               --n-samples 4 --max-problems 8
```

Three components (`services/eval/codeclone_eval/`):

- **Perplexity** (`perplexity.py`): real PPL when the backend exposes logprobs, otherwise a proxy. The report flags `proxy: true` so you don't mix them.
- **Mini suite** (`mini_humaneval.py`): a small set of canonical problems; each is generated, executed, and recorded as pass/fail with truncated error string. `mini_pass_rate = passed / total`.
- **Samples** (`samples.py`): `n_samples` qualitative completions for the report UI.

Outputs land in `runs/eval/` (or the `--out` you pass): `report.json` plus per-sample artifacts. The dashboard pulls these via `/api/eval` and `/api/eval/[runId]`.

## Project structure

```
.
├── src/codeclone_cli/            # Typer entrypoint
├── services/
│   ├── exporter/                 # GitHub + git walker
│   ├── preprocess/               # normalize, filter, dedupe, split
│   ├── trainer/                  # backends/{mlx,peft,base}, driver, run_log
│   ├── eval/                     # perplexity, mini suite, samples
│   └── serve/                    # FastAPI app, auth, model handle
├── packages/
│   ├── config/                   # settings, recipes, logging
│   ├── dataset/                  # pair schema, jsonl io
│   └── models/                   # checkpoint registry
├── recipes/                      # quick|small|standard|full|...
├── web/                          # Next.js 15 dashboard
├── examples/                     # curl, python, node, continue.dev configs
├── scripts/                      # smoke_e2e, daily_retrain, sparkline
├── infra/                        # docker, helm
├── docs/                         # architecture, backends, recipes, ops, openapi
└── tests/
```

## Operations

Notes for running CodeClone as a long-lived service rather than a one-off.

**Deploy.** Container images are built from `infra/docker/Dockerfile` (CPU) or `infra/docker/Dockerfile.cuda` (GPU). A Helm chart lives at `infra/helm/codeclone` with values for replica count, resource requests, and probes. Both health probes (`/healthz` liveness, `/readyz` readiness) and Prometheus scraping (`/metrics`) are exposed by the serve process and are exempt from rate limiting so probes never starve under load.

**Health and readiness.** Liveness and readiness are deliberately separate probes with different failure semantics. Both kubelet-style (`/healthz`, `/readyz`) and plain (`/health`, `/ready`) paths are served so any LB convention works.

* `/health` and `/healthz` answer liveness only. They return `200` as long as the event loop is responsive and never depend on the model handle. A bad model load must not put the pod into a kubelet restart loop, since the next restart would hit the same failure and only thrash. The body includes `model`, `sentry`, `tracing`, and `shutting_down` for operator visibility.
* `/ready` and `/readyz` answer readiness with a real probe. They return `200` only when the model handle responds to a tiny `token_count("ready")` call and every registered dependency check passes. They return `503` with `{"status":"not_ready","reason":...}` when the handle raises, when a dependency check raises, or when the process has begun shutting down. Probe results are cached for two seconds so a one-per-second readiness loop never stresses the model.
* On `SIGTERM` the readiness probe flips to `not_ready` immediately while liveness stays `ok`. This drains traffic during the Kubernetes `terminationGracePeriodSeconds` window: kube-proxy stops sending new requests as soon as the next readiness check fires, in-flight requests finish, and the pod exits cleanly. Extra dependency checks (database ping, model registry reachability, license server, etc.) can be registered through `app.state.readiness.register_dependency(name, check)` at startup; any check that raises makes the pod unready until it recovers.

**Scale.** The serve API is stateless modulo the loaded adapter, so horizontal scaling is by replica count. The in-process rate limiter is per replica. When running more than one replica behind a shared ingress, set tighter per-replica budgets or front the service with a shared limiter (NGINX `limit_req`, Envoy local or global rate limit, or a Redis token bucket) and treat the in-process limiter as defense in depth.

**Rate limiting.** Three independent token buckets run per request: client IP, bearer API key, and the tenant the key is bound to. A request is allowed only if every applicable bucket has a token. Health and metrics paths are always exempt. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODECLONE_RATELIMIT_ENABLED` | `true` | Master switch. |
| `CODECLONE_RATELIMIT_PER_IP_RPM` | `120` | Steady state requests per minute per client IP. |
| `CODECLONE_RATELIMIT_PER_KEY_RPM` | `600` | Steady state requests per minute per API key. |
| `CODECLONE_RATELIMIT_PER_TENANT_RPM` | `1200` | Steady state requests per minute per tenant (aggregate across all keys bound to that tenant). |
| `CODECLONE_RATELIMIT_BURST` | `20` | Bucket capacity, i.e. the largest short term spike a single identity may emit. |
| `CODECLONE_RATELIMIT_TRUST_FORWARDED` | `false` | When the service sits behind a trusted proxy, set true so `X-Forwarded-For` / `X-Real-IP` is used for the IP key. Do not enable when the socket is reachable directly. |

Throttled requests get HTTP `429` with a `Retry-After` header in seconds and a JSON body that names which bucket (`ip`, `api_key`, or `tenant`) tripped.

**Multi-tenancy.** API keys can be bound to a tenant id with the `@tenant` suffix in `CODECLONE_API_KEYS`, for example `sk-acme:infer@acme,sk-globex:infer@globex,sk-ops:*@platform`. Tenant ids must match `^[a-z0-9][a-z0-9-]{0,62}$` so they survive unchanged through metric labels, log fields, and storage keys. Keys without a suffix and the legacy single `CODECLONE_API_KEY` are bound to the implicit `default` tenant for backward compatibility.

Every request resolves a `Principal(fingerprint, scopes, tenant)` which is stashed on `request.state.principal` and surfaced on `request.state.tenant` so downstream handlers and middleware can scope work by tenant. Three layers consume the tenant today:

* **Audit log.** Every JSONL audit row carries a `tenant` field alongside the existing `actor` fingerprint, so SIEM queries can slice activity by tenant and per-tenant retention policies are straightforward.
* **Rate limiting.** A dedicated per-tenant bucket caps aggregate traffic from any single tenant even when that tenant rotates through many keys.
* **GDPR data lifecycle.** `GET /v1/data/export` and `DELETE /v1/data/delete` now scope by `(tenant, actor)`. A non-admin key can only export or erase rows from its own tenant; passing `?tenant=` for a different tenant returns `403`. Admin keys (`*` or `admin` scope) may target any tenant via `?tenant=<id>` and any actor via `?actor=key:<12hex>`, and the cross-tenant erasure is recorded in the audit trail with both `tenant` and `target_tenant` fields.

**Secrets.** All runtime config is loaded via pydantic-settings from environment then `.env`. The `CODECLONE_API_KEY` is the bearer token enforced by `Authorization: Bearer ...`. Rotate by redeploying with a new value. Never bake secrets into images.

**CORS.** The serve API ships with CORS off. With `CODECLONE_CORS_ALLOW_ORIGINS` empty no `CORSMiddleware` is installed at all, so cross-origin browser preflights get no `Access-Control-Allow-Origin` echo and the API is effectively first-party only. Opt in by setting an explicit allow-list of origins (CSV, exact match, no trailing slash). Settings validation rejects entries that are not `http(s)://...` or the literal `*`, so a typo fails the pod at startup rather than silently widening the policy.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODECLONE_CORS_ALLOW_ORIGINS` | empty | CSV of trusted origins. Empty disables CORS entirely. `*` enables a wildcard. |
| `CODECLONE_CORS_ALLOW_CREDENTIALS` | `false` | Allow `Authorization` / cookies on cross-origin requests. Force-disabled when the origin list is `*`, because browsers reject `Access-Control-Allow-Credentials: true` against a wildcard. |
| `CODECLONE_CORS_ALLOW_METHODS` | `GET,POST,OPTIONS` | HTTP methods reflected in preflight. |
| `CODECLONE_CORS_ALLOW_HEADERS` | `authorization,content-type,x-request-id` | Request headers reflected in preflight. |
| `CODECLONE_CORS_MAX_AGE` | `600` | Preflight cache lifetime in seconds. |

The Helm chart exposes the same variables under `env.CODECLONE_CORS_*` in `values.yaml`. A wildcard with credentials is downgraded to credentialless and a `cors.wildcard_with_credentials_disabled` warning is logged, so misconfigurations are observable rather than silently insecure.

**API keys and scopes (RBAC).** The serve API supports two key configurations side by side. The legacy single key in `CODECLONE_API_KEY` is granted the implicit wildcard scope `*` so existing deployments keep working. To split callers by capability, set `CODECLONE_API_KEYS` to a CSV of `key:scopes` entries where scopes are joined with `+`. Known scopes:

| Scope | Routes it unlocks |
| --- | --- |
| `models:read` | `GET /v1/models` |
| `infer` | `POST /v1/chat/completions`, `POST /v1/completions` |
| `admin` | reserved for future admin routes |
| `*` | wildcard, grants every scope (use sparingly) |

Example:

```
CODECLONE_API_KEYS=sk-ci-readonly:models:read,sk-app:infer,sk-ops:*
```

A caller presenting `sk-ci-readonly` can list models but gets `403 missing required scope: infer` if it tries to call completions. A caller presenting `sk-app` can run completions but gets `403` on `/v1/models`. Unauthenticated requests still get `401`, so 401 vs 403 cleanly distinguishes "no key" from "wrong key for this route".

Key fingerprints (sha256 prefix, never the raw key) appear in the audit log as `actor=key:<12 hex>` so per-key activity is correlatable across rotations. To revoke a single integration, drop its entry from `CODECLONE_API_KEYS` and redeploy; the others keep working. In Kubernetes, set `apiKeys.enabled=true` in the Helm chart and put both `api-key` and `api-keys` into the `codeclone-secrets` secret in one shot.

**Observability.** Structured JSON logs are emitted by `structlog` (`LOG_JSON=1`, `LOG_LEVEL=INFO`). Per-route latency histograms and request counters are exposed at `/metrics` in Prometheus text format. When OTel tracing is initialized, every log line also carries `trace_id` and `span_id` so logs, traces, and the audit log line up under a single id.

**Distributed tracing.** The serve process wires OpenTelemetry at app startup whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When unset the SDK stays a no-op so local runs and CI never open sockets. When set, a `TracerProvider` is installed, FastAPI is auto-instrumented end to end, W3C `traceparent` headers propagate trace context to downstream services, and spans are exported over OTLP HTTP. `/healthz` reports a `tracing` boolean so deployment smoke tests can confirm the integration is live. The active span's `trace_id` and `span_id` are injected into every structlog event (via a processor that runs at log emit time, so it always reflects the current span) and into the persisted audit log row for the request, so a single `trace_id` stitches a request to its logs, its audit trail, and the trace itself in Tempo or Jaeger. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP HTTP collector URL, e.g. `http://otel-collector:4318/v1/traces`. Empty disables tracing. |
| `OTEL_SERVICE_NAME` | `codeclone` | Service name attribute on every emitted span. |

The OTLP HTTP exporter package (`opentelemetry-exporter-otlp-proto-http`) is declared as a runtime dependency. If for some reason it is unavailable at runtime, the serve process still installs the provider so trace ids flow into logs locally, and logs a one-line `otel.exporter_missing` warning instead of crashing.

**Request correlation.** Every HTTP request gets an `X-Request-ID`. If the caller sends one and it matches `[A-Za-z0-9._:-]{1,128}` it is honored end to end, otherwise the service mints a 16 hex char id. The id is returned on the response, written to the audit log row, attached to `request.state.request_id` for route handlers, and bound into `structlog` contextvars so every log line emitted while the request is in flight carries `request_id=...` automatically. This makes it trivial to grep the audit JSONL and the application log for a single trace: `jq 'select(.request_id=="abc123")' runs/audit.log` and the matching log lines line up one to one.

**Error tracking.** The serve process wires the Sentry SDK at app startup whenever `SENTRY_DSN` is set; if the DSN is empty the SDK is a no-op so local runs and CI never phone home. `/healthz` reports a `sentry` boolean so deployment smoke tests can confirm the integration is live. The `Authorization`, `X-Api-Key`, and `Cookie` request headers are redacted in the `before_send` hook before any event leaves the process, so bearer tokens never end up in Sentry breadcrumbs. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | empty | Project DSN. Empty disables the SDK. |
| `SENTRY_ENVIRONMENT` | `development` | Tag attached to every event (`production`, `staging`, etc.). |
| `SENTRY_RELEASE` | unset | Release identifier, typically the git SHA or image tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0` | Performance trace sampling rate, `0.0` to `1.0`. Start at `0.05` in production. |
| `SENTRY_SEND_DEFAULT_PII` | `false` | Leave off; auth headers are already scrubbed regardless. |

**Audit log.** Every request handled by the serve API (other than `/healthz`, `/readyz`, `/metrics`, `/favicon.ico`) is appended as one JSON line to `CODECLONE_AUDIT_LOG_PATH` (default `./runs/audit.log`). The middleware is implemented at the ASGI layer so it does not buffer streaming responses (SSE). Each record carries:

| Field | Meaning |
| --- | --- |
| `ts` | UTC ISO 8601 timestamp. |
| `request_id` | 16-char correlation id. Honors an inbound `X-Request-ID` and is echoed back as a response header. |
| `actor` | `key:<sha256[:12]>` of the bearer token, or `anonymous` for unauthenticated calls. The raw key is never written. |
| `remote_ip` | Client IP. Uses the first `X-Forwarded-For` entry only when `CODECLONE_RATELIMIT_TRUST_FORWARDED=true`. |
| `user_agent` | Client UA, truncated to 200 chars. |
| `method`, `path`, `status`, `latency_ms` | HTTP method, route, response status, wall time in ms. |
| `model` | Best-effort JSON body peek for `/v1/*` POSTs (skipped for bodies over 256 KiB). |
| `error` | Present only when the handler raised an unhandled exception. |

Writes are buffered through a background thread (`queue.SimpleQueue`) so request latency is not bound by disk fsync. Auth failures are logged with `actor="anonymous"`, so brute-force probes show up in the audit trail and not only in rate-limit metrics. Tunables (env):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODECLONE_AUDIT_LOG_ENABLED` | `true` | Master switch. Set false to disable the middleware entirely. |
| `CODECLONE_AUDIT_LOG_PATH` | `./runs/audit.log` | Output file. Parent directory is created if missing. Ship to a SIEM via Filebeat, Vector, or Promtail tailing this file. |
| `CODECLONE_AUDIT_LOG_MAX_BYTES` | `52428800` (50 MiB) | Rotate the live file once it crosses this many bytes. `0` disables rotation (legacy single-file behavior). |
| `CODECLONE_AUDIT_LOG_BACKUP_COUNT` | `14` | Number of gzip-rotated backups to retain. Older files are pruned in age order on each rotation. `0` truncates instead of archiving. |

Rotated files are gzip-compressed and named `audit.log.<UTC-timestamp>.gz` (for example `audit.log.20260530T180000Z.gz`), so they sort chronologically and are safe to ship to cold storage by date prefix. Rotation runs inline on the audit writer thread so it never blocks the request path, and pruning enforces `CODECLONE_AUDIT_LOG_BACKUP_COUNT` after each rotation so on-disk usage stays bounded by roughly `max_bytes * (backup_count + 1)` before compression and a fraction of that after. Rows are not lost across rotation: every record that was buffered before the cutover lands in the gzip backup, and every record after lands in the fresh hot file.

For stricter retention than the on-pod window allows, mount a PVC (`auditLog.persistence.enabled=true` in the Helm chart) or stream the JSONL out to a SIEM with a daemonset such as Filebeat or Vector before the backup count rolls. The Helm chart mounts an `emptyDir` at `/var/log/codeclone` by default (capped at 2 GiB) so the pod can run with a read-only root filesystem and rotation still has somewhere to write.

The file is append-only JSONL. If you prefer an external rotator instead, set `CODECLONE_AUDIT_LOG_MAX_BYTES=0` and use `logrotate` with `copytruncate`; lines are well under 4 KiB and rely on POSIX append atomicity, so concurrent rotators do not interleave bytes within a record.

**Backup.** Persistent state is on disk: trained adapters in `CODECLONE_ADAPTERS_DIR`, run logs in `CODECLONE_RUNS_DIR`, and the dataset cache in `CODECLONE_CACHE_DIR`. Back these directories up with the usual volume snapshot or `restic` workflow. The serve process itself is stateless beyond the adapter it loads at boot.

**On-call playbook.**

1. Spike in `429` from `/metrics`: check whether one IP or one API key is the source (the response body names the scope). Raise the relevant `*_RPM` budget or revoke the key.
2. `/readyz` failing but `/healthz` ok: the model handle did not load. Check container logs for `load_handle` errors and confirm the mounted adapter path.
3. Latency regression in `codeclone_request_seconds`: confirm GPU or MLX backend is the one selected by `resolve_backend()` and that no other process is contending for the device.
4. Auth failures: confirm the deployed `CODECLONE_API_KEY` matches what the caller is sending. The serve process logs do not include the key itself. If callers see `403 missing required scope: ...` instead of `401`, the key is valid but lacks the scope the route needs; check the `CODECLONE_API_KEYS` entry for that key.
5. Sudden Sentry quiet on a known-broken deploy: hit `/healthz` and confirm `sentry: true`. If it reports false, the pod is missing `SENTRY_DSN` or the `sentry-sdk` import failed at boot (check logs for `sentry.sdk_missing` or `sentry.init_failed`).
6. Incident forensics: grep `runs/audit.log` by `actor` or `remote_ip` to reconstruct a timeline; the `request_id` ties each row to the matching response header and (when present) the Sentry event tag.

**Kubernetes hardening.** The Helm chart ships four optional production objects, all off by default so a fresh `helm install` stays minimal. Flip them on once the workload graduates past a single-pod hobby deploy:

| Values flag | Object | When to enable |
| --- | --- | --- |
| `autoscaling.enabled=true` | `HorizontalPodAutoscaler` | More than one replica and variable QPS. Tune `targetCPUUtilizationPercentage`; remember the in-process rate limiter is per pod. |
| `podDisruptionBudget.enabled=true` | `PodDisruptionBudget` | Any time `replicaCount > 1`. Default `minAvailable: 1` keeps one pod up during node drains and rolling upgrades. |
| `networkPolicy.enabled=true` | `NetworkPolicy` | Cluster has a CNI that enforces policies (Cilium, Calico, etc.). Default egress allows DNS plus public HTTPS so Hugging Face model pulls still work, and blocks RFC1918 ranges; override `networkPolicy.ingress.from` to scope callers to a specific namespace or pod selector. |
| `serviceMonitor.enabled=true` | `ServiceMonitor` (prometheus-operator CRD) | Cluster runs the Prometheus Operator (kube-prometheus-stack). Set `serviceMonitor.additionalLabels.release=<your-prom-release>` so the operator picks it up. Scrapes `/metrics` on the `http` port every 30s. |

The chart-lint CI job renders the chart twice on every push, once with defaults and once with all four flags on, so a template typo fails CI before it ships. The same matrix is covered by `tests/test_helm_chart.py` which shells out to `helm template` and parses the resulting YAML.

**Supply-chain security.** A dedicated `security` GitHub Actions workflow (`.github/workflows/security.yml`) runs on every push, every PR, and weekly on Monday 09:17 UTC so the known-vulnerability surface stays fresh even in quiet weeks. Five jobs run in parallel:

| Job | Tool | What it catches | Fails build? |
| --- | --- | --- | --- |
| `python-deps` | `pip-audit --strict` against the resolved runtime environment | Known CVEs in any installed Python dependency that has a fix available | yes |
| `sbom` | `cyclonedx-py environment` | Generates `sbom.cdx.json` (CycloneDX 1.5) and uploads it as a 90-day workflow artifact for downstream signing or vendor questionnaires | no |
| `trivy-fs` | `aquasecurity/trivy-action` filesystem scan, `--ignore-unfixed`, `HIGH,CRITICAL` | Vulnerable files and lockfile entries; SARIF is uploaded to the GitHub Security tab | yes |
| `trivy-config` | `trivy config` over `infra/` | Misconfigurations in Dockerfile, Helm chart, and k8s manifests; SARIF uploaded, currently informational (`exit-code: 0`) until the baseline is clean | no |
| `gitleaks` | `gitleaks/gitleaks-action` with `.gitleaks.toml` | Secrets accidentally committed to the working tree or git history. Documented placeholders (`ghp_replace_me`, `sk-codeclone-local`, etc.) are allowlisted by path and regex | yes |

Run the same checks locally with `make security`, which shells out to `scripts/security_scan.sh`. The script treats missing optional tools (`trivy`, `gitleaks`, `cyclonedx-py`) as warnings so a partial install still produces signal; `pip-audit` is the only hard requirement and is one `pip install pip-audit` away. Findings exit non-zero so it slots cleanly into a pre-commit or pre-push hook.

When a finding lands, the SARIF uploads appear under `Security -> Code scanning` in the GitHub UI with file-and-line context; the SBOM artifact lets auditors diff dependency closures between releases without re-resolving locally. Both the workflow shape and the gitleaks allowlist are pinned by `tests/test_security_workflow.py`, so an accidental edit that drops a job or unblocks a placeholder fails pytest before it ships.

### GDPR data lifecycle

The serve API persists exactly one class of caller-derived data: the audit log written by `codeclone_serve.audit` (JSONL at `CODECLONE_AUDIT_LOG_PATH`, default `./runs/audit.log`). Each row carries an `actor` field that is a SHA-256 fingerprint (`key:<12 hex>`) of the API key that made the request. The raw key is never persisted.

Two endpoints let an API key holder exercise GDPR Articles 15, 17, and 20 over that data:

- `GET /v1/data/export` streams every audit row tied to the caller's key fingerprint as `application/x-ndjson` with a meta header and summary footer. Use it for Subject Access Requests (Art. 15) and data portability (Art. 20).
- `DELETE /v1/data/delete` rewrites the audit log without those rows. The rewrite is atomic via `tempfile` + `os.replace` under a process-wide lock, and the audit log itself records the erasure as a `gdpr.erasure` event so the deletion act remains auditable (Art. 17 + Art. 30 record-keeping).

Both endpoints require the `infer` scope. A caller may target their own fingerprint without arguments. A key with the wildcard `*` (admin) scope may also pass `?actor=key:<12hex>` to act on behalf of another caller; non-admin callers receive 403 if they try to do so. Behaviour and access control are pinned by `services/serve/tests/test_data_lifecycle.py`.

Operational notes:

- For on-call: a SAR can be served with `curl -H "Authorization: Bearer $KEY" https://$HOST/v1/data/export -o sar.jsonl`. An erasure request becomes `curl -X DELETE -H "Authorization: Bearer $KEY" https://$HOST/v1/data/delete`.
- If you shipped the audit log to a downstream SIEM via Filebeat or Vector, propagate the erasure event through the same pipeline and apply the matching delete on the SIEM side; the local rewrite only purges the on-disk JSONL.
- Disable the entire surface with `CODECLONE_AUDIT_LOG_ENABLED=false`. The endpoints then return 409 because there is nothing to export or erase.

**Smoke testing a Helm release.** The chart ships a `helm test` hook that runs after install or upgrade. It launches a short-lived busybox pod that probes `/healthz`, `/readyz`, `/metrics`, and confirms that the auth gate still rejects unauthenticated `/v1/models` traffic. Run it with:

```
helm test <release> --namespace <ns> --logs
```

The hook is enabled by default and self-cleans on success; failed pods are kept so their logs stay grep-able. Disable for clusters where ephemeral test pods are not allowed with `--set tests.enabled=false`. The probe asserts the `codeclone_requests_total` series shows up in `/metrics` so a silent middleware regression that returns an empty `/metrics` body cannot pass.

**On-call quick reference.**

| Symptom | First check |
| --- | --- |
| `helm test` fails on `/readyz` | model handle did not load; `kubectl logs` the serve pod and look for adapter or HF cache errors |
| `helm test` fails on `/metrics` | prometheus_client not initialised; confirm the pod actually serves the prom text format, not JSON |
| `helm test` fails on the auth gate | `CODECLONE_API_KEY` secret is missing or the auth middleware is not mounted |
| 429s spiking | check which bucket (`ip` or `api_key`) is named in the body; raise the matching `CODECLONE_RATELIMIT_*` knob or add capacity |
| Audit log disk full | confirm `CODECLONE_AUDIT_LOG_MAX_BYTES` and `_BACKUP_COUNT` are set; ship rotated `.gz` files to the SIEM faster |

### Try it: enumerate and revoke dashboard sessions for incident response

CodeClone is a code-similarity service. When SecOps has to contain a credential compromise (stolen laptop, phishing victim, offboarded employee) the dashboard `/settings/sessions` page is one-user-at-a-time and cookie-authenticated, so until this change there was no programmatic, tenant-scoped path for a SOAR or IGA bot to enumerate active sessions or force-logout a member. `GET /v1/sessions`, `DELETE /v1/sessions/{jti}`, and `POST /v1/sessions/revoke-all` now expose the same primitives over Bearer auth, gated by the new least-privilege `sessions:read` and `sessions:write` scopes. Tenant scope is structural: the list endpoint derives the in-scope user set from `workspace.members`, the revoke endpoint resolves the owning userId server-side from the jti and 404s if that user is not a member of the calling key's workspace, and `revoke-all` requires `user_id` in the body and 404s if that user is not a workspace member. Cross-tenant probes never leak the existence of another tenant's jti or userId via status code. Every call appends a `v1.sessions.read | revoke | revoke_all` row to the tamper-evident audit chain.

```bash
pnpm dev   # web dashboard on http://localhost:3000

# Mint a key on /api-keys with sessions:read + sessions:write scopes.

# Enumerate every active dashboard session in this workspace:
curl -sS http://localhost:3000/v1/sessions \
  -H "Authorization: Bearer cc_live_..."
# {
#   "workspace_id": "ws_acme",
#   "sessions": [
#     { "jti": "k7Q1abcDEF...", "user_id": "u_42",
#       "created_at": 1717000000000, "expires_at": 1719600000000,
#       "last_seen_at": 1717003600000,
#       "ip": "203.0.113.7", "user_agent": "Mozilla/5.0 ...",
#       "created_ip": "203.0.113.7", "created_user_agent": "Mozilla/5.0 ..." }
#   ],
#   "total": 1
# }

# Revoke a single suspicious session (idempotent; 404 if cross-tenant):
curl -sS -X DELETE http://localhost:3000/v1/sessions/k7Q1abcDEF \
  -H "Authorization: Bearer cc_live_..."
# { "jti": "k7Q1abcDEF", "user_id": "u_42", "revoked": true }

# Incident kill switch: force-logout every active session for a member
# (user_id must be a member of the calling workspace, otherwise 404):
curl -sS -X POST http://localhost:3000/v1/sessions/revoke-all \
  -H "Authorization: Bearer cc_live_..." \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_42"}'
# { "user_id": "u_42", "revoked_count": 3 }

# A key missing the scope is refused:
#   HTTP/1.1 403 Forbidden
#   { "error": { "type": "insufficient_scope",
#                "required_scope": "sessions:write",
#                "granted_scopes": ["compare:write"] } }
```

Pinned by `web/tests/v1-sessions-tenant-isolation.test.ts`: source-level wiring (scope check, enforce rate-limit, full enforcement chain, audit ids) plus a live cross-tenant test that proves workspace B can never enumerate or revoke workspace A's sessions even when both tenants share the same on-disk session store.

## License

Apache-2.0. See `LICENSE`.
