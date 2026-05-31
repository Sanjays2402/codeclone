# codeclone

Fine-tune a small code model on your own GitHub commit history, eval it on a mini suite, and serve it behind an OpenAI-compatible API. Ships a Next.js dashboard for browsing clone pairs, datasets, adapters, and eval runs.

![landing](docs/screenshots/landing.png)

## What it does

Walks your authored git history, extracts (prefix, completion) pairs from real commits, normalizes and dedupes them, and trains a LoRA adapter on top of a small code base model (Qwen2.5-Coder-1.5B by default). Trains via MLX on Apple Silicon or PEFT/transformers everywhere else, with a deterministic mock fallback when neither is installed so the pipeline stays testable. Adapters land in a local registry with recipe hash and metrics. Eval computes perplexity plus a mini HumanEval-style pass/fail grid. Serve exposes `/v1/chat/completions` and `/v1/completions` (streaming). The web dashboard browses pairs with a diff viewer, lists datasets and adapters, shows eval runs with charts, and streams chat against the local serve.

## Features

- Active sessions & force logout at `/settings/sessions`: every sign-in now creates a server-side session record (signed cookie carries a `jti`), so users can see every device that has authenticated to their account with IP, user agent, signed-in time, last-seen time, and expiry. Revoke a single session, sign out every other device while staying logged in here, or sign out everywhere in one click — the revoked `jti` is checked on every authenticated request, so a stolen cookie stops working before its TTL expires. Session lifetime is configurable per user (1 hour to 90 days) and applied to new sign-ins. Every event writes a structured audit entry (`auth.signin`, `auth.signout`, `auth.session_revoke`, `auth.session_revoke_others`, `auth.session_revoke_all`, `auth.session_ttl_update`) so workspace owners can answer the procurement question "who signed in from where, and when did we cut them off?" Tracked sessions live on disk under `CODECLONE_SESSIONS_DIR` (defaults to `../sessions`). Legacy cookies issued before this feature stay valid until they expire.

- Commit exporter with author-email filtering, license mode (`strict | permissive_only | off`), and per-language tagging
- Preprocess pipeline: normalize, length/lang filter, exact + MinHash dedupe, train/val/test split, JSON report
- Two LoRA backends behind one `TrainBackend` protocol: `mlx` (mlx-lm) and `peft` (transformers + peft), plus mock fallback
- Streaming step metrics to `runs/<id>/metrics.jsonl`, written incrementally
- Adapter registry under `adapters/<name>/meta.json` with base, backend, recipe hash, final loss
- Eval runner: perplexity (real or proxy), mini suite pass rate, qualitative samples
- OpenAI-compatible serve: `/v1/models`, `/v1/chat/completions`, `/v1/completions`, SSE streaming, API key auth, `/healthz`, `/readyz`, `/metrics`
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
- Outbound webhooks via `/webhooks`: register a URL, receive a real signed POST every time `/v1/compare` finishes. Each delivery retries up to three times with backoff, includes an HMAC-SHA256 signature (`X-CodeClone-Signature: t=<ts>,v1=<mac>`), and lands in a per-endpoint delivery log (last 50) you can browse from the dashboard. **Click Redeliver on any past delivery to replay that exact signed payload to the endpoint, so receiver bugs can be fixed and retested without re-running the original compare.** Replays are tagged with their source delivery id and update the same success/failure counters. Pause, resume, or delete endpoints inline. Override the on-disk location with `CODECLONE_WEBHOOKS_DIR`.
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

## License

Apache-2.0. See `LICENSE`.
