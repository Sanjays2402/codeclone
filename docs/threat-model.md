# Threat model

This document describes the assets, trust boundaries, top risks, and mitigations
for the codeclone dashboard and `/v1` API. It is intentionally short so
procurement reviewers can read it end to end in five minutes.

## Assets we protect
- Customer code snippets and comparison results (`runs/`, `shares/`, `snippets/`).
- API keys, magic-link tokens, session cookies, MFA secrets, OIDC client secrets,
  webhook signing secrets.
- Audit log entries (append-only).
- Workspace membership and billing plan.

## Trust boundaries
1. **Browser to web app.** All session state is HMAC-signed cookies. Sign-in is
   magic link or workspace OIDC. Session TTL is configurable and admins can
   force-logout every device.
2. **API client to `/v1`.** Bearer API keys with per-scope authorization and per-key
   sliding-window rate limits. Per-workspace monthly quotas on top.
3. **Web app to outbound webhook receiver.** This is the highest-leverage SSRF
   surface because the URL is tenant-controlled. See mitigations below.
4. **Web app to filesystem.** All multi-tenant data is scoped by `workspaceId`
   and the audit/IP allowlist layers reject cross-tenant reads.

## Top risks and mitigations

| Risk | Mitigation |
|------|------------|
| Cross-tenant data leakage | Every list/read carries `workspaceId`; tests in `tests/audit.test.ts`, `tests/workspaces.test.ts`, `tests/ip-allowlist.test.ts` assert isolation. |
| Stolen API key | Per-key revoke, rotation, last-used timestamp, scopes, sliding-window rate limit. Only the hash is persisted. |
| Magic-link replay | One-time use, 15-minute TTL, single-IP binding via cookie. |
| MFA bypass on destructive actions | Step-up TOTP enforced on wipe, revoke-all, member removal. |
| Account takeover via SSO | `enforced` SSO blocks magic links for members of the configured domain. |
| Webhook receiver impersonation | HMAC-SHA256 over `timestamp.body`, exposed via `X-CodeClone-Signature`. |
| **Outbound SSRF via webhooks** | URL must be public http(s); loopback (`127.0.0.0/8`, `::1`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), unique-local (`fc00::/7`), multicast, `0.0.0.0`, IPv4-mapped IPv6, and internal-only TLDs (`.local`, `.internal`, `.lan`, `.intranet`, `.home.arpa`, `.localhost`) are rejected at create time **and** re-checked at every delivery attempt. Override only via `CODECLONE_WEBHOOKS_ALLOW_PRIVATE=1` for local dev. See `web/lib/webhooks.ts`. |
| DNS rebinding against webhook receiver | Not yet fully mitigated. We rely on URL/IP literal checks; we do not pin DNS to the resolution observed at create time. Tracked as future work. |
| Audit log tampering | Append-only JSONL, one file per UTC day, no API path mutates or deletes entries. |
| Secrets in client bundles | Only server-side modules touch `node:fs` / secret material; `lib/scopes.ts` is the client-safe re-export. |
| Dependency CVEs | Dependabot daily PRs for npm and GitHub Actions (`.github/dependabot.yml`); auto-merge workflow already in place for patch-level updates. |

## Out of scope (today)
- Per-receiver DNS pinning for webhooks (planned).
- Customer-managed encryption keys (CMEK).
- HSM-backed signing for delivery HMAC.

## Reporting
See `SECURITY.md` for the disclosure process.
