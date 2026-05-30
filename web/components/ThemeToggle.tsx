"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "@phosphor-icons/react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("codeclone-theme");
    const prefers = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const isDark = saved ? saved === "dark" : !!prefers;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("codeclone-theme", next ? "dark" : "light");
  }
  return (
    <button
      onClick={toggle}
      aria-label="toggle theme"
      className="ml-auto mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] inline-flex items-center gap-1.5 border border-[var(--color-rule)] rounded-sm px-2 py-0.5"
    >
      {dark
        ? <Sun size={12} weight="duotone" />
        : <Moon size={12} weight="duotone" />}
      {dark ? "light" : "dark"}
    </button>
  );
}
