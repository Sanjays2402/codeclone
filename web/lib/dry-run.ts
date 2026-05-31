/**
 * Sandbox / dry-run support for the public /v1 API.
 *
 * Enterprise buyers expect destructive or quota-consuming endpoints to
 * support a no-op preview mode so they can wire integrations in CI
 * without burning real quota, spamming webhook subscribers, or polluting
 * usage logs. `?dry_run=true` (or `{ "dry_run": true }` in the JSON body)
 * runs every validation step the live call runs, then returns a
 * structured preview describing what would have happened.
 *
 * What dry-run does:
 *   - Authenticates the API key, checks scope, IP allowlist, rate-limit,
 *     plan quota, payload size, and request shape exactly as the live
 *     path does. Any of those failures still returns the same status
 *     code and JSON error envelope.
 *   - Computes the same similarity output the real call would return so
 *     customers can inspect contract shape end-to-end.
 *   - Does NOT call `recordUse`, `logUsage`, or `dispatchEvent`. The key
 *     `lastUsedAt` timestamp is not bumped, plan usage is not charged,
 *     and no webhook subscriber is notified.
 *   - Records a single audit entry with `action: "v1.compare.dry_run"` or
 *     `"v1.batch.dry_run"` so security teams can still see who probed.
 *
 * Response headers:
 *   - `x-codeclone-dry-run: true` on every dry-run response.
 *   - The same rate-limit + plan headers a live call would emit, so
 *     clients can read remaining budget without spending it.
 */
export function isDryRun(req: Request, body: unknown): boolean {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("dry_run") || "").toLowerCase();
    if (q === "1" || q === "true" || q === "yes") return true;
  } catch {
    // Non-absolute URL in some test harnesses; fall through to body check.
  }
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>).dry_run;
    if (v === true) return true;
    if (typeof v === "string" && ["1", "true", "yes"].includes(v.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export const DRY_RUN_HEADER = { "x-codeclone-dry-run": "true" } as const;
