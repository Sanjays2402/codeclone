"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldStar, FloppyDisk, Warning } from "@phosphor-icons/react/dist/ssr";

type Level = "public" | "internal" | "confidential" | "restricted";

interface PolicyResponse {
  level: Level;
  defaultLevel: Level;
  levels: readonly Level[];
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

const LEVEL_BLURB: Record<Level, string> = {
  public: "any snippet, including public ones, may leave the workspace as a share.",
  internal: "public and internal snippets may be shared. confidential and restricted are blocked.",
  confidential: "public, internal, and confidential snippets may be shared. restricted is blocked.",
  restricted: "every classification may be shared. use with care.",
};

/**
 * Workspace snippet share-classification ceiling editor.
 *
 * Owners decide the most permissive data classification label that a
 * saved snippet may carry and still be turned into an outbound share.
 * The /api/snippets/[id]/share-policy endpoint consults this ceiling
 * for every share attempt so a tightened policy takes effect on the
 * next request.
 */
export function SnippetSharePolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("internal");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/snippet-share-policy`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setLevel(j.level);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/snippet-share-policy`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setLevel(j.level);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, level, workspaceId]);

  const dirty = data ? level !== data.level : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <ShieldStar weight="duotone" size={14} /> snippet share policy
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Choose the highest data classification label that members may
          turn into an outbound share. Snippets carrying a stricter label
          are blocked at the share endpoint and in the UI. The default is
          internal, which permits public and internal but blocks
          confidential and restricted.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]" role="status">
            loading...
          </div>
        )}

        {status === "error" && (
          <div
            className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5"
            role="alert"
          >
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            <fieldset className="mb-3" disabled={!data.canEdit || saving}>
              <legend className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-2">
                ceiling
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.levels.map((l) => (
                  <label
                    key={l}
                    className={`ruled rounded-sm px-3 py-2 cursor-pointer flex items-start gap-2 ${
                      level === l ? "border-[var(--color-ink)] bg-[var(--color-paper-2)]" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name={`snippet-share-${workspaceId}`}
                      value={l}
                      checked={level === l}
                      onChange={() => setLevel(l)}
                      className="mt-0.5"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="mono text-[11px] uppercase tracking-[0.14em]">
                        {l}
                      </span>
                      <span className="block text-[11.5px] text-[var(--color-ink-4)] mt-0.5">
                        {LEVEL_BLURB[l]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {!data.canEdit && (
              <p className="mono text-[10.5px] text-[var(--color-ink-4)] mb-2">
                Owners and admins only. Your current role cannot edit this policy.
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={!data.canEdit || !dirty || saving}
                className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-40"
              >
                <FloppyDisk weight="duotone" size={12} />
                {saving ? "saving" : "save"}
              </button>
              <span className="mono text-[10.5px] text-[var(--color-ink-4)]">
                effective: {data.level} (default {data.defaultLevel})
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
