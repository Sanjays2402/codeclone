"use client";

import { useEffect, useState } from "react";
import { DownloadSimple, X as XIcon, WifiSlash, CheckCircle } from "@phosphor-icons/react/dist/ssr";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "codeclone:pwa:dismissed";

export function PWAInstall() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [offline, setOffline] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [justInstalled, setJustInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Register the service worker.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => undefined);
    }

    // Detect standalone (already installed).
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(Boolean(standalone));

    setDismissed(window.localStorage?.getItem(DISMISS_KEY) === "1");
    setOffline(!navigator.onLine);

    const onBIP = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
      setJustInstalled(true);
      window.setTimeout(() => setJustInstalled(false), 3500);
    };
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);

    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  function install() {
    if (!prompt) return;
    void prompt.prompt().then(() => prompt.userChoice).then((r) => {
      if (r.outcome === "dismissed") {
        window.localStorage?.setItem(DISMISS_KEY, "1");
        setDismissed(true);
      }
      setPrompt(null);
    });
  }

  function dismiss() {
    window.localStorage?.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  const showInstall = !installed && !dismissed && prompt !== null;

  if (!showInstall && !offline && !justInstalled) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-3 left-3 right-3 sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-sm z-40 flex flex-col gap-2"
    >
      {offline && (
        <div className="mono text-[11px] uppercase tracking-[0.14em] flex items-center gap-2 border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink-2)] rounded-sm px-3 py-2 shadow-sm">
          <WifiSlash weight="duotone" size={16} />
          offline. cached pages still work.
        </div>
      )}
      {justInstalled && (
        <div className="mono text-[11px] uppercase tracking-[0.14em] flex items-center gap-2 border border-[color:var(--color-pos)] bg-[var(--color-pos-soft)] text-[var(--color-pos)] rounded-sm px-3 py-2 shadow-sm">
          <CheckCircle weight="duotone" size={16} />
          installed
        </div>
      )}
      {showInstall && (
        <div className="border border-[var(--color-rule)] bg-[var(--color-paper)] rounded-sm shadow-sm p-3 flex items-start gap-3">
          <DownloadSimple weight="duotone" size={22} className="text-[var(--color-accent)] mt-px shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink)]">
              install codeclone
            </div>
            <div className="text-[13px] text-[var(--color-ink-2)] mt-0.5">
              Add to your home screen for a faster, full-screen experience that works offline.
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={install}
                className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-1"
              >
                install
              </button>
              <button
                onClick={dismiss}
                className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-rule-strong)]"
              >
                not now
              </button>
            </div>
          </div>
          <button
            onClick={dismiss}
            aria-label="dismiss"
            className="text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)] p-1 -m-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-rule-strong)] rounded-sm"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
