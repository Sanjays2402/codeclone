"use client";

/**
 * Global in-app toast surface.
 *
 * Customer-pull purpose: the settings page already exposes two notification
 * preferences (toast on long compare finish, surface webhook failures) but
 * nothing in the app actually rendered them. This component renders both, and
 * exposes a small imperative API so any page can push a toast.
 *
 * Usage from any client component:
 *   import { toast } from "../components/Toaster";
 *   toast.success("Comparison finished in 3.1s");
 *
 * Webhook failures are surfaced automatically by polling
 * /api/webhooks/recent-failures every 20s while the tab is visible. The poll
 * is cheap (the route walks a single JSON delivery log) and only fires a toast
 * the first time we see a given (webhookId, attemptedAt) pair.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle,
  WarningCircle,
  Info,
  X as XIcon,
} from "@phosphor-icons/react/dist/ssr";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  href?: { url: string; label: string };
  ttlMs: number;
  createdAt: number;
}

interface ToastInput {
  kind?: ToastKind;
  title: string;
  description?: string;
  href?: { url: string; label: string };
  ttlMs?: number;
}

// Tiny pub/sub so non-React code (and code that isn't wrapped in a provider)
// can still push toasts. We listen for a CustomEvent on window.
const EVENT = "codeclone:toast";

function emit(input: ToastInput): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastInput>(EVENT, { detail: input }));
}

export const toast = {
  success(title: string, opts: Omit<ToastInput, "title" | "kind"> = {}): void {
    emit({ ...opts, kind: "success", title });
  },
  error(title: string, opts: Omit<ToastInput, "title" | "kind"> = {}): void {
    emit({ ...opts, kind: "error", title });
  },
  info(title: string, opts: Omit<ToastInput, "title" | "kind"> = {}): void {
    emit({ ...opts, kind: "info", title });
  },
};

interface Prefs {
  notifyOnCompareCompleted: boolean;
  notifyOnWebhookFailure: boolean;
}

interface RecentFailure {
  webhookId: string;
  url: string;
  event: string;
  attemptedAt: number;
  status: number;
  error?: string;
}

const PREFS_REFRESH_MS = 60_000;
const FAIL_POLL_MS = 20_000;
const SEEN_FAILURES_KEY = "codeclone:seenWebhookFailures";

function loadSeen(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_FAILURES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    // Cap at 200 entries so this never balloons.
    const arr = Array.from(seen).slice(-200);
    window.localStorage.setItem(SEEN_FAILURES_KEY, JSON.stringify(arr));
  } catch {
    // ignore quota errors
  }
}

function kindClasses(kind: ToastKind): string {
  if (kind === "success") {
    return "border-[color:var(--color-pos)] bg-[var(--color-pos-soft)] text-[var(--color-pos)]";
  }
  if (kind === "error") {
    return "border-[color:var(--color-neg,#c0392b)] bg-[var(--color-neg-soft,rgba(192,57,43,0.08))] text-[var(--color-neg,#c0392b)]";
  }
  return "border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink-2)]";
}

function KindIcon({ kind }: { kind: ToastKind }) {
  if (kind === "success") return <CheckCircle weight="duotone" size={18} />;
  if (kind === "error") return <WarningCircle weight="duotone" size={18} />;
  return <Info weight="duotone" size={18} />;
}

export function Toaster(): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const prefsRef = useRef<Prefs>({ notifyOnCompareCompleted: false, notifyOnWebhookFailure: true });
  const seenRef = useRef<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setItems(prev => prev.filter(t => t.id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ttlMs = Math.max(1500, input.ttlMs ?? 5000);
    const item: ToastItem = {
      id,
      kind: input.kind ?? "info",
      title: input.title,
      description: input.description,
      href: input.href,
      ttlMs,
      createdAt: Date.now(),
    };
    setItems(prev => [...prev.slice(-4), item]); // keep at most 5 visible
    const handle = setTimeout(() => dismiss(id), ttlMs);
    timers.current.set(id, handle);
  }, [dismiss]);

  // Subscribe to imperative toast() calls.
  useEffect(() => {
    function onToast(e: Event) {
      const detail = (e as CustomEvent<ToastInput>).detail;
      if (!detail || typeof detail.title !== "string") return;
      // Gate compare-completed toasts on pref. Anything else flows through.
      if (
        detail.kind === "success" &&
        detail.title.startsWith("Comparison finished") &&
        !prefsRef.current.notifyOnCompareCompleted
      ) {
        return;
      }
      push(detail);
    }
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, [push]);

  // Hydrate seen-failures set once.
  useEffect(() => {
    seenRef.current = loadSeen();
  }, []);

  // Refresh prefs periodically + once on mount.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as Prefs;
        if (cancelled) return;
        prefsRef.current = {
          notifyOnCompareCompleted: Boolean(j.notifyOnCompareCompleted),
          notifyOnWebhookFailure: Boolean(j.notifyOnWebhookFailure),
        };
      } catch {
        // ignore; we keep last-known prefs
      }
    }
    void refresh();
    const handle = setInterval(refresh, PREFS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Poll for webhook failures while the tab is visible.
  const firstPollRef = useRef(true);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (!prefsRef.current.notifyOnWebhookFailure) return;
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/webhooks/recent-failures?limit=25", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { items: RecentFailure[] };
        if (cancelled) return;
        const fresh: RecentFailure[] = [];
        for (const f of j.items ?? []) {
          const key = `${f.webhookId}:${f.attemptedAt}`;
          if (!seenRef.current.has(key)) {
            seenRef.current.add(key);
            fresh.push(f);
          }
        }
        if (fresh.length > 0) saveSeen(seenRef.current);
        // On the very first poll, mark existing failures as seen without
        // toasting (so reloading the page doesn't spam old errors).
        if (!firstPollRef.current) {
          for (const f of fresh.slice(0, 3)) {
            push({
              kind: "error",
              title: `Webhook delivery failed (${f.status || "network"})`,
              description: `${f.event} → ${f.url}`,
              href: { url: `/webhooks`, label: "view log" },
              ttlMs: 8000,
            });
          }
        }
        firstPollRef.current = false;
      } catch {
        // ignore
      }
    }
    void poll();
    const handle = setInterval(poll, FAIL_POLL_MS);
    function onVis() {
      if (!document.hidden) void poll();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(handle);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [push]);

  // Cleanup all timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  if (items.length === 0) {
    return <div aria-live="polite" aria-atomic="true" className="sr-only" />;
  }

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:right-4 sm:left-auto"
    >
      {items.map(t => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={[
            "pointer-events-auto w-full sm:w-[360px] max-w-full",
            "rounded-md border px-3 py-2 shadow-sm",
            "bg-[var(--color-paper)]",
            "flex items-start gap-2",
            kindClasses(t.kind),
          ].join(" ")}
        >
          <div className="shrink-0 pt-[2px]">
            <KindIcon kind={t.kind} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--color-ink-1)] truncate">
              {t.title}
            </div>
            {t.description && (
              <div className="mono text-[11.5px] text-[var(--color-ink-3)] mt-0.5 break-words">
                {t.description}
              </div>
            )}
            {t.href && (
              <Link
                href={t.href.url}
                onClick={() => dismiss(t.id)}
                className="mono text-[11.5px] text-[var(--color-ink-2)] underline underline-offset-2 mt-1 inline-block"
              >
                {t.href.label}
              </Link>
            )}
          </div>
          <button
            type="button"
            aria-label="dismiss notification"
            onClick={() => dismiss(t.id)}
            className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded-sm text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ink-3)]"
          >
            <XIcon weight="bold" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
