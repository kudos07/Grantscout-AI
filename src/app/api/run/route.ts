import { z } from "zod";
import { runGrantScout } from "@/src/lib/pipeline";

export const runtime = "nodejs";

const Req = z.object({
  narrative: z.string().min(1),
  interests: z.array(z.string()).default([]),
  location: z.string().nullish(),
  status: z.string().nullish(),
  free_only: z.boolean().default(true),
  min_results: z.number().int().min(5).max(30).default(10),
  max_search_rounds: z.number().int().min(1).max(10).default(4),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const apiKey = process.env.MISTRAL_API_KEY ?? null;
  if (!apiKey) {
    return Response.json(
      { error: "missing_env", message: "Set MISTRAL_API_KEY on the server." },
      { status: 500 }
    );
  }

  const report = await runGrantScout({
    profile: {
      narrative: parsed.data.narrative,
      interests: parsed.data.interests,
      location: parsed.data.location ?? null,
      status: parsed.data.status ?? null,
      free_only: parsed.data.free_only,
    },
    minResults: parsed.data.min_results,
    maxSearchRounds: parsed.data.max_search_rounds,
    mistralApiKey: apiKey,
  });

  return Response.json(report);
}

