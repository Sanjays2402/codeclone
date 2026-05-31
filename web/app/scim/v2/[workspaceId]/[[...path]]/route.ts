/**
 * SCIM 2.0 endpoints (RFC 7644).
 *
 * URL shape: /scim/v2/<workspaceId>/<...>
 *   Users                       list + create
 *   Users/<id>                  get + put + patch + delete
 *   ServiceProviderConfig       discovery
 *   Schemas                     schema doc
 *   ResourceTypes               resource types
 *
 * Auth: Bearer token issued at /api/workspaces/<id>/scim. The token is
 * bound to a single workspaceId; presenting workspace A's token at
 * workspace B's URL is rejected (tested in tests/scim.test.ts).
 *
 * Every mutating call (create, replace, patch, delete) writes an audit
 * entry tagged with workspaceId, the SCIM resource id, and a before/after
 * diff so workspace owners can review IdP provisioning activity.
 */
import { NextResponse } from "next/server";
import {
  verifyScimToken,
  listUsers,
  getUser,
  createUser,
  replaceUser,
  patchUser,
  deleteUser,
  findUserByUserName,
  serviceProviderConfig,
  resourceTypes,
  userSchemaDoc,
  scimBaseUrl,
  scimErrorBody,
  ScimError,
  SCIM_SCHEMA_USER,
} from "../../../../../lib/scim";
import { getWorkspace } from "../../../../../lib/workspaces";
import { tryRecordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCIM_CONTENT_TYPE = "application/scim+json";

function scimJson(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE },
  });
}

function errorResponse(status: number, detail: string, scimType?: string) {
  return scimJson(scimErrorBody(status, detail, scimType), status);
}

interface RouteCtx {
  params: Promise<{ workspaceId: string; path?: string[] }>;
}

async function authorize(req: Request, workspaceId: string) {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: errorResponse(404, "workspace not found") };
  const ok = await verifyScimToken({
    workspaceId,
    authHeader: req.headers.get("authorization"),
  });
  if (!ok) {
    await tryRecordAudit(req, {
      action: "scim.auth_denied",
      workspaceId,
      target: { type: "workspace", id: workspaceId, label: ws.name },
      status: "denied",
    });
    return {
      error: new NextResponse(JSON.stringify(scimErrorBody(401, "invalid or missing bearer token")), {
        status: 401,
        headers: {
          "content-type": SCIM_CONTENT_TYPE,
          "www-authenticate": `Bearer realm="scim", error="invalid_token"`,
        },
      }),
    };
  }
  return { ws };
}

function parseSegments(segments: string[] | undefined): { resource: string | null; id: string | null } {
  if (!segments || segments.length === 0) return { resource: null, id: null };
  return { resource: segments[0] ?? null, id: segments[1] ?? null };
}

export async function GET(req: Request, ctx: RouteCtx) {
  const { workspaceId, path } = await ctx.params;
  const auth = await authorize(req, workspaceId);
  if (auth.error) return auth.error;

  const { resource, id } = parseSegments(path);
  const base = scimBaseUrl(req, workspaceId);
  const url = new URL(req.url);

  try {
    if (resource === "ServiceProviderConfig") return scimJson(serviceProviderConfig(base));
    if (resource === "ResourceTypes") return scimJson(resourceTypes(base));
    if (resource === "Schemas") return scimJson(userSchemaDoc(base));
    if (resource === "Users" && !id) {
      const filter = url.searchParams.get("filter") ?? undefined;
      const startIndex = Number(url.searchParams.get("startIndex") ?? "1") || 1;
      const count = Number(url.searchParams.get("count") ?? "50") || 50;
      const list = await listUsers(workspaceId, base, { filter, startIndex, count });
      return scimJson(list);
    }
    if (resource === "Users" && id) {
      const u = await getUser(workspaceId, id, base);
      if (!u) return errorResponse(404, "user not found");
      return scimJson(u);
    }
    return errorResponse(404, "endpoint not found");
  } catch (err) {
    if (err instanceof ScimError) return errorResponse(err.status, err.message, err.scimType);
    return errorResponse(500, "internal error");
  }
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { workspaceId, path } = await ctx.params;
  const auth = await authorize(req, workspaceId);
  if (auth.error) return auth.error;
  const ws = auth.ws!;

  const { resource, id } = parseSegments(path);
  if (resource !== "Users" || id) return errorResponse(404, "endpoint not found");

  const base = scimBaseUrl(req, workspaceId);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return errorResponse(400, "invalid json", "invalidSyntax"); }
  if (Array.isArray(body.schemas) && !body.schemas.includes(SCIM_SCHEMA_USER)) {
    return errorResponse(400, "schemas must include core User", "invalidSyntax");
  }
  try {
    const created = await createUser({ workspaceId, body, baseUrl: base });
    await tryRecordAudit(req, {
      action: "scim.user_create",
      workspaceId,
      target: { type: "scim_user", id: created.id, label: created.userName },
      diff: { after: { userName: created.userName, active: created.active, externalId: created.externalId } },
      meta: { ws: ws.name },
    });
    return new NextResponse(JSON.stringify(created), {
      status: 201,
      headers: { "content-type": SCIM_CONTENT_TYPE, "location": created.meta.location },
    });
  } catch (err) {
    if (err instanceof ScimError) {
      // Idempotency aid: on 409 surface the existing resource via Location header.
      let location: string | undefined;
      if (err.status === 409 && typeof body.userName === "string") {
        const existing = await findUserByUserName(workspaceId, body.userName);
        if (existing) location = `${base}/Users/${existing.id}`;
      }
      const res = errorResponse(err.status, err.message, err.scimType);
      if (location) res.headers.set("location", location);
      return res;
    }
    return errorResponse(500, "internal error");
  }
}

export async function PUT(req: Request, ctx: RouteCtx) {
  const { workspaceId, path } = await ctx.params;
  const auth = await authorize(req, workspaceId);
  if (auth.error) return auth.error;

  const { resource, id } = parseSegments(path);
  if (resource !== "Users" || !id) return errorResponse(404, "endpoint not found");

  const base = scimBaseUrl(req, workspaceId);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return errorResponse(400, "invalid json", "invalidSyntax"); }
  const before = await getUser(workspaceId, id, base);
  if (!before) return errorResponse(404, "user not found");
  try {
    const updated = await replaceUser({ workspaceId, id, body, baseUrl: base });
    if (!updated) return errorResponse(404, "user not found");
    await tryRecordAudit(req, {
      action: "scim.user_replace",
      workspaceId,
      target: { type: "scim_user", id: updated.id, label: updated.userName },
      diff: {
        before: { userName: before.userName, active: before.active },
        after: { userName: updated.userName, active: updated.active },
      },
    });
    return scimJson(updated);
  } catch (err) {
    if (err instanceof ScimError) return errorResponse(err.status, err.message, err.scimType);
    return errorResponse(500, "internal error");
  }
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { workspaceId, path } = await ctx.params;
  const auth = await authorize(req, workspaceId);
  if (auth.error) return auth.error;

  const { resource, id } = parseSegments(path);
  if (resource !== "Users" || !id) return errorResponse(404, "endpoint not found");

  const base = scimBaseUrl(req, workspaceId);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return errorResponse(400, "invalid json", "invalidSyntax"); }
  const before = await getUser(workspaceId, id, base);
  if (!before) return errorResponse(404, "user not found");
  try {
    const updated = await patchUser({ workspaceId, id, body, baseUrl: base });
    if (!updated) return errorResponse(404, "user not found");
    await tryRecordAudit(req, {
      action: "scim.user_patch",
      workspaceId,
      target: { type: "scim_user", id: updated.id, label: updated.userName },
      diff: {
        before: { active: before.active, displayName: before.displayName },
        after: { active: updated.active, displayName: updated.displayName },
      },
    });
    return scimJson(updated);
  } catch (err) {
    if (err instanceof ScimError) return errorResponse(err.status, err.message, err.scimType);
    return errorResponse(500, "internal error");
  }
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { workspaceId, path } = await ctx.params;
  const auth = await authorize(req, workspaceId);
  if (auth.error) return auth.error;

  const { resource, id } = parseSegments(path);
  if (resource !== "Users" || !id) return errorResponse(404, "endpoint not found");

  const base = scimBaseUrl(req, workspaceId);
  const before = await getUser(workspaceId, id, base);
  const ok = await deleteUser(workspaceId, id);
  if (!ok) return errorResponse(404, "user not found");
  await tryRecordAudit(req, {
    action: "scim.user_delete",
    workspaceId,
    target: { type: "scim_user", id, label: before?.userName ?? id },
    diff: { before: before ? { userName: before.userName, active: before.active } : null, after: null },
  });
  return new NextResponse(null, { status: 204 });
}
