"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserCircle, SignOut, CaretDown } from "@phosphor-icons/react/dist/ssr";

interface MeUser {
  id: string;
  email: string;
}

export function UserMenu() {
  const [user, setUser] = useState<MeUser | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setUser(d.user ?? null);
      })
      .catch(() => {
        if (alive) setUser(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    setUser(null);
    setOpen(false);
    router.refresh();
  }

  if (user === undefined) {
    return (
      <div
        aria-hidden
        className="h-7 w-20 rounded-sm bg-[var(--color-paper-3)] animate-pulse"
      />
    );
  }

  if (!user) {
    return (
      <Link
        href="/signin"
        className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink-3)] transition-colors"
      >
        sign in
      </Link>
    );
  }

  const label = user.email.split("@")[0] || user.email;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] transition-colors"
      >
        <UserCircle size={15} weight="duotone" />
        <span className="max-w-[120px] truncate">{label}</span>
        <CaretDown size={10} weight="bold" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[220px] rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] shadow-md p-1 z-50"
        >
          <div className="px-3 py-2 border-b border-[var(--color-rule)] mb-1">
            <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
              signed in as
            </div>
            <div className="text-[12.5px] text-[var(--color-ink)] truncate">{user.email}</div>
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-[12.5px] rounded-sm text-[var(--color-ink-2)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)]"
          >
            Settings
          </Link>
          <Link
            href="/api-keys"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-[12.5px] rounded-sm text-[var(--color-ink-2)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)]"
          >
            API keys
          </Link>
          <Link
            href="/usage"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-[12.5px] rounded-sm text-[var(--color-ink-2)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)]"
          >
            Usage
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="w-full text-left px-3 py-1.5 mt-1 border-t border-[var(--color-rule)] inline-flex items-center gap-2 text-[12.5px] rounded-sm text-[var(--color-ink-2)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)]"
          >
            <SignOut size={13} weight="duotone" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
