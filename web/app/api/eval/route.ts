import { NextResponse } from "next/server";
import { loadEvalReports } from "../../../lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: await loadEvalReports() });
}
