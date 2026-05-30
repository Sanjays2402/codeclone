"use client";

import { ErrorBlock } from "../components/States";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-[1280px] px-7 py-10">
      <div className="eyebrow mb-2">runtime · error</div>
      <h1 className="text-[22px] tracking-tight font-medium mb-4">Something failed while rendering this page.</h1>
      <ErrorBlock message={error.message || "unknown error"} />
      <button
        onClick={reset}
        className="mt-6 mono text-[11px] uppercase tracking-[0.14em] border border-[var(--color-rule-strong)] rounded-sm px-2.5 py-1 hover:bg-[var(--color-paper-2)]"
      >
        retry
      </button>
    </div>
  );
}
