// Markdown report for a saved /r/<id> comparison.
//
// Renders the same shape the /compare page's "download md" button
// produces, but driven off the saved ShareRecord so a reviewer who
// only has the public share link can still drop a clean PR/ticket/
// Slack summary without re-running the comparison locally.
//
// Kept as a pure string builder (no fs, no fetch, no next runtime)
// so the share GET route and the future tests can call it directly
// under node --test.
import type { ShareRecord } from "./share";

function pct(n: number): string {
  return `${(Math.max(0, Math.min(1, n)) * 100).toFixed(1)}%`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function buildShareMarkdown(rec: ShareRecord): string {
  const { id, a, b, language, result, title, tags, createdAt } = rec;
  const fence = language && language !== "auto" ? language : "";
  const lines: string[] = [];
  lines.push(`# codeclone comparison`);
  lines.push("");
  if (title) lines.push(`- title: ${title}`);
  lines.push(`- share: \`/r/${id}\``);
  lines.push(`- saved: ${isoFromMs(createdAt)}`);
  lines.push(`- exported: ${new Date().toISOString()}`);
  lines.push(`- method: \`${result.method}\` · ${result.latency_ms.toFixed(2)} ms · ${result.bytes.a}/${result.bytes.b} bytes · lang \`${result.language}\``);
  lines.push(`- clone: **${result.clone.label}** (${result.clone.type}, confidence ${result.clone.confidence.toFixed(2)})`);
  if (tags && tags.length > 0) {
    lines.push(`- tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
  }
  lines.push("");
  lines.push(`## scores`);
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| shingle jaccard (5-gram) | ${pct(result.scores.shingleJaccard)} |`);
  lines.push(`| token jaccard | ${pct(result.scores.tokenJaccard)} |`);
  lines.push(`| containment (min-side) | ${pct(result.scores.containment)} |`);
  lines.push(`| shared shingles | ${result.scores.shared.shingles} / ${result.scores.size.aShingles + result.scores.size.bShingles - result.scores.shared.shingles} |`);
  lines.push("");
  if (result.scores.matchedTokens.length > 0) {
    lines.push(`## shared identifiers (${result.scores.matchedTokens.length})`);
    lines.push("");
    lines.push(result.scores.matchedTokens.map((t) => `\`${t}\``).join(", "));
    lines.push("");
  }
  lines.push(`## snippet A`);
  lines.push("");
  lines.push("```" + fence);
  lines.push(a);
  lines.push("```");
  lines.push("");
  lines.push(`## snippet B`);
  lines.push("");
  lines.push("```" + fence);
  lines.push(b);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
