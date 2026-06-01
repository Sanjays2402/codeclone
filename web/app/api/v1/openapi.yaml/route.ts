/**
 * Public GET /v1/openapi.yaml: same OpenAPI 3.1 document as
 * /v1/openapi.json, served as application/yaml for tools that prefer
 * YAML input (openapi-generator-cli, Redoc, swagger-cli lint, etc.).
 */
import { buildOpenApi, toYaml } from "../../../../lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = `${url.protocol}//${url.host}`;
  const doc = buildOpenApi(host);
  const body = toYaml(doc);
  return new Response(body, {
    headers: {
      "Content-Type": "application/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-CodeClone-API": "v1",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
