"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "@phosphor-icons/react/dist/ssr";

const POLL_MS = 30_000;

export function NotificationBell() {
  const pathname = usePathname() ?? "/";
  const [unread, setUnread] = useState<number>(0);
  const [signedIn, setSignedIn] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch("/api/notifications?unread=1&limit=1", {
          cache: "no-store",
        });
        if (!alive) return;
        if (res.status === 401) {
          setSignedIn(false);
          setUnread(0);
        } else if (res.ok) {
          const j = (await res.json()) as { unread?: number };
          setSignedIn(true);
          setUnread(typeof j.unread === "number" ? j.unread : 0);
        }
      } catch {
        // network blip; keep last value
      } finally {
        if (alive) timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // Re-poll immediately when the user navigates (cheap refresh after an action).
  }, [pathname]);

  if (!signedIn) return null;

  const active = pathname.startsWith("/notifications");
  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      title="Notifications"
      className={`relative inline-flex items-center justify-center w-8 h-8 rounded-sm border transition-colors ${
        active
          ? "border-[color:var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-paper-3)]"
          : "border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
      }`}
    >
      <Bell weight="duotone" size={16} />
      {unread > 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 mono text-[10px] leading-[16px] text-center rounded-full bg-[var(--color-accent)] text-[var(--color-paper)] border border-[var(--color-paper)]"
          aria-hidden
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
