"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { EnvelopeSimple, ArrowRight, CheckCircle, Warning } from "@phosphor-icons/react/dist/ssr";

function errorCopy(code: string | null): string | null {
  if (!code) return null;
  if (code === "invalid_or_expired") {
    return "That link expired or was already used. Send a fresh one below.";
  }
  return "Something went wrong. Try again.";
}

function SignInInner() {
  const search = useSearchParams();
  const initialError = errorCopy(search.get("error"));
  const redirect = search.get("redirect") ?? "/";

  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(initialError);
  const [devLink, setDevLink] = useState<string | null>(null);

  useEffect(() => {
    if (initialError) setState("error");
  }, [initialError]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    setMessage(null);
    setDevLink(null);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirect }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("error");
        setMessage(data?.error?.message ?? "Could not send link.");
        return;
      }
      setState("sent");
      if (data.devLink) setDevLink(data.devLink);
    } catch {
      setState("error");
      setMessage("Network error. Try again.");
    }
  }

  return (
    <main className="mx-auto max-w-[460px] px-6 py-16 sm:py-24">
      <div className="mb-10">
        <h1 className="text-[28px] sm:text-[32px] font-medium tracking-tight">
          Sign in to codeclone
        </h1>
        <p className="mt-2 text-[14px] text-[var(--color-ink-3)] leading-relaxed">
          Enter your email and we will send a one-time sign-in link.
          No password, no setup.
        </p>
      </div>

      {state !== "sent" ? (
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
              email
            </span>
            <div className="mt-1.5 relative">
              <EnvelopeSimple
                size={16}
                weight="duotone"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-4)] pointer-events-none"
              />
              <input
                type="email"
                required
                autoFocus
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state === "loading"}
                className="w-full h-11 pl-9 pr-3 rounded-md bg-[var(--color-paper)] border border-[var(--color-rule)] text-[14px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]/15 focus:border-[var(--color-ink-3)]"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={state === "loading" || email.length === 0}
            className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-md bg-[var(--color-ink)] text-[var(--color-paper)] text-[13.5px] font-medium tracking-tight disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            {state === "loading" ? (
              <span className="mono text-[11px] uppercase tracking-[0.18em]">sending</span>
            ) : (
              <>
                <span>Send sign-in link</span>
                <ArrowRight size={15} weight="bold" />
              </>
            )}
          </button>

          {state === "error" && message ? (
            <div className="flex items-start gap-2 text-[12.5px] text-[var(--color-ink-2)] bg-[var(--color-paper-3)] border border-[var(--color-rule)] rounded-md p-3">
              <Warning size={16} weight="duotone" className="mt-0.5 shrink-0 text-amber-600" />
              <span>{message}</span>
            </div>
          ) : null}
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-paper-3)] p-4">
            <CheckCircle size={22} weight="duotone" className="mt-0.5 shrink-0 text-emerald-600" />
            <div className="space-y-1">
              <div className="text-[14px] font-medium">Check your inbox</div>
              <div className="text-[12.5px] text-[var(--color-ink-3)] leading-relaxed">
                We sent a sign-in link to <span className="mono">{email}</span>. It expires in 15 minutes.
              </div>
            </div>
          </div>

          {devLink ? (
            <div className="rounded-md border border-dashed border-[var(--color-rule)] p-3">
              <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] mb-2">
                dev mode link
              </div>
              <a
                href={devLink}
                className="mono text-[11.5px] break-all text-[var(--color-ink-2)] hover:text-[var(--color-ink)] underline-offset-4 hover:underline"
              >
                {devLink}
              </a>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setState("idle");
              setDevLink(null);
            }}
            className="mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            use a different email
          </button>
        </div>
      )}
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-[460px] px-6 py-16" />}>
      <SignInInner />
    </Suspense>
  );
}
