"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { ThemeToggle } from "./ThemeToggle";

const items = [
  { href: "/",         label: "overview" },
  { href: "/demo",     label: "demo" },
  { href: "/compare",  label: "compare" },
  { href: "/history",  label: "history" },
  { href: "/batch",    label: "batch" },
  { href: "/pairs",    label: "pairs" },
  { href: "/eval",     label: "eval" },
  { href: "/datasets", label: "datasets" },
  { href: "/models",   label: "models" },
];

export function NavBar() {
  const p = usePathname() ?? "/";
  return (
    <header className="border-b border-[var(--color-rule)] bg-[var(--color-paper)]">
      <div className="mx-auto max-w-[1280px] px-7 h-14 flex items-center gap-8">
        <Link href="/" className="flex items-baseline gap-2.5">
          <span className="mono text-[15px] tracking-tight font-medium">codeclone</span>
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] border border-[var(--color-rule)] rounded-sm px-1.5 py-px">v0.2</span>
        </Link>
        <nav className="flex items-center gap-1">
          {items.map(it => {
            const active = it.href === "/" ? p === "/" : p.startsWith(it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={clsx(
                  "mono text-[11.5px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm transition-colors",
                  active
                    ? "text-[var(--color-ink)] bg-[var(--color-paper-3)]"
                    : "text-[var(--color-ink-3)] hover:text-[var(--color-ink)]",
                )}
              >
                {it.label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
