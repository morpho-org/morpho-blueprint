import { z } from "zod";

export const dynamic = "force-dynamic";

const MARKETS_URL = "https://api.morpho.org/v1/blue/markets?chain_id=1&limit=1";
const marketsSchema = z.object({
  data: z.array(z.object({ chain_id: z.literal(1), market_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })).min(1),
});

export async function GET() {
  let ok = false;
  let upstreamStatus: number | null = null;
  let requestId: string | null = null;

  try {
    const response = await fetch(MARKETS_URL, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    upstreamStatus = response.status;
    requestId = response.headers.get("x-request-id");
    ok = response.ok && marketsSchema.safeParse(await response.json()).success;
  } catch {}

  return Response.json(
    {
      ok,
      checkedAt: new Date().toISOString(),
      environment: process.env.VERCEL_ENV ?? "development",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      upstreamStatus,
      requestId,
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
