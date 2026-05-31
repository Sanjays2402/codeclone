import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="eyebrow text-[var(--color-ink-3)]">404 · shared result</div>
      <h1 className="text-[22px] tracking-tight font-medium">This shared result is gone.</h1>
      <p className="text-[13px] text-[var(--color-ink-3)] max-w-[44ch]">
        The link may have been deleted or never existed. Try starting a new comparison instead.
      </p>
      <Link
        href="/compare"
        className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
      >
        open compare
      </Link>
    </div>
  );
}
