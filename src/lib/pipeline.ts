import * as cheerio from "cheerio";
import { z } from "zod";
import type { GrantScoutReport, Opportunity, OpportunityType } from "@/src/lib/types";

function ddgUnwrap(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "duckduckgo.com" && u.pathname.startsWith("/l/") && u.searchParams.get("uddg")) {
      return decodeURIComponent(u.searchParams.get("uddg")!);
    }
  } catch {}
  return url;
}

async function ddgSearch(query: string, limit = 8): Promise<string[]> {
  const endpoint = "https://duckduckgo.com/html/";
  const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; GrantScoutAI/1.0)",
    },
    // Vercel runtime caches aggressively; keep it fresh for search.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("a.result__a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = href.startsWith("//") ? `https:${href}` : href;
    if (normalized.startsWith("http")) out.push(normalized);
  });
  return Array.from(new Set(out)).slice(0, limit);
}

async function fetchHtml(url: string): Promise<{ url: string; html: string }> {
  const official = ddgUnwrap(url);
  const res = await fetch(official, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; GrantScoutAI/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${official}`);
  return { url: official, html: await res.text() };
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const text = $.text();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function extractDeadline(text: string): string | null {
  const patterns = [
    /\bdeadline\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})/i,
    /\bapply by\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})/i,
    /\bapplications? (open|close|due)\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[2] || m?.[1]) return (m[2] ?? m[1]) as string;
  }
  return null;
}

function guessType(name: string, text: string): OpportunityType {
  const blob = `${name}\n${text}`.toLowerCase();
  if (blob.includes("startup credit") || blob.includes("credits")) return "startup_credits";
  if (blob.includes("scholarship")) return "scholarship";
  if (blob.includes("fellowship")) return "fellowship";
  if (blob.includes("grant") || blob.includes("funding")) return "grant";
  return "other";
}

function scoreEligibility(profile: { status?: string; free_only: boolean; interests: string[] }, text: string) {
  const t = text.toLowerCase();
  let score = 0.35;
  const reasons: string[] = [];
  if (profile.free_only) {
    if (t.includes("application fee") || t.includes("non-refundable")) {
      score -= 0.15;
      reasons.push("Mentions fees; you asked for free-only.");
    } else {
      score += 0.05;
      reasons.push("No obvious fee language found.");
    }
  }
  const s = (profile.status ?? "").toLowerCase();
  if (s.includes("international")) {
    if (t.includes("international") || t.includes("non-u.s.") || t.includes("non us")) {
      score += 0.2;
      reasons.push("Explicitly mentions international eligibility.");
    } else if (t.includes("u.s. citizen") || t.includes("permanent resident")) {
      score -= 0.2;
      reasons.push("Appears restricted to US citizens/PR.");
    }
  }
  if (s.includes("student")) {
    if (t.includes("student") || t.includes("graduate") || t.includes("master")) {
      score += 0.1;
      reasons.push("Mentions student/graduate eligibility.");
    }
  }
  for (const kw of profile.interests.slice(0, 8)) {
    if (kw && t.includes(kw.toLowerCase())) score += 0.03;
  }
  score = Math.max(0, Math.min(1, score));
  return { score, reason: reasons.join(" ") };
}

const MistralExtractionSchema = z.object({
  is_opportunity: z.boolean().default(true),
  name: z.string().optional(),
  type: z.enum(["grant", "fellowship", "scholarship", "startup_credits", "other"]).optional(),
  deadline: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  requirements: z.array(z.string()).optional(),
  application_link: z.string().nullable().optional(),
  eligibility_score: z.number().min(0).max(1).optional(),
  eligibility_reason: z.string().optional(),
  evidence: z.array(z.object({ url: z.string(), quote: z.string() })).optional(),
});

async function mistralExtract(args: {
  apiKey: string;
  profile: { narrative: string; interests: string[]; location?: string | null; status?: string | null; free_only: boolean };
  url: string;
  text: string;
}): Promise<z.infer<typeof MistralExtractionSchema>> {
  const { Mistral } = await import("@mistralai/mistralai");
  const client = new Mistral({ apiKey: args.apiKey });
  const system =
    "You are an extraction engine. Return STRICT JSON only. " +
    "Extract grant/fellowship/scholarship/startup credits info from the provided page text. " +
    "If the page is NOT an opportunity page, return {\"is_opportunity\": false}.";
  const user =
    `USER PROFILE:\n${JSON.stringify(args.profile)}\n\n` +
    `PAGE URL:\n${args.url}\n\n` +
    `PAGE TEXT (truncated):\n${args.text.slice(0, 12000)}\n\n` +
    "Return JSON with fields:\n" +
    "{\n" +
    '  "is_opportunity": boolean,\n' +
    '  "name": string,\n' +
    '  "type": "grant"|"fellowship"|"scholarship"|"startup_credits"|"other",\n' +
    '  "deadline": string|null,\n' +
    '  "amount": string|null,\n' +
    '  "location": string|null,\n' +
    '  "requirements": string[],\n' +
    '  "application_link": string|null,\n' +
    '  "eligibility_score": number (0..1),\n' +
    '  "eligibility_reason": string,\n' +
    '  "evidence": [{"url": string, "quote": string}] (1-3 short quotes)\n' +
    "}\n";

  const resp = await client.chat.complete({
    model: "mistral-small-latest",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    responseFormat: { type: "json_object" },
  });
  const content = resp.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty mistral response");
  const json = typeof content === "string" ? JSON.parse(content) : content;
  return MistralExtractionSchema.parse(json);
}

function rank(opps: Opportunity[]): Opportunity[] {
  const sorted = [...opps].sort((a, b) => {
    const aBonus = a.deadline ? 0.05 : 0;
    const bBonus = b.deadline ? 0.05 : 0;
    return (b.eligibility_score + bBonus) - (a.eligibility_score + aBonus);
  });
  return sorted.map((o, i) => ({ ...o, rank: i + 1 }));
}

function buildQueries(profile: { interests: string[]; status?: string | null }, roundIdx: number): string[] {
  const base = profile.interests.length ? profile.interests.slice(0, 5).join(", ") : "AI data science";
  const persona = (profile.status || "international student").trim();
  const qualifiers = "free grant fellowship scholarship startup credits";
  const strategies = [
    `${base} ${qualifiers} ${persona} official site`,
    `${base} fellowship ${persona} deadline apply`,
    `${base} scholarship ${persona} eligibility`,
    `${base} startup credits ${persona} apply`,
    `${base} grant nonprofit research funding apply`,
  ];
  return [strategies[Math.min(roundIdx, strategies.length - 1)]];
}

export async function runGrantScout(args: {
  profile: {
    narrative: string;
    interests: string[];
    location?: string | null;
    status?: string | null;
    free_only: boolean;
  };
  minResults: number;
  maxSearchRounds: number;
  mistralApiKey?: string | null;
}): Promise<GrantScoutReport> {
  const notes: string[] = [];
  let opportunities: Opportunity[] = [];

  for (let round = 0; round < args.maxSearchRounds; round++) {
    const queries = buildQueries(args.profile, round);
    notes.push(`Round ${round}: queries=${JSON.stringify(queries)}`);

    const urls = (await Promise.all(queries.map((q) => ddgSearch(q, 8)))).flat();
    const uniqueUrls = Array.from(new Set(urls));

    for (const url of uniqueUrls) {
      try {
        const { url: officialUrl, html } = await fetchHtml(url);
        const text = htmlToText(html);

        // cheap filter before doing any heavy work
        const lc = text.toLowerCase();
        if (!["apply", "application", "deadline", "eligib", "scholarship", "fellowship", "grant", "credits"].some((k) => lc.includes(k))) {
          continue;
        }

        const title = (() => {
          const $ = cheerio.load(html);
          return ($("title").text() || officialUrl).trim().slice(0, 200);
        })();

        const deadline = extractDeadline(text);
        const type = guessType(title, text);
        const heur = scoreEligibility({ status: args.profile.status ?? undefined, free_only: args.profile.free_only, interests: args.profile.interests }, text);

        let opp: Opportunity = {
          name: title,
          type,
          official_link: officialUrl,
          application_link: null,
          deadline,
          amount: null,
          location: null,
          requirements: [],
          eligibility_score: heur.score,
          eligibility_reason: heur.reason,
          evidence: [{ url: officialUrl, quote: text.slice(0, 320) + (text.length > 320 ? "…" : "") }],
        };

        if (args.mistralApiKey) {
          try {
            const extracted = await mistralExtract({
              apiKey: args.mistralApiKey,
              profile: args.profile,
              url: officialUrl,
              text,
            });
            if (extracted.is_opportunity === false) continue;
            opp = {
              ...opp,
              name: (extracted.name || opp.name).slice(0, 200),
              type: (extracted.type || opp.type) as OpportunityType,
              deadline: extracted.deadline ?? opp.deadline,
              amount: extracted.amount ?? opp.amount,
              location: extracted.location ?? opp.location,
              requirements: extracted.requirements ?? opp.requirements,
              application_link: extracted.application_link ?? opp.application_link,
              eligibility_score: extracted.eligibility_score ?? opp.eligibility_score,
              eligibility_reason: extracted.eligibility_reason ?? opp.eligibility_reason,
              evidence: extracted.evidence ?? opp.evidence,
            };
          } catch (e) {
            notes.push(`mistral extract failed for ${officialUrl}: ${String(e)}`);
          }
        }

        opportunities.push(opp);
      } catch (e) {
        notes.push(`fetch/extract failed for ${url}: ${String(e)}`);
      }
    }

    // dedupe by official link + name
    const seen = new Set<string>();
    opportunities = opportunities.filter((o) => {
      const k = `${o.name.toLowerCase().trim()}|${o.official_link}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const haveValid = opportunities.filter((o) => o.deadline && o.official_link).length;
    if (haveValid >= args.minResults) break;
  }

  opportunities = rank(opportunities);

  const checklist = [
    "Create a 1-page resume/CV (PDF).",
    "Write a 150-word bio.",
    "Prepare transcripts (if student-focused).",
    "Draft 3 short project bullets relevant to AI/data science.",
    "Collect 1–2 references (if required).",
    ...(args.profile.free_only ? ["Confirm the program is free to apply (no application fee)."] : []),
    ...(opportunities.some((o) => o.type === "startup_credits")
      ? ["Prepare a 1-paragraph startup/product description (for credits)."]
      : []),
  ];

  const drafts: Record<string, string> = {
    "Personal statement bullets":
      "- Your background and why this opportunity fits\n" +
      "- One AI/data science project with measurable impact\n" +
      "- Your near-term goal (research, nonprofit impact, or startup)\n" +
      "- Why you specifically are eligible (status, location, program fit)\n",
    "Why me (50–80 words)":
      "I bring a strong data science foundation and hands-on experience building AI-driven solutions. " +
      "I’m looking for a free, mission-aligned program that supports research and real-world impact, " +
      "and I’m ready to contribute through clear execution, rigorous experimentation, and collaboration.",
  };

  return { opportunities, checklist, drafts, notes };
}

