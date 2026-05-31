import { NextResponse } from "next/server";
import { parseBatch, runBatch, type BatchInput, type MatrixCell } from "../../../lib/batch";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { emitNotification } from "../../../lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type { MatrixCell };

export async function POST(req: Request) {
  let raw: BatchInput;
  try {
    raw = (await req.json()) as BatchInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseBatch(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = runBatch(parsed.snippets, parsed.language);
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (user) {
    const cells = Array.isArray((result as { cells?: unknown[] }).cells)
      ? (result as { cells: unknown[] }).cells.length
      : parsed.snippets.length * parsed.snippets.length;
    await emitNotification({
      userId: user.id,
      kind: "batch.completed",
      title: `Batch finished: ${parsed.snippets.length} snippets`,
      body: `Computed ${cells} pairwise scores on ${parsed.language}.`,
      href: "/batch",
      meta: { snippets: parsed.snippets.length, language: parsed.language },
    });
  }
  return NextResponse.json(result);
}
