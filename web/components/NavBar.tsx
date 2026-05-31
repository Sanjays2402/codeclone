"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { List, X } from "@phosphor-icons/react/dist/ssr";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "./NotificationBell";

const items = [
  { href: "/",         label: "overview" },
  { href: "/welcome",  label: "welcome" },
  { href: "/demo",     label: "demo" },
  { href: "/compare",  label: "compare" },
  { href: "/history",  label: "history" },
  { href: "/collections", label: "collections" },
  { href: "/snippets", label: "snippets" },
  { href: "/batch",    label: "batch" },
  { href: "/pairs",    label: "pairs" },
  { href: "/eval",     label: "eval" },
  { href: "/datasets", label: "datasets" },
  { href: "/models",   label: "models" },
  { href: "/api-keys", label: "api keys" },
  { href: "/usage",    label: "usage" },
  { href: "/webhooks", label: "webhooks" },
  { href: "/notifications", label: "inbox" },
  { href: "/workspaces", label: "team" },
  { href: "/settings", label: "settings" },
];

function isActive(href: string, p: string) {
  return href === "/" ? p === "/" : p.startsWith(href);
}

export function NavBar() {
  const p = usePathname() ?? "/";
  const [open, setOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => {
    setOpen(false);
  }, [p]);

  // Lock scroll when drawer open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="border-b border-[var(--color-rule)] bg-[var(--color-paper)]">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-7 h-14 flex items-center gap-4 sm:gap-8">
        {/* Mobile hamburger */}
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          className="lg:hidden -ml-1 inline-flex items-center justify-center w-9 h-9 rounded-sm text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]"
          onClick={() => setOpen(true)}
        >
          <List size={20} weight="duotone" />
        </button>

        <Link href="/" className="flex items-baseline gap-2.5 shrink-0">
          <span className="mono text-[15px] tracking-tight font-medium">codeclone</span>
          <span className="hidden sm:inline mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] border border-[var(--color-rule)] rounded-sm px-1.5 py-px">v0.2</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1 min-w-0 overflow-x-auto">
          {items.map(it => {
            const active = isActive(it.href, p);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={clsx(
                  "mono text-[11.5px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm transition-colors whitespace-nowrap",
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

        <div className="ml-auto flex items-center gap-1 sm:gap-2 shrink-0">
          <NotificationBell />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>

      {/* Mobile drawer */}
      {open ? (
        <div
          className="lg:hidden fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-nav-drawer"
            className="absolute left-0 top-0 h-full w-[82%] max-w-[320px] bg-[var(--color-paper)] border-r border-[var(--color-rule)] shadow-xl flex flex-col"
          >
            <div className="h-14 px-4 flex items-center justify-between border-b border-[var(--color-rule)]">
              <span className="mono text-[15px] tracking-tight font-medium">codeclone</span>
              <button
                type="button"
                aria-label="Close menu"
                className="inline-flex items-center justify-center w-9 h-9 rounded-sm text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]"
                onClick={() => setOpen(false)}
              >
                <X size={18} weight="duotone" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {items.map(it => {
                const active = isActive(it.href, p);
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={clsx(
                      "block mono text-[12px] uppercase tracking-[0.14em] px-5 py-3 border-l-2 transition-colors",
                      active
                        ? "text-[var(--color-ink)] bg-[var(--color-paper-3)] border-[var(--color-ink)]"
                        : "text-[var(--color-ink-3)] border-transparent hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]",
                    )}
                  >
                    {it.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      ) : null}
    </header>
  );
}
