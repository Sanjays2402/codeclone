/**
 * Onboarding state endpoint. GET returns derived step status; POST accepts a
 * small set of events from the UI:
 *   { action: "dismiss" }           hide the welcome banner forever
 *   { action: "compared" }          mark the compare step done (fired by /compare)
 *
 * No auth: codeclone is single-tenant. The persisted file is a sibling of
 * shares/ and api-keys/ so it lives or dies with the rest of the runtime data.
 */
import { NextResponse } from "next/server";
import { tryRecordAudit } from "../../../lib/audit";
import {
  clearSamples,
  dismissOnboarding,
  getOnboarding,
  markCompared,
  seedSamples,
} from "../../../lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getOnboarding();
    return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: { type: "internal", message: err instanceof Error ? err.message : String(err) } },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  let body: { action?: unknown } = {};
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Body must be JSON." } },
      { status: 400 },
    );
  }
  const action = typeof body.action === "string" ? body.action : "";
  let extra: Record<string, unknown> = {};
  try {
    if (action === "dismiss") {
      await dismissOnboarding();
    } else if (action === "compared") {
      await markCompared();
    } else if (action === "seed-samples") {
      const r = await seedSamples();
      extra = { seeded: r };
    } else if (action === "clear-samples") {
      const r = await clearSamples();
      extra = { cleared: r };
    } else {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message:
              "Unknown action. Expected 'dismiss', 'compared', 'seed-samples', or 'clear-samples'.",
          },
        },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 500 },
    );
  }
  const state = await getOnboarding();
  await tryRecordAudit(req, {
    action: `onboarding.${action.replace(/-/g, "_")}`,
    target: { type: "onboarding" },
    meta: extra,
  });
  return NextResponse.json({ ...state, ...extra }, { headers: { "cache-control": "no-store" } });
}
