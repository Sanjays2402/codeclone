/**
 * Build an OpenAPI 3.1 document describing the public /v1 API.
 *
 * Source of truth is the same ENDPOINTS table that powers /docs and
 * /v1/discovery. This file deliberately stays dependency-light (no
 * next/server, no node:fs) so it can be imported from node:test and
 * from React Server Components alike, and so SDK generators or API
 * gateways can consume the manifest at build time without dragging
 * the Next runtime in.
 *
 * Why this exists
 * ---------------
 * Enterprise procurement, API gateway operators, and SDK generators
 * (openapi-generator, Stainless, Speakeasy, Kong, AWS API Gateway,
 * Postman, Insomnia) all require a real OpenAPI document, not a
 * custom JSON manifest. Shipping /v1/openapi.json closes the last
 * "where is your OpenAPI spec?" question in security reviews and
 * unblocks any customer that wants to generate a typed client.
 *
 * Path templating
 * ---------------
 * api-spec.ts uses {brace} path templates already, which match
 * OpenAPI's path templating verbatim, so we do not need to rewrite
 * paths. Each `path` parameter declared in ENDPOINTS becomes a
 * required path parameter on the operation.
 */
import { ENDPOINTS, type SpecEndpoint, type SpecParam } from "./api-spec.ts";
import { ALL_SCOPES, SCOPE_DESCRIPTIONS, type Scope } from "./scopes.ts";
import { DEFAULT_RPM } from "./rate-limit.ts";

export interface OpenAPIDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    summary: string;
    description: string;
    contact: { name: string; url: string };
    license: { name: string; identifier: string };
  };
  servers: { url: string; description: string }[];
  security: { bearerAuth: string[] }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http";
        scheme: "bearer";
        bearerFormat: "API Key";
        description: string;
      };
    };
    parameters: Record<string, OpenAPIParameter>;
    responses: Record<string, OpenAPIResponse>;
    schemas: Record<string, Record<string, unknown>>;
  };
  "x-codeclone": {
    generated_at: string;
    scopes: Record<Scope, string>;
    rate_limit: { default_rpm: number; window_seconds: number };
    discovery_url: string;
  };
}

interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description: string;
  schema: { type: string };
}

interface OpenAPIRequestBody {
  required: boolean;
  content: {
    "application/json": {
      schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
      example?: unknown;
    };
  };
}

interface OpenAPIResponse {
  description: string;
  headers?: Record<string, { description: string; schema: { type: string } }>;
  content?: { "application/json": { example?: unknown } };
}

interface OpenAPIOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security: { bearerAuth: string[] }[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse | { $ref: string }>;
  "x-codeclone-scope": Scope;
  "x-codeclone-route-file": string;
}

const OPENAPI_TYPE: Record<string, string> = {
  string: "string",
  boolean: "boolean",
  integer: "integer",
  number: "number",
  object: "object",
  array: "array",
};

function toJsonType(declared: string): string {
  const lower = declared.toLowerCase();
  if (OPENAPI_TYPE[lower]) return OPENAPI_TYPE[lower];
  if (lower.startsWith("array") || lower.startsWith("[")) return "array";
  if (lower.includes("..")) return "integer"; // e.g. "1..100", "0..1"
  if (lower.includes("{") || lower.includes("<")) return "object";
  return "string";
}

function tryParseExample(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function tagFor(endpointId: string): string {
  const head = endpointId.split("-")[0];
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function buildOperation(e: SpecEndpoint): OpenAPIOperation {
  const params: OpenAPIParameter[] = [];
  const bodyProps: Record<string, unknown> = {};
  const bodyRequired: string[] = [];

  for (const p of e.params as SpecParam[]) {
    if (p.kind === "body") {
      bodyProps[p.name] = { type: toJsonType(p.type), description: p.description };
      if (p.required) bodyRequired.push(p.name);
    } else if (p.kind === "path" || p.kind === "query" || p.kind === "header") {
      params.push({
        name: p.name,
        in: p.kind,
        required: p.kind === "path" ? true : p.required,
        description: p.description,
        schema: { type: toJsonType(p.type) },
      });
    }
  }

  const op: OpenAPIOperation = {
    operationId: e.id.replace(/-/g, "_"),
    summary: e.summary,
    description: `${e.summary}\n\nRequires scope \`${e.scope}\`. See /v1/discovery for the live workspace policy snapshot.`,
    tags: [tagFor(e.id)],
    security: [{ bearerAuth: [e.scope] }],
    responses: {
      "200": {
        description: "Success",
        headers: {
          "X-RateLimit-Limit": { description: "Per-key RPM ceiling.", schema: { type: "integer" } },
          "X-RateLimit-Remaining": { description: "Requests remaining in current window.", schema: { type: "integer" } },
          "X-RateLimit-Reset": { description: "Epoch seconds when the window resets.", schema: { type: "integer" } },
          "X-Request-Id": { description: "Per-request id, echoed in audit logs.", schema: { type: "string" } },
        },
        content: {
          "application/json": {
            example: tryParseExample(e.sampleResponse),
          },
        },
      },
      "400": { $ref: "#/components/responses/BadRequest" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "404": { $ref: "#/components/responses/NotFound" },
      "429": { $ref: "#/components/responses/RateLimited" },
    },
    "x-codeclone-scope": e.scope,
    "x-codeclone-route-file": e.routeFile,
  };

  if (params.length > 0) op.parameters = params;
  if (bodyRequired.length > 0 || Object.keys(bodyProps).length > 0) {
    op.requestBody = {
      required: bodyRequired.length > 0,
      content: {
        "application/json": {
          schema: { type: "object", properties: bodyProps, required: bodyRequired },
          example: tryParseExample(e.sampleBody),
        },
      },
    };
  }

  return op;
}

export function buildOpenApi(host: string): OpenAPIDocument {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};

  for (const e of ENDPOINTS) {
    const path = e.path;
    if (!paths[path]) paths[path] = {};
    paths[path][e.method.toLowerCase()] = buildOperation(e);
  }

  const scopeMap: Record<string, string> = {};
  for (const s of ALL_SCOPES) scopeMap[s] = SCOPE_DESCRIPTIONS[s];

  const tags = Array.from(new Set(ENDPOINTS.map((e) => tagFor(e.id)))).map((t) => ({
    name: t,
    description: `Endpoints in the ${t} surface.`,
  }));

  return {
    openapi: "3.1.0",
    info: {
      title: "CodeClone API",
      version: "1.0.0",
      summary: "Code similarity and clone detection API.",
      description:
        "Public /v1 surface for the CodeClone platform. Every endpoint is scoped, " +
        "rate-limited, audit-logged, and tenant-isolated by workspace. See /v1/discovery " +
        "for the live workspace policy snapshot and /docs for the human-readable reference.",
      contact: { name: "CodeClone Security", url: `${host}/.well-known/security.txt` },
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: host, description: "Current host" }],
    security: [{ bearerAuth: [] }],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
          description:
            "Send `Authorization: Bearer ck_live_...`. Each key has an explicit scope set " +
            "from `x-codeclone.scopes`. Keys are workspace-scoped: every response is " +
            "filtered to the calling key's workspace.",
        },
      },
      parameters: {},
      responses: {
        BadRequest: {
          description: "Validation error.",
          content: { "application/json": { example: { error: { code: "bad_request", message: "Invalid body." } } } },
        },
        Unauthorized: {
          description: "Missing or invalid API key.",
          content: { "application/json": { example: { error: { code: "unauthorized", message: "Bearer key required." } } } },
        },
        Forbidden: {
          description: "Key lacks the required scope for this endpoint.",
          content: { "application/json": { example: { error: { code: "forbidden", message: "Key missing scope." } } } },
        },
        NotFound: {
          description: "Resource not found, or not visible to this workspace.",
          content: { "application/json": { example: { error: { code: "not_found", message: "Resource not found." } } } },
        },
        RateLimited: {
          description: "Per-key rate limit exceeded. Inspect Retry-After.",
          headers: {
            "Retry-After": { description: "Seconds until the next window opens.", schema: { type: "integer" } },
            "X-RateLimit-Limit": { description: "Per-key RPM ceiling.", schema: { type: "integer" } },
            "X-RateLimit-Remaining": { description: "Always 0 on 429.", schema: { type: "integer" } },
            "X-RateLimit-Reset": { description: "Epoch seconds when the window resets.", schema: { type: "integer" } },
          },
          content: { "application/json": { example: { error: { code: "rate_limited", message: "Too many requests." } } } },
        },
      },
      schemas: {},
    },
    "x-codeclone": {
      generated_at: new Date().toISOString(),
      scopes: scopeMap as Record<Scope, string>,
      rate_limit: { default_rpm: DEFAULT_RPM, window_seconds: 60 },
      discovery_url: `${host}/v1/discovery`,
    },
  };
}

/**
 * Minimal YAML serializer for the OpenAPI document. We avoid pulling
 * in a YAML dependency because the document is JSON-shaped (no funky
 * tags or anchors) and enterprise customers commonly want both
 * application/json and application/yaml available.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (value === "" || /[:#\-?&*!|>'"%@`{}\[\],\n]/.test(value) || /^\s|\s$/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (typeof item === "object" && item !== null) {
          const lines = rendered.split("\n");
          return `${pad}- ${lines[0].trimStart()}${lines.slice(1).length ? "\n" + lines.slice(1).join("\n") : ""}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const key = /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(k) ? k : JSON.stringify(k);
        if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
          return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${key}: ${toYaml(v, indent)}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}
