import { NextResponse } from "next/server";
import { redeliverDelivery } from "../../../../../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; deliveryId: string }>;
}

export async function POST(_req: Request, ctx: Ctx) {
  const { id, deliveryId } = await ctx.params;
  try {
    const delivery = await redeliverDelivery(id, deliveryId);
    if (!delivery) {
      return NextResponse.json(
        { error: "Webhook or delivery not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ delivery });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Redelivery failed." },
      { status: 500 },
    );
  }
}
