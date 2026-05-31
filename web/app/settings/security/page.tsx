"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  Key,
  Warning,
  CheckCircle,
  ArrowsClockwise,
  Copy,
  XCircle,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../../components/Headings";
import { ErrorBlock } from "../../../components/States";

interface MfaStatus {
  enrolled: boolean;
  enrolledAt: number | null;
  pending: boolean;
  backupCodesRemaining: number;
}

interface EnrollStart {
  secret: string;
  otpauthUrl: string;
  pendingCreatedAt: number;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function StatusBadge({ status }: { status: MfaStatus | null }) {
  if (!status) return null;
  if (status.enrolled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-200">
        <CheckCircle weight="duotone" className="size-3.5" />
        MFA enabled
      </span>
    );
  }
  if (status.pending) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
        <ArrowsClockwise weight="duotone" className="size-3.5" />
        Enrollment in progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-200">
      <XCircle weight="duotone" className="size-3.5" />
      MFA disabled
    </span>
  );
}

export default function MfaSettingsPage() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enroll, setEnroll] = useState<EnrollStart | null>(null);
  const [enrollToken, setEnrollToken] = useState("");
  const [enrollSubmitting, setEnrollSubmitting] = useState(false);

  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const [disableToken, setDisableToken] = useState("");
  const [disableSubmitting, setDisableSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa", { credentials: "same-origin" });
      if (res.status === 401) {
        setError("Sign in to manage MFA.");
        return;
      }
      if (!res.ok) {
        setError("Could not load MFA status.");
        return;
      }
      setStatus((await res.json()) as MfaStatus);
    } catch {
      setError("Network error loading MFA status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEnroll = useCallback(async () => {
    setError(null);
    setBackupCodes(null);
    try {
      const res = await fetch("/api/auth/mfa/enroll", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = (await res.json()) as EnrollStart & { error?: string };
      if (!res.ok) {
        setError(data.error || "Could not start enrollment.");
        return;
      }
      setEnroll(data);
      setEnrollToken("");
    } catch {
      setError("Network error starting enrollment.");
    }
  }, []);

  const confirmEnroll = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!/^\d{6}$/.test(enrollToken)) {
        setError("Enter the 6-digit code from your authenticator app.");
        return;
      }
      setEnrollSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/auth/mfa/confirm", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: enrollToken }),
        });
        const data = (await res.json()) as { backupCodes?: string[]; error?: string };
        if (!res.ok) {
          setError(data.error || "Could not confirm code.");
          return;
        }
        setBackupCodes(data.backupCodes ?? []);
        setEnroll(null);
        setEnrollToken("");
        await load();
      } catch {
        setError("Network error confirming code.");
      } finally {
        setEnrollSubmitting(false);
      }
    },
    [enrollToken, load],
  );

  const disable = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!disableToken.trim()) {
        setError("Enter your current MFA code to disable.");
        return;
      }
      setDisableSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/auth/mfa/disable", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: disableToken.trim() }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error || "Could not disable MFA.");
          return;
        }
        setDisableToken("");
        setBackupCodes(null);
        await load();
      } catch {
        setError("Network error disabling MFA.");
      } finally {
        setDisableSubmitting(false);
      }
    },
    [disableToken, load],
  );

  const copyAll = useCallback((codes: string[]) => {
    void navigator.clipboard.writeText(codes.join("\n"));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-zinc-100 p-2">
          <ShieldCheck weight="duotone" className="size-5 text-zinc-700" />
        </div>
        <div>
          <H1>Two-factor authentication</H1>
          <p className="mt-1 text-sm text-zinc-500">
            Add a time-based code to protect destructive actions like wiping
            data, force-logging-out devices, and removing workspace members.
          </p>
        </div>
      </div>

      {error && <ErrorBlock message={error} />}

      <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <H2>Status</H2>
          {loading ? (
            <span className="h-6 w-28 animate-pulse rounded-full bg-zinc-100" />
          ) : (
            <StatusBadge status={status} />
          )}
        </div>
        {status?.enrolled && (
          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Enrolled</dt>
              <dd className="font-medium text-zinc-900">{fmtDate(status.enrolledAt)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Backup codes remaining</dt>
              <dd className="font-medium text-zinc-900">{status.backupCodesRemaining} of 10</dd>
            </div>
          </dl>
        )}
      </section>

      {!loading && status && !status.enrolled && !enroll && (
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <H2>Set up an authenticator app</H2>
          <p className="text-sm text-zinc-600">
            Use 1Password, Authy, Google Authenticator, or any TOTP app.
            You will scan a QR code (or enter a secret), then confirm a 6-digit
            code to finish setup.
          </p>
          <button
            type="button"
            onClick={startEnroll}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2"
          >
            <Key weight="duotone" className="size-4" />
            Start setup
          </button>
        </section>
      )}

      {enroll && (
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <H2>Scan and confirm</H2>
          <p className="text-sm text-zinc-600">
            Add this account to your authenticator app, then enter the 6-digit
            code it shows.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[auto,1fr]">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(enroll.otpauthUrl)}`}
              alt="QR code for authenticator app"
              width={180}
              height={180}
              className="rounded-lg border border-zinc-200 bg-white p-2"
            />
            <div className="min-w-0">
              <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Or enter this secret manually
              </label>
              <div className="mt-1 flex items-center gap-2">
                <code className="block flex-1 truncate rounded-md bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-800 ring-1 ring-inset ring-zinc-200">
                  {enroll.secret}
                </code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(enroll.secret)}
                  className="rounded-md p-2 text-zinc-500 hover:bg-zinc-100"
                  aria-label="Copy secret"
                >
                  <Copy weight="duotone" className="size-4" />
                </button>
              </div>
              <form onSubmit={confirmEnroll} className="mt-4">
                <label
                  htmlFor="enroll-token"
                  className="block text-xs font-medium uppercase tracking-wide text-zinc-500"
                >
                  6-digit code
                </label>
                <input
                  id="enroll-token"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={enrollToken}
                  onChange={(e) => setEnrollToken(e.target.value.replace(/\D/g, ""))}
                  className="mt-1 w-40 rounded-md border border-zinc-300 px-3 py-2 text-center font-mono text-lg tracking-widest focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  placeholder="000000"
                />
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={enrollSubmitting || enrollToken.length !== 6}
                    className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {enrollSubmitting ? "Confirming..." : "Confirm and enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEnroll(null);
                      setEnrollToken("");
                    }}
                    className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </section>
      )}

      {backupCodes && backupCodes.length > 0 && (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-start gap-3">
            <Warning weight="duotone" className="mt-0.5 size-5 text-amber-700" />
            <div className="min-w-0 flex-1">
              <H2>Save your backup codes</H2>
              <p className="text-sm text-amber-800">
                Each code works once. Store them somewhere safe. You will not
                see them again.
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-amber-900 sm:grid-cols-2">
                {backupCodes.map((c) => (
                  <li key={c} className="rounded bg-white/60 px-2 py-1 ring-1 ring-inset ring-amber-200">
                    {c}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => copyAll(backupCodes)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-200 hover:bg-amber-100"
              >
                <Copy weight="duotone" className="size-3.5" />
                Copy all
              </button>
            </div>
          </div>
        </section>
      )}

      {status?.enrolled && (
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <H2>Disable MFA</H2>
          <p className="text-sm text-zinc-600">
            Provide a current 6-digit code (or a backup code) to turn off
            two-factor authentication.
          </p>
          <form onSubmit={disable} className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label
                htmlFor="disable-token"
                className="block text-xs font-medium uppercase tracking-wide text-zinc-500"
              >
                Code
              </label>
              <input
                id="disable-token"
                value={disableToken}
                onChange={(e) => setDisableToken(e.target.value)}
                autoComplete="one-time-code"
                className="mt-1 w-48 rounded-md border border-zinc-300 px-3 py-2 font-mono focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                placeholder="000000 or backup"
              />
            </div>
            <button
              type="submit"
              disabled={disableSubmitting || !disableToken.trim()}
              className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {disableSubmitting ? "Disabling..." : "Disable MFA"}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
