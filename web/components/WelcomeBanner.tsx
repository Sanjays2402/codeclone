"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkle, ArrowRight, X as XIcon } from "@phosphor-icons/react/dist/ssr";

interface State {
  completed: number;
  total: number;
  dismissed: boolean;
}

/**
 * Slim banner that appears on every page until the user finishes the
 * 3-step welcome flow or hits "hide" on /welcome. Suppresses itself on
 * the welcome page so we are not repeating the same CTA twice.
 */
export function WelcomeBanner() {
  const pathname = usePathname() ?? "/";
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as State;
        if (!cancelled) setState(j);
      } catch {
        /* silent: banner is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (!state) return null;
  if (state.dismissed) return null;
  if (state.completed >= state.total) return null;
  if (pathname.startsWith("/welcome")) return null;

  const dismiss = async () => {
    setState({ ...state, dismissed: true });
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-7 h-10 flex items-center gap-3">
        <Sparkle
          weight="duotone"
          className="h-4 w-4 text-[var(--color-accent-ink)] shrink-0"
          aria-hidden="true"
        />
        <span className="mono text-[11.5px] uppercase tracking-[0.14em] text-[var(--color-accent-ink)] truncate">
          welcome step {state.completed} of {state.total}
        </span>
        <Link
          href="/welcome"
          className="ml-auto inline-flex items-center gap-1 mono text-[11.5px] uppercase tracking-[0.14em] text-[var(--color-accent-ink)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm px-1"
        >
          continue
          <ArrowRight weight="bold" className="h-3 w-3" aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label="Dismiss welcome banner"
          className="text-[var(--color-accent-ink)] hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
        >
          <XIcon weight="bold" className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
