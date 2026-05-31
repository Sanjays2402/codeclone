#!/usr/bin/env node
/**
 * One-off patcher: wires the dashboard IP allowlist gate into every
 * cookie-authenticated /api/workspaces/[id]/** route. Idempotent: if the
 * gate import is already present in a file, the file is left alone.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || "app/api/workspaces/[id]";
const FILES = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name === "route.ts") FILES.push(p);
  }
})(ROOT);

const GATE_MOD = "lib/dashboard-allowlist-enforce";

function relImport(fromFile) {
  // fromFile is like "app/api/workspaces/[id]/foo/route.ts"; need ../../../...
  const fromDir = path.dirname(fromFile);
  const rel = path.relative(fromDir, GATE_MOD).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : "./" + rel;
}

const AFTER = `if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });`;

let patched = 0;
for (const f of FILES) {
  let src = fs.readFileSync(f, "utf8");
  if (src.includes("enforceWorkspaceAllowlistForSession")) continue;
  const isAllowlistEdit = f.endsWith("/allowlist/route.ts");
  const surface = f
    .replace(/.*workspaces\/\[id\]\//, "workspaces/")
    .replace(/\/route\.ts$/, "");

  // Add import after the last existing import line.
  const importLine = `import { enforceWorkspaceAllowlistForSession } from "${relImport(f)}";`;
  const lines = src.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import .* from /.test(lines[i])) lastImport = i;
  }
  if (lastImport >= 0) lines.splice(lastImport + 1, 0, importLine);
  else lines.unshift(importLine);
  src = lines.join("\n");

  // Inject gate after every "not_found" return on a getWorkspace(id) result.
  const gateCall = (method) =>
    `\n  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "${surface}"${
      isAllowlistEdit ? `, bypass: ${method === "PUT" || method === "DELETE"}` : ""
    } });\n  if (__ipBlock) return __ipBlock;`;

  // Walk handler-by-handler to know the HTTP method (for allowlist bypass).
  const methodRe = /export async function (GET|PUT|POST|PATCH|DELETE)\b/g;
  // Split into segments per export so we can scope replacement.
  const segments = [];
  let last = 0;
  let m;
  const starts = [];
  while ((m = methodRe.exec(src))) starts.push({ idx: m.index, method: m[1] });
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].idx;
    const end = i + 1 < starts.length ? starts[i + 1].idx : src.length;
    const before = src.slice(last, start);
    let body = src.slice(start, end);
    body = body.replace(
      new RegExp(AFTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      AFTER + gateCall(starts[i].method),
    );
    segments.push(before, body);
    last = end;
  }
  segments.push(src.slice(last));
  src = segments.join("");

  fs.writeFileSync(f, src);
  patched++;
}
console.log(`patched ${patched} of ${FILES.length} route files`);
