import { NextResponse } from "next/server";
import { exportShares, type ExportFormat } from "../../../../lib/share";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser } from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fmtRaw = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (fmtRaw !== "csv" && fmtRaw !== "json") {
    return NextResponse.json(
      { error: "format must be 'csv' or 'json'." },
      { status: 400 },
    );
  }
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 10000) {
      return NextResponse.json(
        { error: "limit must be 1..10000." },
        { status: 400 },
      );
    }
    limit = n;
  }
  try {
    const origin = `${url.protocol}//${url.host}`;
    // Tenant-scope the export so a user can only download their own
    // workspace's saved comparisons (plus legacy unscoped records).
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    let workspaceId: string | null = null;
    if (user) {
      const wss = await listWorkspacesForUser(user.id);
      workspaceId = wss[0]?.id ?? null;
    }
    const out = await exportShares({
      format: fmtRaw as ExportFormat,
      q,
      tag,
      limit,
      origin,
      workspaceId,
      allowLegacy: true,
    });
    return new NextResponse(out.body, {
      status: 200,
      headers: {
        "Content-Type": out.contentType,
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "Cache-Control": "no-store",
        "X-Codeclone-Export-Count": String(out.count),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
