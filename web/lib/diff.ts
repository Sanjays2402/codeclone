/**
 * Token-level diff utility.
 *
 * Produces a per-line alignment of prefix vs completion, marking each line as
 * "same" (substring overlap above threshold), "near" (some matched identifiers),
 * or "diff". Inside each near/same line we emit token spans flagged matched/no.
 *
 * No diff library — intentional. Keeps deps small and the visual is consistent
 * with the rest of the surface.
 */

export type LineStatus = "same" | "near" | "diff" | "empty";

export interface DiffToken {
  text: string;
  matched: boolean;
}

export interface DiffLine {
  n: number;
  status: LineStatus;
  tokens: DiffToken[];
}

const TOKEN_RE = /([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[ \t]+|[^\sA-Za-z0-9])/g;

function lineTokens(line: string): string[] {
  return line.match(TOKEN_RE) ?? [];
}

function buildIdentifierSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    out.add(tok);
  }
  return out;
}

export interface DiffResult {
  left: DiffLine[];
  right: DiffLine[];
  matchedTokens: number;
  totalTokens: number;
}

export function alignPair(left: string, right: string): DiffResult {
  const lLines = left.split("\n");
  const rLines = right.split("\n");
  const leftIds = buildIdentifierSet(left);
  const rightIds = buildIdentifierSet(right);

  let matched = 0;
  let total = 0;

  const dress = (line: string, oppositeIds: Set<string>, n: number): DiffLine => {
    const stripped = line.trim();
    if (stripped.length === 0) return { n, status: "empty", tokens: [{ text: line, matched: false }] };
    const tokens: DiffToken[] = [];
    let same = 0;
    let identCount = 0;
    for (const raw of lineTokens(line)) {
      const isIdent = /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(raw);
      const isMatch = isIdent && oppositeIds.has(raw);
      tokens.push({ text: raw, matched: isMatch });
      if (isIdent) {
        identCount++;
        total++;
        if (isMatch) { same++; matched++; }
      }
    }
    let status: LineStatus = "diff";
    if (identCount === 0) status = "near";
    else if (same === identCount) status = "same";
    else if (same > 0) status = "near";
    return { n, status, tokens };
  };

  const leftOut = lLines.map((l, i) => dress(l, rightIds, i + 1));
  const rightOut = rLines.map((l, i) => dress(l, leftIds, i + 1));

  return { left: leftOut, right: rightOut, matchedTokens: matched, totalTokens: total };
}

export function statusGlyph(s: LineStatus): string {
  switch (s) {
    case "same": return "●";
    case "near": return "○";
    case "diff": return "+";
    case "empty": return " ";
  }
}
