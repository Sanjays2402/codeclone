import { NextResponse } from "next/server";
import { exportAll } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const bundle = await exportAll();
  const body = JSON.stringify(bundle, null, 2);
  const stamp = new Date(bundle.exportedAt).toISOString().replace(/[:.]/g, "-");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="codeclone-export-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
