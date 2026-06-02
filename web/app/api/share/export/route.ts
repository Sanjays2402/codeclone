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
  const languageRaw = url.searchParams.get("language");
  const language =
    languageRaw && languageRaw.toLowerCase() !== "all" ? languageRaw : undefined;
  const labelRaw = url.searchParams.get("label");
  const cloneLabel =
    labelRaw && labelRaw.toLowerCase() !== "all" ? labelRaw : undefined;
  const minScoreRaw = url.searchParams.get("minScore");
  let minScore: number | undefined;
  if (minScoreRaw !== null && minScoreRaw !== "") {
    const n = Number(minScoreRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return NextResponse.json(
        { error: "minScore must be a number in [0, 1]." },
        { status: 400 },
      );
    }
    minScore = n;
  }
  const maxScoreRaw = url.searchParams.get("maxScore");
  let maxScore: number | undefined;
  if (maxScoreRaw !== null && maxScoreRaw !== "") {
    const n = Number(maxScoreRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return NextResponse.json(
        { error: "maxScore must be a number in [0, 1]." },
        { status: 400 },
      );
    }
    maxScore = n;
  }
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
      language,
      cloneLabel,
      minScore,
      maxScore,
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
