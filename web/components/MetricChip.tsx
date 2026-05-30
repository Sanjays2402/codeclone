import { clsx } from "clsx";

export function MetricChip({
  label, value, sub, large, accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  large?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={clsx(
      "ruled rounded-md px-4 py-3.5",
      accent && "bg-[var(--color-accent-soft)] border-[color:color-mix(in_oklab,var(--color-accent)_30%,var(--color-rule))]",
    )}>
      <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-1.5">
        {label}
      </div>
      <div className={clsx(
        "mono tnum tracking-tight font-medium leading-none",
        large ? "text-[34px]" : "text-[22px]",
        accent && "text-[var(--color-accent-ink)]",
      )}>
        {value}
      </div>
      {sub && <div className="mono text-[11px] text-[var(--color-ink-3)] mt-2">{sub}</div>}
    </div>
  );
}
