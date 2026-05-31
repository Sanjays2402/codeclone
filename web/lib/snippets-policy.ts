/**
 * Snippet sharing policy.
 *
 * Enterprise customers tag each saved snippet with a data classification
 * label (public / internal / confidential / restricted). The workspace
 * owner sets a ceiling on which labels may leave the workspace as a
 * share (public link, PDF export, embed). This file is the single
 * source of truth for that decision so the API route, the snippet UI,
 * and any future PDF/export path all reach the same verdict.
 *
 * Cross-tenant safety: callers pass an explicit list of workspaces the
 * user belongs to. The ceiling is the MOST permissive ceiling among
 * those workspaces (a user can always share through whichever of their
 * workspaces allows it). If the user has no workspace, the global
 * default ceiling applies.
 */
import {
  classificationRank,
  DEFAULT_SNIPPET_CLASSIFICATION,
  SNIPPET_CLASSIFICATIONS,
} from "./snippets.ts";
import type { SnippetClassification, SnippetRecord } from "./snippets.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

/**
 * Default ceiling when no workspace policy is set. "internal" matches
 * the default snippet classification, so out of the box every user can
 * share their own internal snippets but confidential and restricted are
 * blocked until an owner opts in.
 */
export const DEFAULT_MAX_SHARE_CLASSIFICATION: SnippetClassification = "internal";

export function workspaceMaxShareClassification(
  ws: WorkspaceRecord | null | undefined,
): SnippetClassification {
  const v = ws?.snippetMaxShareClassification;
  if (
    typeof v === "string" &&
    (SNIPPET_CLASSIFICATIONS as readonly string[]).includes(v)
  ) {
    return v as SnippetClassification;
  }
  return DEFAULT_MAX_SHARE_CLASSIFICATION;
}

/**
 * Most permissive ceiling across a user's workspaces. When the user has
 * no workspaces we fall back to the global default so the product still
 * works for new accounts (they can share public + internal).
 */
export function effectiveShareCeiling(
  workspaces: WorkspaceRecord[],
): SnippetClassification {
  if (!workspaces || workspaces.length === 0) {
    return DEFAULT_MAX_SHARE_CLASSIFICATION;
  }
  let best: SnippetClassification = "public";
  for (const ws of workspaces) {
    const c = workspaceMaxShareClassification(ws);
    if (classificationRank(c) > classificationRank(best)) best = c;
  }
  return best;
}

export interface ShareDecision {
  allowed: boolean;
  reason: string;
  classification: SnippetClassification;
  ceiling: SnippetClassification;
}

/**
 * Decide whether a snippet may be turned into an outbound share given
 * the effective workspace ceiling. The reason string is safe to surface
 * to end users.
 */
export function decideSnippetShare(
  snippet: Pick<SnippetRecord, "classification"> | { classification?: SnippetClassification },
  workspaces: WorkspaceRecord[],
): ShareDecision {
  const classification = (snippet.classification ??
    DEFAULT_SNIPPET_CLASSIFICATION) as SnippetClassification;
  const ceiling = effectiveShareCeiling(workspaces);
  const allowed = classificationRank(classification) <= classificationRank(ceiling);
  const reason = allowed
    ? `${classification} is within the workspace ceiling (${ceiling}).`
    : `Workspace policy blocks sharing of ${classification} snippets. Current ceiling is ${ceiling}. Ask a workspace owner to raise it in workspace settings.`;
  return { allowed, reason, classification, ceiling };
}
