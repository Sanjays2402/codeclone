import { clsx } from "clsx";

interface Case { name: string; passed: boolean; error?: string }

export function EvalGrid({ cases }: { cases: Case[] }) {
  if (!cases || cases.length === 0) {
    return <div className="ruled rounded-md p-6 mono text-[11.5px] text-[var(--color-ink-3)]">no per-case results</div>;
  }
  return (
    <div>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(28px, 1fr))" }}>
        {cases.map((c, i) => (
          <div
            key={i}
            title={`${c.name} · ${c.passed ? "pass" : "fail"}${c.error ? ` · ${c.error}` : ""}`}
            className={clsx(
              "h-7 rounded-sm border mono text-[9px] flex items-center justify-center text-[var(--color-ink-3)]",
              c.passed
                ? "bg-[var(--color-pos-soft)] border-[var(--color-pos-bar)]"
                : "bg-[var(--color-neg-soft)] border-[var(--color-neg-bar)]",
            )}
          >
            {c.passed ? "·" : "×"}
          </div>
        ))}
      </div>
      <div className="mt-3 mono text-[11px] text-[var(--color-ink-3)]">
        {cases.filter(c => c.passed).length} / {cases.length} cases pass
      </div>
    </div>
  );
}

export function EvalTable({ cases }: { cases: Case[] }) {
  if (!cases || cases.length === 0) return null;
  return (
    <div className="ruled rounded-md overflow-hidden">
      <div className="grid grid-cols-[2rem_1fr_auto] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
        <div>·</div><div>case</div><div>note</div>
      </div>
      {cases.map((c, i) => (
        <div key={i} className="grid grid-cols-[2rem_1fr_auto] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 mono text-[12px]">
          <div className={c.passed ? "text-[var(--color-pos)]" : "text-[var(--color-neg)]"}>{c.passed ? "●" : "×"}</div>
          <div className="truncate text-[var(--color-ink-2)]">{c.name}</div>
          <div className="text-[var(--color-ink-3)] truncate max-w-[40ch] text-right">{c.error || (c.passed ? "ok" : "fail")}</div>
        </div>
      ))}
    </div>
  );
}
