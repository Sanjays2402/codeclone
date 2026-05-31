"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Code,
  Copy,
  Check,
  Key,
  Lightning,
  PaperPlaneTilt,
  ShieldCheck,
  Warning,
  CaretDown,
  Book,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../components/Headings";
import { ENDPOINTS, type SpecEndpoint } from "../../lib/api-spec";
import { SCOPE_DESCRIPTIONS, type Scope } from "../../lib/scopes";

interface ApiKeySummary {
  id: string;
  label: string;
  scopes?: Scope[];
  prefix?: string;
  disabled?: boolean;
}

interface KeyListResp {
  items: ApiKeySummary[];
}

const fetcher = async (url: string): Promise<KeyListResp> => {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 401) return { items: [] };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as KeyListResp;
};

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
      aria-label={done ? "Copied" : label}
    >
      {done ? <Check size={12} weight="duotone" /> : <Copy size={12} weight="duotone" />}
      <span>{done ? "copied" : label}</span>
    </button>
  );
}

function CodeBlock({
  children,
  language,
  copy,
}: {
  children: string;
  language?: string;
  copy?: boolean;
}) {
  return (
    <div className="relative group">
      <pre
        className="mono text-[12px] leading-[1.55] bg-[var(--color-paper-3)] border border-[var(--color-rule)] rounded-sm p-3 overflow-x-auto whitespace-pre"
        aria-label={language ? `${language} code sample` : "code sample"}
      >
        <code>{children}</code>
      </pre>
      {copy ? (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton text={children} />
        </div>
      ) : null}
    </div>
  );
}

function MethodPill({ method }: { method: "GET" | "POST" }) {
  const tone =
    method === "GET"
      ? "text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-800 dark:bg-emerald-900/20"
      : "text-violet-700 border-violet-300 bg-violet-50 dark:text-violet-300 dark:border-violet-800 dark:bg-violet-900/20";
  return (
    <span
      className={`mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border ${tone}`}
    >
      {method}
    </span>
  );
}

interface TryResult {
  status: number;
  ms: number;
  body: string;
}

function EndpointCard({
  ep,
  baseHost,
  apiKey,
  hasKeyScope,
}: {
  ep: SpecEndpoint;
  baseHost: string;
  apiKey: string;
  hasKeyScope: boolean;
}) {
  const [pathOverride, setPathOverride] = useState<string>("");
  const [bodyDraft, setBodyDraft] = useState<string>(ep.sampleBody ?? "");
  const [result, setResult] = useState<TryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const effectivePath = useMemo(() => {
    if (!ep.path.includes("{")) return ep.path;
    const v = pathOverride.trim() || "abc1234567";
    return ep.path.replace(/\{\w+\}/, encodeURIComponent(v));
  }, [ep.path, pathOverride]);

  const curlText = ep.curl(baseHost || "http://localhost:3000", apiKey || "$CODECLONE_KEY");

  async function runIt() {
    setErr(null);
    setResult(null);
    if (!apiKey) {
      setErr("Paste an API key first. Create one on the API keys page.");
      return;
    }
    setRunning(true);
    const start = performance.now();
    try {
      const url = `${baseHost}${effectivePath}`;
      const init: RequestInit = {
        method: ep.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(ep.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
      };
      if (ep.method === "POST") {
        init.body = bodyDraft || "{}";
      }
      const r = await fetch(url, init);
      const ms = Math.round(performance.now() - start);
      let text = await r.text();
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is */
      }
      setResult({ status: r.status, ms, body: text });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const hasPathParam = ep.params.some((p) => p.kind === "path");

  return (
    <section
      id={ep.id}
      className="border border-[var(--color-rule)] rounded-sm bg-[var(--color-paper)] overflow-hidden scroll-mt-20"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-paper-3)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--color-accent)]"
        aria-expanded={open}
        aria-controls={`${ep.id}-body`}
      >
        <MethodPill method={ep.method} />
        <code className="mono text-[13px] text-[var(--color-ink)] truncate">{ep.path}</code>
        <span className="ml-auto mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] hidden sm:inline">
          scope: {ep.scope}
        </span>
        <CaretDown
          size={14}
          weight="duotone"
          className={`shrink-0 text-[var(--color-ink-3)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div id={`${ep.id}-body`} className="px-4 pb-5 pt-1 space-y-5 border-t border-[var(--color-rule)]">
          <p className="text-[13px] text-[var(--color-ink-2)]">{ep.summary}</p>

          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
              required scope
            </span>
            <code className="mono text-[11px] px-1.5 py-0.5 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">
              {ep.scope}
            </code>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {SCOPE_DESCRIPTIONS[ep.scope]}
            </span>
            {apiKey && !hasKeyScope ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                <Warning size={12} weight="duotone" />
                your saved keys may lack this scope
              </span>
            ) : null}
          </div>

          {ep.params.length ? (
            <div>
              <h3 className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-2">
                parameters
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="text-left text-[var(--color-ink-4)]">
                      <th className="font-normal py-1 pr-3">name</th>
                      <th className="font-normal py-1 pr-3">in</th>
                      <th className="font-normal py-1 pr-3">type</th>
                      <th className="font-normal py-1">description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ep.params.map((p) => (
                      <tr
                        key={`${p.kind}-${p.name}`}
                        className="border-t border-[var(--color-rule)] align-top"
                      >
                        <td className="py-1.5 pr-3 mono">
                          {p.name}
                          {p.required ? (
                            <span className="text-red-600 dark:text-red-400"> *</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-3 mono text-[var(--color-ink-3)]">{p.kind}</td>
                        <td className="py-1.5 pr-3 mono text-[var(--color-ink-3)]">{p.type}</td>
                        <td className="py-1.5 text-[var(--color-ink-2)]">{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
                curl
              </h3>
              <CopyButton text={curlText} label="copy curl" />
            </div>
            <CodeBlock language="bash">{curlText}</CodeBlock>
          </div>

          <div>
            <h3 className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-1.5">
              sample response
            </h3>
            <CodeBlock language="json" copy>
              {ep.sampleResponse}
            </CodeBlock>
          </div>

          <div className="border-t border-[var(--color-rule)] pt-4 space-y-3">
            <div className="flex items-center gap-2">
              <Lightning size={14} weight="duotone" className="text-[var(--color-accent)]" />
              <h3 className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink)]">
                try it
              </h3>
            </div>

            {hasPathParam ? (
              <div>
                <label
                  htmlFor={`${ep.id}-path`}
                  className="block mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-1"
                >
                  path id
                </label>
                <input
                  id={`${ep.id}-path`}
                  type="text"
                  value={pathOverride}
                  onChange={(e) => setPathOverride(e.target.value)}
                  placeholder="abc1234567"
                  className="w-full mono text-[12px] px-2 py-1.5 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </div>
            ) : null}

            {ep.method === "POST" && ep.sampleBody ? (
              <div>
                <label
                  htmlFor={`${ep.id}-body-input`}
                  className="block mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-1"
                >
                  request body
                </label>
                <textarea
                  id={`${ep.id}-body-input`}
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="w-full mono text-[12px] leading-[1.5] px-2 py-1.5 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </div>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={runIt}
                disabled={running}
                className="inline-flex items-center gap-2 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              >
                <PaperPlaneTilt size={12} weight="duotone" />
                {running ? "running..." : "send request"}
              </button>
              {result ? (
                <span className="mono text-[11px] text-[var(--color-ink-3)]">
                  {result.status} &middot; {result.ms} ms
                </span>
              ) : null}
            </div>

            {err ? (
              <div className="text-[12px] text-red-700 dark:text-red-400 flex items-start gap-1.5">
                <Warning size={12} weight="duotone" className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            ) : null}

            {result ? (
              <div>
                <h4 className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-1.5">
                  response
                </h4>
                <CodeBlock language="json" copy>
                  {result.body}
                </CodeBlock>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

const ERROR_SAMPLE = `{
  "error": {
    "type": "unauthorized",
    "message": "Missing API key. Pass 'Authorization: Bearer <key>'."
  }
}`;

export default function DocsPage() {
  const [baseHost, setBaseHost] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [keyHydrated, setKeyHydrated] = useState(false);

  useEffect(() => {
    setBaseHost(window.location.origin);
    try {
      const cached = window.localStorage.getItem("codeclone:docs:key");
      if (cached) setApiKey(cached);
    } catch {
      /* ignore */
    }
    setKeyHydrated(true);
  }, []);

  useEffect(() => {
    if (!keyHydrated) return;
    try {
      if (apiKey) window.localStorage.setItem("codeclone:docs:key", apiKey);
      else window.localStorage.removeItem("codeclone:docs:key");
    } catch {
      /* ignore */
    }
  }, [apiKey, keyHydrated]);

  const { data: keyList, error: keyErr, isLoading: keysLoading } = useSWR<KeyListResp>(
    "/api/api-keys",
    fetcher,
  );

  function hasKeyScope(scope: Scope): boolean {
    if (!keyList?.items?.length) return true;
    return keyList.items.some((k) => !k.scopes || k.scopes.includes(scope));
  }

  return (
    <main className="mx-auto max-w-[1024px] px-4 sm:px-7 py-8 sm:py-10 space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-[var(--color-ink-3)]">
          <Book size={16} weight="duotone" />
          <span className="mono text-[11px] uppercase tracking-[0.14em]">api reference</span>
        </div>
        <H1>codeclone v1 API</H1>
        <p className="text-[14px] text-[var(--color-ink-2)] max-w-prose">
          Score code similarity, run bulk comparisons, and pull saved results from your own
          tools. Every call is authenticated with a personal API key and counts against your
          free-tier quota.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <Link
            href="/api-keys"
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-3)]"
          >
            <Key size={12} weight="duotone" /> manage keys
          </Link>
          <Link
            href="/usage"
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-3)]"
          >
            <Lightning size={12} weight="duotone" /> usage and quota
          </Link>
        </div>
      </header>

      <section className="border border-[var(--color-rule)] rounded-sm bg-[var(--color-paper)] p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} weight="duotone" className="text-[var(--color-accent)]" />
          <H2>Authentication</H2>
        </div>
        <p className="text-[13px] text-[var(--color-ink-2)]">
          Send your key as a Bearer token on every request. The header
          <code className="mono text-[12px] mx-1 px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">
            x-api-key
          </code>
          is accepted as a fallback. Keys are shown once at creation and stored hashed at rest.
        </p>
        <CodeBlock language="bash" copy>
          {`Authorization: Bearer ck_live_xxxxxxxxxxxxxxxx`}
        </CodeBlock>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label
              htmlFor="docs-key-input"
              className="block mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-1"
            >
              your api key (used only for try-it from this browser)
            </label>
            <input
              id="docs-key-input"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ck_live_..."
              className="w-full mono text-[12px] px-2.5 py-1.5 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            {keysLoading ? (
              <div className="mt-1 h-3 w-40 rounded-sm bg-[var(--color-paper-3)] animate-pulse" />
            ) : keyErr ? (
              <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">
                Could not load your keys. Try-it will still work if you paste one.
              </p>
            ) : keyList && keyList.items.length === 0 ? (
              <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">
                No keys yet.{" "}
                <Link href="/api-keys" className="underline">
                  Create one
                </Link>{" "}
                then paste the plaintext value here.
              </p>
            ) : keyList ? (
              <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">
                You have {keyList.items.length} key
                {keyList.items.length === 1 ? "" : "s"} on file. Paste any plaintext value here.
                The value stays in your browser only.
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setApiKey("")}
              disabled={!apiKey}
              className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)] disabled:opacity-40"
            >
              clear
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Code size={14} weight="duotone" />
          <H2>Endpoints</H2>
        </div>
        <nav aria-label="Endpoint index" className="flex flex-wrap gap-2 text-[12px]">
          {ENDPOINTS.map((e) => (
            <a
              key={e.id}
              href={`#${e.id}`}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]"
            >
              <MethodPill method={e.method} />
              {e.path}
            </a>
          ))}
        </nav>

        <div className="space-y-3">
          {ENDPOINTS.map((ep) => (
            <EndpointCard
              key={ep.id}
              ep={ep}
              baseHost={baseHost}
              apiKey={apiKey}
              hasKeyScope={hasKeyScope(ep.scope)}
            />
          ))}
        </div>
      </section>

      <section className="border border-[var(--color-rule)] rounded-sm bg-[var(--color-paper)] p-4 sm:p-5 space-y-3">
        <H2>Errors</H2>
        <p className="text-[13px] text-[var(--color-ink-2)]">
          Every error returns a structured JSON body so you can branch on
          <code className="mono text-[12px] mx-1 px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">
            error.type
          </code>
          instead of HTTP status alone. Common types: <code className="mono text-[12px] px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">unauthorized</code>, <code className="mono text-[12px] px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">invalid_request</code>, <code className="mono text-[12px] px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">quota_exceeded</code>, and <code className="mono text-[12px] px-1 rounded-sm bg-[var(--color-paper-3)] border border-[var(--color-rule)]">not_found</code>.
        </p>
        <CodeBlock language="json" copy>
          {ERROR_SAMPLE}
        </CodeBlock>
      </section>
    </main>
  );
}
