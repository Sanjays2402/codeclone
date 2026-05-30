import { clsx } from "clsx";

export function Empty({ title, hint, mono }: { title: string; hint?: string; mono?: string }) {
  return (
    <div className="ruled rounded-md py-14 px-6 text-center">
      <div className="text-[var(--color-ink-2)] text-[14px] mb-1">{title}</div>
      {hint && <div className="text-[var(--color-ink-3)] text-[12.5px]">{hint}</div>}
      {mono && <div className="mt-3 mono text-[11.5px] text-[var(--color-ink-3)] inline-block px-2 py-1 bg-[var(--color-paper-2)] rounded">{mono}</div>}
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="ruled rounded-md py-6 px-5 bg-[var(--color-neg-soft)] border-[color:var(--color-neg-bar)]">
      <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-neg)] mb-1">error</div>
      <div className="mono text-[12px] text-[var(--color-neg)]">{message}</div>
    </div>
  );
}

export function LoadingRow({ rows = 6 }: { rows?: number }) {
  return (
    <div className="ruled rounded-md overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={clsx(
          "h-9 flex items-center px-4",
          i > 0 && "border-t border-[var(--color-rule)]",
        )}>
          <span className="pulse-soft block h-2.5 bg-[var(--color-paper-3)] rounded-sm" style={{ width: `${40 + (i * 7) % 40}%` }} />
        </div>
      ))}
    </div>
  );
}
