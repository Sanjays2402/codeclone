/**
 * Aggregator powering /api/webhooks/recent-failures and the in-app toaster.
 *
 * Pure-ish module: takes the webhook list + per-hook delivery loader so it
 * can be tested without spinning up a Next.js route.
 */
import { listWebhooks, listWebhooksForWorkspace, listDeliveries, type WebhookSummary, type DeliveryRecord } from "./webhooks.ts";

export interface RecentFailure {
  webhookId: string;
  label: string;
  url: string;
  event: string;
  attemptedAt: number;
  status: number;
  attempts: number;
  error?: string;
}

export interface CollectOptions {
  limit?: number;
  since?: number;
  /**
   * REQUIRED in the API path. When provided, only failures from webhooks
   * owned by this workspace are returned. Tests may omit this and use
   * `listWebhooksImpl` to inject a custom set.
   */
  workspaceId?: string | null;
  // Injection seams for tests.
  listWebhooksImpl?: () => Promise<WebhookSummary[]>;
  listDeliveriesImpl?: (id: string) => Promise<DeliveryRecord[]>;
}

export function clampLimit(raw: number | null | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 25;
  return Math.max(1, Math.min(100, n));
}

export function clampSince(raw: number | null | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, n);
}

export async function collectRecentFailures(opts: CollectOptions = {}): Promise<RecentFailure[]> {
  const limit = clampLimit(opts.limit);
  const since = clampSince(opts.since);
  const hooksFn = opts.listWebhooksImpl
    ?? (opts.workspaceId
      ? () => listWebhooksForWorkspace(opts.workspaceId as string)
      : listWebhooks);
  const deliveriesFn = opts.listDeliveriesImpl ?? listDeliveries;

  const hooks = await hooksFn();
  const out: RecentFailure[] = [];
  for (const h of hooks) {
    const deliveries = await deliveriesFn(h.id);
    for (const d of deliveries) {
      if (d.ok) continue;
      if (d.status !== 0 && d.status < 400) continue;
      if (d.attemptedAt < since) continue;
      out.push({
        webhookId: h.id,
        label: h.label,
        url: h.url,
        event: d.event,
        attemptedAt: d.attemptedAt,
        status: d.status,
        attempts: d.attempts,
        error: d.error,
      });
    }
  }
  out.sort((a, b) => b.attemptedAt - a.attemptedAt);
  return out.slice(0, limit);
}
