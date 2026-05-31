import { NextResponse } from "next/server";
import { loadShare } from "../../../../../lib/share";
import { buildShareReportPdf } from "../../../../../lib/share-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await loadShare(id);
  if (!rec) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const bytes = await buildShareReportPdf(rec, { origin });
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, "");
    // Convert Uint8Array to a Buffer-friendly body. NextResponse accepts BodyInit.
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="codeclone-${safeId}.pdf"`,
        "Cache-Control": "no-store",
        "X-Codeclone-Report": "share",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
