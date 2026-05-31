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
import {
  dismissOnboarding,
  getOnboarding,
  markCompared,
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
  if (action === "dismiss") {
    await dismissOnboarding();
  } else if (action === "compared") {
    await markCompared();
  } else {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Unknown action. Expected 'dismiss' or 'compared'." } },
      { status: 400 },
    );
  }
  const state = await getOnboarding();
  return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
}
