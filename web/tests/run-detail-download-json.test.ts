// /eval/[runId] "Download JSON" button wiring.
//
// The run detail page is where a researcher reviewing an eval inspects the
// loss curve, per-case heatmap, and recipe metadata. There is already a
// "Download cases CSV" button for the per-case results, but the surrounding
// run record (params, metrics, eval report) was previously only reachable by
// copy-pasting from the rendered page. This pins a plain <a download> on top
// of /api/runs/[runId] so a full run snapshot is always one click away from
// the loss chart, mirroring the pair-detail download already shipping.
//
// Source-level so it runs with the same node --test rig the rest of the
// suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("run detail page exposes a Download JSON button on the header", async () => {
  const src = await read("app/eval/[runId]/page.tsx");
  assert.match(src, /Download JSON/, "must label the button so users find it next to the loss chart");
  assert.match(src, /DownloadSimple/, "must use the DownloadSimple icon to match the rest of the dashboard");
  assert.match(src, /import \{ DownloadSimple \} from "@phosphor-icons\/react\/dist\/ssr"/);
});

test("Download JSON button points at the /api/runs/[runId] endpoint", async () => {
  const src = await read("app/eval/[runId]/page.tsx");
  // The endpoint returns the full run record as JSON; we just want a browser
  // download instead of an in-tab render, so the href must be the API route
  // and the anchor must carry a download attribute.
  assert.match(src, /const jsonHref = `\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}`/, "must build the href from the run id, encoded for path safety");
  assert.match(src, /href=\{jsonHref\}/);
  assert.match(src, /download=\{jsonName\}/, "must set the download attribute so the file saves instead of navigating");
});

test("Download JSON filename is namespaced and filesystem-safe per run", async () => {
  const src = await read("app/eval/[runId]/page.tsx");
  // Run ids can contain slashes or other path-unsafe characters, so the
  // filename strips them down to a safe charset before saving. Keeping the
  // codeclone- prefix matches the rest of the dashboard's download names.
  assert.match(src, /const jsonName = `codeclone-run-\$\{run\.id\.replace\(\/\[\^A-Za-z0-9\._-\]\+\/g, "_"\)\}\.json`/);
});

test("API route at /api/runs/[runId] returns the raw run payload", async () => {
  const src = await read("app/api/runs/[runId]/route.ts");
  // Guard against the API contract drifting; the download button leans on
  // this route returning a JSON body of the run (not a wrapped envelope),
  // so flag any regression that changes the response shape.
  assert.match(src, /export async function GET/);
  assert.match(src, /loadRun\(decodeURIComponent\(runId\)\)/);
  assert.match(src, /return NextResponse\.json\(run\)/, "route must return the run record directly so the download is a self-contained JSON file");
});

test("API route at /api/runs/[runId] returns 404 for an unknown run", async () => {
  const src = await read("app/api/runs/[runId]/route.ts");
  // A missing run must surface as a 404 with the dashboard's error envelope
  // shape rather than a 200 with null, so the browser's download dialog
  // does not save an empty file when the id is wrong.
  assert.match(src, /status:\s*404/);
  assert.match(src, /type:\s*"not_found"/);
});
