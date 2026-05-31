"use client";

/**
 * Periodic access review editor.
 *
 * Surfaces the SOC2 CC6.3 attestation workflow: an owner snapshots the
 * roster, decides keep/revoke per member, and completes the review.
 * Completed reviews remain visible as an audit artifact.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  CheckCircle,
  XCircle,
  ClockCounterClockwise,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

interface ReviewSummary {
  id: string;
  workspaceId: string;
  title: string;
  status: "open" | "completed" | "cancelled";
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  cancelledAt?: number;
  revokedCount: number;
  totals: { total: number; pending: number; keep: number; revoke: number };
}

interface ReviewEntry {
  userId: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  decision: "pending" | "keep" | "revoke";
  note?: string;
  decidedAt?: number;
  decidedBy?: string;
}

interface ReviewDetail extends ReviewSummary {
  entries: ReviewEntry[];
}

interface ListResponse {
  reviews: ReviewSummary[];
  canEdit: boolean;
}

interface DetailResponse {
  review: ReviewDetail;
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

function fmtDate(ms?: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AccessReviewsEditor({ workspaceId }: Props) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/access-reviews`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ListResponse;
      setList(data);
      const openRev = data.reviews.find((r) => r.status === "open");
      if (openRev && !openId) setOpenId(openRev.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, openId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: string) => {
      setErr(null);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/access-reviews/${id}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DetailResponse;
        setDetail(data.review);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load review");
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    if (openId) loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  async function startReview() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/access-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setTitle("");
      setOpenId(data.review.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start review");
    } finally {
      setBusy(false);
    }
  }

  async function decide(userId: string, decision: "keep" | "revoke") {
    if (!detail) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/access-reviews/${detail.id}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decisions: [{ userId, decision }] }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setDetail(data.review);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to record decision");
    } finally {
      setBusy(false);
    }
  }

  async function completeReview() {
    if (!detail) return;
    if (!confirm("Complete this review? Members marked Revoke will be suspended.")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/access-reviews/${detail.id}/complete`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      await load();
      await loadDetail(detail.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to complete review");
    } finally {
      setBusy(false);
    }
  }

  async function cancelReview() {
    if (!detail) return;
    if (!confirm("Cancel this review without applying any decisions?")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/access-reviews/${detail.id}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      await load();
      await loadDetail(detail.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to cancel review");
    } finally {
      setBusy(false);
    }
  }

  const openRev = useMemo(
    () => list?.reviews.find((r) => r.status === "open") ?? null,
    [list],
  );
  const completed = useMemo(
    () => (list?.reviews ?? []).filter((r) => r.status !== "open"),
    [list],
  );

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-4 flex items-start gap-3">
        <ShieldCheck weight="duotone" className="mt-0.5 h-5 w-5 text-zinc-500" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Access reviews
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Periodic attestation of who has access. Required for SOC2 CC6.3
            and ISO 27001 A.9.2.5.
          </p>
        </div>
      </header>

      {loading ? (
        <div className="space-y-2">
          <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : err ? (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <WarningCircle weight="duotone" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{err}</span>
        </div>
      ) : !list ? null : (
        <>
          {!openRev && list.canEdit && (
            <div className="mb-4 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">
                Start a new review. The current active roster is snapshotted
                and you decide keep or revoke for each member.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Q2 2026 access review"
                  className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <button
                  type="button"
                  onClick={startReview}
                  disabled={busy}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                  Start review
                </button>
              </div>
            </div>
          )}
          {!openRev && !list.canEdit && (
            <p className="mb-4 text-xs text-zinc-500">
              No review in progress. Workspace owners can start one.
            </p>
          )}

          {detail && detail.status === "open" && (
            <div className="mb-5">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {detail.title}
                </h4>
                <span className="text-xs text-zinc-500">
                  {detail.totals.keep} keep, {detail.totals.revoke} revoke,{" "}
                  {detail.totals.pending} pending
                </span>
              </div>
              <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {detail.entries.length === 0 && (
                  <li className="p-3 text-xs text-zinc-500">
                    No members in this snapshot.
                  </li>
                )}
                {detail.entries.map((e) => (
                  <li
                    key={e.userId}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                        {e.email}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {e.role}
                        {e.decision !== "pending" && (
                          <>
                            {" "}
                            &middot;{" "}
                            <span
                              className={
                                e.decision === "keep"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-amber-600 dark:text-amber-400"
                              }
                            >
                              {e.decision}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {list.canEdit && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(e.userId, "keep")}
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium ${
                            e.decision === "keep"
                              ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-500/70 dark:bg-emerald-950/40 dark:text-emerald-300"
                              : "border-zinc-300 text-zinc-700 hover:border-emerald-400 dark:border-zinc-700 dark:text-zinc-300"
                          } disabled:opacity-50`}
                        >
                          <CheckCircle weight="duotone" className="h-3.5 w-3.5" />
                          Keep
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(e.userId, "revoke")}
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium ${
                            e.decision === "revoke"
                              ? "border-amber-500 bg-amber-50 text-amber-700 dark:border-amber-500/70 dark:bg-amber-950/40 dark:text-amber-300"
                              : "border-zinc-300 text-zinc-700 hover:border-amber-400 dark:border-zinc-700 dark:text-zinc-300"
                          } disabled:opacity-50`}
                        >
                          <XCircle weight="duotone" className="h-3.5 w-3.5" />
                          Revoke
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {list.canEdit && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={completeReview}
                    disabled={busy || detail.totals.pending > 0}
                    title={
                      detail.totals.pending > 0
                        ? "Decide every member before completing."
                        : ""
                    }
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    Complete review
                  </button>
                  <button
                    type="button"
                    onClick={cancelReview}
                    disabled={busy}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    Cancel review
                  </button>
                </div>
              )}
            </div>
          )}

          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              History
            </h4>
            {completed.length === 0 ? (
              <p className="text-xs text-zinc-500">No completed reviews yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {completed.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 p-3 text-xs">
                    <ClockCounterClockwise
                      weight="duotone"
                      className="h-4 w-4 text-zinc-400"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                        {r.title}
                      </div>
                      <div className="text-zinc-500">
                        {r.status === "completed"
                          ? `Completed ${fmtDate(r.completedAt)} \u00b7 ${r.revokedCount} revoked`
                          : `Cancelled ${fmtDate(r.cancelledAt)}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpenId(r.id)}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      View
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
