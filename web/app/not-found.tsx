import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1280px] px-7 py-20">
      <div className="eyebrow mb-2">404 · not found</div>
      <h1 className="text-[28px] tracking-tight font-medium mb-3">No record for that id.</h1>
      <p className="mono text-[12.5px] text-[var(--color-ink-3)] mb-6">
        It may have been removed from the on-disk store, or the id is mistyped.
      </p>
      <Link href="/" className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent-ink)] border border-[var(--color-accent)] rounded-sm px-2.5 py-1">
        return to overview
      </Link>
    </div>
  );
}
