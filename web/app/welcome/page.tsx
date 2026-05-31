"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle,
  Circle,
  ArrowRight,
  Sparkle,
  EyeSlash,
  ArrowClockwise,
  Stack,
  Trash,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { ErrorBlock } from "../../components/States";

type StepId = "create_key" | "run_compare" | "save_share";

interface Step {
  id: StepId;
  title: string;
  body: string;
  href: string;
  cta: string;
  done: boolean;
}

interface OnboardingState {
  steps: Step[];
  completed: number;
  total: number;
  dismissed: boolean;
  startedAt: number;
  finishedAt?: number;
}

type Status = "loading" | "ready" | "error";

function StepIcon({ done }: { done: boolean }) {
  if (done) {
    return (
      <CheckCircle
        weight="duotone"
        className="h-6 w-6 text-[var(--color-pos)] shrink-0"
        aria-label="completed"
      />
    );
  }
  return (
    <Circle
      weight="duotone"
      className="h-6 w-6 text-[var(--color-ink-4)] shrink-0"
      aria-label="not yet completed"
    />
  );
}

export default function WelcomePage() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [seedBusy, setSeedBusy] = useState<boolean>(false);
  const [seedMsg, setSeedMsg] = useState<string>("");
  const [hasSamples, setHasSamples] = useState<boolean>(false);

  const refreshSamples = useCallback(async () => {
    try {
      const res = await fetch("/api/share?limit=200&tag=sample", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { count?: number; total?: number };
      const n = typeof j.total === "number" ? j.total : j.count ?? 0;
      setHasSamples(n > 0);
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as OnboardingState;
      setState(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSamples();
  }, [refresh, refreshSamples]);

  const dismiss = useCallback(async () => {    setBusy(true);
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const seed = useCallback(async () => {
    setSeedBusy(true);
    setSeedMsg("");
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "seed-samples" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSeedMsg(j?.error?.message ?? `Request failed (${res.status}).`);
      } else {
        const created = j?.seeded?.created?.length ?? 0;
        const skipped = j?.seeded?.skipped ?? false;
        setSeedMsg(
          skipped
            ? `Samples already loaded (${created}). Open history to browse them.`
            : `Loaded ${created} sample comparison${created === 1 ? "" : "s"}. Open history to browse.`,
        );
      }
      await refresh();
      await refreshSamples();
    } finally {
      setSeedBusy(false);
    }
  }, [refresh, refreshSamples]);

  const clearSamples = useCallback(async () => {
    setSeedBusy(true);
    setSeedMsg("");
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear-samples" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSeedMsg(j?.error?.message ?? `Request failed (${res.status}).`);
      } else {
        const removed = j?.cleared?.removed ?? 0;
        setSeedMsg(`Removed ${removed} sample share${removed === 1 ? "" : "s"}.`);
      }
      await refresh();
      await refreshSamples();
    } finally {
      setSeedBusy(false);
    }
  }, [refresh, refreshSamples]);

  const pctDone =
    state && state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;

  return (
    <main className="mx-auto max-w-[760px] px-5 sm:px-7 py-10 sm:py-14">
      <H1 eyebrow="welcome">Get codeclone set up in three steps</H1>

      <p className="text-[14.5px] text-[var(--color-ink-2)] leading-relaxed max-w-[560px] mb-8">
        codeclone detects near-duplicate code across files, repos, and pull
        requests. Finish these three steps and you have a working API key, a
        first comparison, and a shareable result link you can send to a
        teammate.
      </p>

      {status === "error" && (
        <div className="mb-6">
          <ErrorBlock message={error} />
        </div>
      )}

      {status === "loading" && (
        <div
          className="ruled rounded-md p-6 pulse-soft text-[13px] text-[var(--color-ink-3)] mono"
          aria-busy="true"
        >
          loading welcome state...
        </div>
      )}

      {state && status === "ready" && (
        <>
          <div className="ruled rounded-md p-5 mb-6 bg-[var(--color-paper-2)]">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-2">
                <Sparkle
                  weight="duotone"
                  className="h-4 w-4 text-[var(--color-accent-ink)]"
                  aria-hidden="true"
                />
                <span className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
                  progress
                </span>
              </div>
              <span className="mono text-[12px] text-[var(--color-ink-2)] tabular-nums">
                {state.completed} / {state.total} ({pctDone}%)
              </span>
            </div>
            <div
              className="h-1.5 w-full rounded-full bg-[var(--color-paper-3)] overflow-hidden"
              role="progressbar"
              aria-valuenow={pctDone}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-[var(--color-accent)] transition-[width] duration-500"
                style={{ width: `${pctDone}%` }}
              />
            </div>
          </div>

          <ol className="space-y-3">
            {state.steps.map((step, idx) => (
              <li
                key={step.id}
                className="ruled rounded-md p-5 flex flex-col sm:flex-row sm:items-start gap-4"
              >
                <StepIcon done={step.done} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
                      step {idx + 1}
                    </span>
                    {step.done && (
                      <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-pos)]">
                        done
                      </span>
                    )}
                  </div>
                  <h2 className="text-[15px] font-medium tracking-tight mb-1.5">
                    {step.title}
                  </h2>
                  <p className="text-[13px] text-[var(--color-ink-2)] leading-relaxed">
                    {step.body}
                  </p>
                </div>
                <div className="shrink-0">
                  <Link
                    href={step.href}
                    className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-2 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-3)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    {step.cta}
                    <ArrowRight weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <ArrowClockwise weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
              refresh
            </button>
            {!state.dismissed ? (
              <button
                type="button"
                onClick={() => void dismiss()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <EyeSlash weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
                hide welcome banner
              </button>
            ) : (
              <span className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
                banner hidden
              </span>
            )}
          </div>

          <div className="mt-6 ruled rounded-md p-5">
            <div className="flex items-start gap-3">
              <Stack
                weight="duotone"
                className="h-5 w-5 text-[var(--color-accent-ink)] shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <h2 className="text-[14.5px] font-medium tracking-tight mb-1">
                  Want to see the product full?
                </h2>
                <p className="text-[13px] text-[var(--color-ink-2)] leading-relaxed mb-3">
                  Load three real comparisons into your history so the app is
                  not empty on your first visit: a near-duplicate, a partial
                  overlap, and a distinct pair. Each one is a real run through
                  the live scorer.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void seed()}
                    disabled={seedBusy}
                    className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-2 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-3)] transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    <Sparkle weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
                    {hasSamples ? "reload samples" : "load sample comparisons"}
                  </button>
                  {hasSamples && (
                    <button
                      type="button"
                      onClick={() => void clearSamples()}
                      disabled={seedBusy}
                      className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    >
                      <Trash weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
                      remove samples
                    </button>
                  )}
                  <Link
                    href="/history?tag=sample"
                    className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    open history
                    <ArrowRight weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
                {seedMsg && (
                  <p
                    className="mt-3 text-[12.5px] text-[var(--color-ink-2)]"
                    role="status"
                    aria-live="polite"
                  >
                    {seedMsg}
                  </p>
                )}
              </div>
            </div>
          </div>

          {state.completed === state.total && (
            <div className="mt-6 ruled rounded-md p-5 border-[color:var(--color-pos-bar)] bg-[var(--color-pos-soft)]">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle
                  weight="duotone"
                  className="h-5 w-5 text-[var(--color-pos)]"
                  aria-hidden="true"
                />
                <span className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-pos)]">
                  all set
                </span>
              </div>
              <p className="text-[13.5px] text-[var(--color-ink)] leading-relaxed">
                You have an API key, a comparison, and at least one saved share.
                Head to <Link href="/usage" className="underline">usage</Link> to
                watch your throughput or <Link href="/webhooks" className="underline">webhooks</Link>{" "}
                to pipe results into your stack.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
