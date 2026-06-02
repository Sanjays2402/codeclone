import { NextResponse } from "next/server";
import {
  createWebhook,
  listWebhooksForWorkspace,
  validateWorkspaceId,
  type WebhookSummary,
} from "../../../lib/webhooks";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { enforceMfaEnrollment } from "../../../lib/mfa-enforce";
import { getWorkspace, getActiveMember } from "../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage webhooks." } },
    { status: 401 },
  );
}

function forbidden(message = "You are not a member of that workspace.") {
  return NextResponse.json(
    { error: { type: "forbidden", message } },
    { status: 403 },
  );
}

function badWorkspace() {
  return NextResponse.json(
    { error: { type: "invalid_workspace", message: "A valid workspaceId is required." } },
    { status: 400 },
  );
}

async function resolveWorkspaceForUser(req: Request, workspaceIdRaw: unknown) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return { error: unauthorized() };
  const wsId = validateWorkspaceId(workspaceIdRaw);
  if (!wsId) return { error: badWorkspace() };
  const ws = await getWorkspace(wsId);
  if (!ws) return { error: forbidden() };
  const member = getActiveMember(ws, user.id);
  if (!member) return { error: forbidden() };
  return { user, ws, member };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function webhooksToCsv(rows: ReadonlyArray<WebhookSummary>): string {
  const header = [
    "id",
    "label",
    "url",
    "events",
    "disabled",
    "secret_prefix",
    "pending_secret_prefix",
    "created_at",
    "updated_at",
    "success_count",
    "failure_count",
    "last_delivery_at",
    "last_status",
    "last_error",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.label),
        csvCell(r.url),
        csvCell((r.events ?? []).join("|")),
        csvCell(r.disabled ? "true" : "false"),
        csvCell(r.secretPrefix),
        csvCell(r.pendingSecretPrefix),
        csvCell(r.createdAt),
        csvCell(r.updatedAt),
        csvCell(r.successCount),
        csvCell(r.failureCount),
        csvCell(r.lastDeliveryAt),
        csvCell(r.lastStatus),
        csvCell(r.lastError),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = await resolveWorkspaceForUser(req, url.searchParams.get("workspaceId"));
  if ("error" in r) return r.error;
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "format must be 'json' (default) or 'csv'.",
        },
      },
      { status: 400 },
    );
  }
  const items = await listWebhooksForWorkspace(r.ws.id);
  void tryRecordAudit(req, {
    action: "webhooks.read",
    actorId: r.user.id,
    actorEmail: r.user.email,
    target: { type: "webhook_inventory", id: r.ws.id },
    status: "ok",
    meta: { workspaceId: r.ws.id, count: items.length, format },
  });
  if (format === "csv") {
    const csv = webhooksToCsv(items);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-${r.ws.id}-webhooks.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ items, workspaceId: r.ws.id });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const b = (body ?? {}) as {
    label?: unknown;
    url?: unknown;
    events?: unknown;
    workspaceId?: unknown;
  };
  const r = await resolveWorkspaceForUser(req, b.workspaceId);
  if ("error" in r) return r.error;
    // Only owners/editors may create webhooks; viewers are read-only.
  if (r.member.role === "viewer") {
    return forbidden("Viewers cannot create webhooks.");
  }
  const mfaBlocked = await enforceMfaEnrollment(req, r.user, "webhook.create");
  if (mfaBlocked) return mfaBlocked;
  try {
    const created = await createWebhook({
      label: b.label,
      url: b.url,
      events: b.events,
      workspaceId: r.ws.id,
      domainAllowlist: r.ws.webhookDomainAllowlist ?? [],
    });
    await tryRecordAudit(req, {
      action: "webhook.create",
      actorId: r.user.id,
      actorEmail: r.user.email,
      workspaceId: r.ws.id,
      target: { type: "webhook", id: created.record.id, label: created.record.label },
      diff: { after: { url: created.record.url, events: created.record.events } },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create webhook." },
      { status: 400 },
    );
  }
}
