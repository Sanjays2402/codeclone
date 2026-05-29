# Security policy

## Reporting

Open a private security advisory on GitHub
(`Security` tab → `Report a vulnerability`). Please do not file public
issues for anything that could lead to data exposure or remote code
execution.

We will acknowledge receipt within 72 hours and aim to ship a fix within
30 days for high-severity reports.

## Scope

In scope:

- The `serve` HTTP surface (auth bypass, request smuggling, path traversal,
  pickle deserialization, etc.).
- The exporter's secret scrub (false negatives are bugs, not features).
- Any code path that writes outside `data/`, `adapters/`, `runs/`, or
  `hf_cache/` without an explicit user flag.

Out of scope:

- Third-party dependencies; please report upstream.
- Misconfigured deployments (default API key in production, exposed `/metrics`
  on the internet, etc.).
- Model output content. CodeClone does not run content moderation.

## Threat model assumptions

- The serve endpoint is intended for `127.0.0.1` or a private network. If
  you expose it publicly, you must front it with a reverse proxy that
  performs additional auth and rate limiting.
- The training data is your own commit history. CodeClone does not protect
  against you intentionally feeding it someone else's code; the safety
  filters are belt and suspenders, not a sandbox.
- The CLI is trusted with shell access (it shells out to `git`). Do not run
  `codeclone export` against untrusted repo URLs without your own review.
