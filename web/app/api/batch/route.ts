import { NextResponse } from "next/server";
import { parseBatch, runBatch, type BatchInput, type MatrixCell } from "../../../lib/batch";

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
  return NextResponse.json(result);
}
