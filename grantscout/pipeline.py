from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import requests
from bs4 import BeautifulSoup
from dateutil.parser import parse as date_parse
from .schemas import Opportunity, OpportunityType, UserProfile
from .llm import has_mistral, mistral_json


@dataclass
class PipelineState:
    profile: UserProfile
    queries: list[str]
    urls: list[str]
    raw_pages: dict[str, str]
    opportunities: list[Opportunity]
    notes: list[str]
    round: int
    max_rounds: int
    min_results: int


def _build_queries(profile: UserProfile, round_idx: int) -> list[str]:
    base = ", ".join(profile.interests[:5]) if profile.interests else "AI data science"
    persona = (profile.status or "international student").strip()
    qualifiers = "free grant fellowship scholarship startup credits"

    # Simple search-strategy shifts by round.
    strategies = [
        f"{base} {qualifiers} {persona} official site",
        f"{base} fellowship {persona} deadline apply",
        f"{base} scholarship {persona} eligibility",
        f"{base} startup credits {persona} apply",
        f"{base} grant nonprofit research funding apply",
    ]
    if round_idx < len(strategies):
        return [strategies[round_idx]]
    return [f"{base} {qualifiers} eligibility deadline"]


def _web_search_duckduckgo(query: str, limit: int = 8) -> list[str]:
    """
    Keyless search using DuckDuckGo's HTML endpoint.
    Not guaranteed/stable, but works well enough for demos.
    """
    url = "https://duckduckgo.com/html/"
    headers = {"User-Agent": "Mozilla/5.0 (compatible; GrantScoutAI/1.0)"}
    r = requests.get(url, params={"q": query}, headers=headers, timeout=25)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")

    out: list[str] = []
    for a in soup.select("a.result__a"):
        href = a.get("href")
        if not href:
            continue
        if href.startswith("//"):
            href = "https:" + href
        if href.startswith("http"):
            out.append(href)
        if len(out) >= limit:
            break
    return out


def _fetch_text(url: str, timeout_s: int = 25) -> str:
    headers = {"User-Agent": "GrantScoutAI/1.0 (+https://example.local)"}
    # DuckDuckGo result links are redirect wrappers; unwrap to the real URL for better extraction.
    if url.startswith("https://duckduckgo.com/l/") and "uddg=" in url:
        try:
            from urllib.parse import parse_qs, urlparse, unquote

            qs = parse_qs(urlparse(url).query)
            if "uddg" in qs and qs["uddg"]:
                url = unquote(qs["uddg"][0])
        except Exception:
            pass
    r = requests.get(url, headers=headers, timeout=timeout_s)
    r.raise_for_status()
    ct = (r.headers.get("content-type") or "").lower()
    if "text/html" in ct or ct == "" or "charset" in ct:
        return r.text
    return r.text


def _html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_DEADLINE_PATTERNS = [
    r"\bdeadline\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})",
    r"\bapply by\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})",
    r"\bapplications? (open|close|due)\b.{0,80}\b([A-Z][a-z]+ \d{1,2}, \d{4})",
]


def _extract_deadline(text: str) -> str | None:
    for pat in _DEADLINE_PATTERNS:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if not m:
            continue
        date_str = m.group(m.lastindex or 1)
        try:
            dt = date_parse(date_str, fuzzy=True)
            return dt.date().isoformat()
        except Exception:
            return date_str
    return None


def _guess_type(name: str, text: str) -> OpportunityType:
    blob = f"{name}\n{text}".lower()
    if "startup credit" in blob or "credits" in blob:
        return "startup_credits"
    if "scholarship" in blob:
        return "scholarship"
    if "fellowship" in blob:
        return "fellowship"
    if "grant" in blob or "funding" in blob:
        return "grant"
    return "other"


def _eligibility_score(profile: UserProfile, text: str) -> tuple[float, str]:
    t = text.lower()
    score = 0.35
    reasons: list[str] = []

    if profile.free_only:
        if "fee" in t and ("application fee" in t or "non-refundable" in t):
            score -= 0.15
            reasons.append("Mentions fees; you asked for free-only.")
        else:
            score += 0.05
            reasons.append("No obvious fee language found.")

    if profile.status:
        s = profile.status.lower()
        if "international" in s:
            if "international" in t or "non-u.s." in t or "non us" in t:
                score += 0.20
                reasons.append("Explicitly mentions international eligibility.")
            elif "u.s. citizen" in t or "permanent resident" in t:
                score -= 0.20
                reasons.append("Appears restricted to US citizens/PR.")
        if "student" in s:
            if "student" in t or "graduate" in t or "master" in t:
                score += 0.10
                reasons.append("Mentions student/graduate eligibility.")

    for kw in (profile.interests or [])[:8]:
        if kw and kw.lower() in t:
            score += 0.03

    score = max(0.0, min(1.0, score))
    return score, " ".join(reasons).strip()


def _extract_opportunity_from_page(url: str, html: str, profile: UserProfile) -> Opportunity | None:
    text = _html_to_text(html)
    title = None
    soup = BeautifulSoup(html, "lxml")
    if soup.title and soup.title.text:
        title = soup.title.text.strip()
    name = title or url

    # Keep the canonical official URL (unwrapped if needed)
    official_url = url
    if url.startswith("https://duckduckgo.com/l/") and "uddg=" in url:
        try:
            from urllib.parse import parse_qs, urlparse, unquote

            qs = parse_qs(urlparse(url).query)
            if "uddg" in qs and qs["uddg"]:
                official_url = unquote(qs["uddg"][0])
        except Exception:
            official_url = url

    deadline = _extract_deadline(text)
    opp_type = _guess_type(name, text)
    score, reason = _eligibility_score(profile, text)

    # If Mistral is configured, ask it to extract structured fields + evidence.
    # Fallback to heuristics if not.
    if has_mistral():
        system = (
            "You are an extraction engine. Return STRICT JSON only. "
            "Extract grant/fellowship/scholarship/startup credits info from the provided page text. "
            "If the page is NOT an opportunity page, return {\"is_opportunity\": false}."
        )
        user = (
            f"USER PROFILE:\n{profile.model_dump_json()}\n\n"
            f"PAGE URL:\n{url}\n\n"
            "PAGE TEXT (truncated):\n"
            f"{text[:12000]}\n\n"
            "Return JSON with fields:\n"
            "{\n"
            "  \"is_opportunity\": boolean,\n"
            "  \"name\": string,\n"
            "  \"type\": \"grant\"|\"fellowship\"|\"scholarship\"|\"startup_credits\"|\"other\",\n"
            "  \"deadline\": string|null,\n"
            "  \"amount\": string|null,\n"
            "  \"location\": string|null,\n"
            "  \"requirements\": string[],\n"
            "  \"application_link\": string|null,\n"
            "  \"eligibility_score\": number (0..1),\n"
            "  \"eligibility_reason\": string,\n"
            "  \"evidence\": [{\"url\": string, \"quote\": string}] (1-3 short quotes)\n"
            "}\n"
        )
        try:
            data = mistral_json(system, user)
            if not data or not data.get("is_opportunity", True):
                return None
            return Opportunity(
                name=(data.get("name") or name)[:200],
                type=data.get("type") or opp_type,
                official_link=official_url,
                application_link=data.get("application_link"),
                deadline=data.get("deadline") or deadline,
                amount=data.get("amount"),
                location=data.get("location"),
                requirements=list(data.get("requirements") or []),
                eligibility_score=float(data.get("eligibility_score") or score),
                eligibility_reason=str(data.get("eligibility_reason") or reason),
                evidence=list(data.get("evidence") or [{"url": url, "quote": (text[:400] + "…") if len(text) > 400 else text}]),
            )
        except Exception:
            # Fall back to heuristics below
            pass

    if not any(
        k in text.lower()
        for k in ["apply", "application", "deadline", "eligib", "scholarship", "fellowship", "grant", "credits"]
    ):
        return None

    opp = Opportunity(
        name=name[:200],
        type=opp_type,
        official_link=official_url,
        application_link=None,
        deadline=deadline,
        amount=None,
        location=None,
        requirements=[],
        eligibility_score=score,
        eligibility_reason=reason,
        evidence=[{"url": url, "quote": (text[:400] + "…") if len(text) > 400 else text}],
    )
    return opp


def _dedupe(opps: list[Opportunity]) -> list[Opportunity]:
    seen = set()
    out: list[Opportunity] = []
    for o in opps:
        key = (o.name.lower().strip(), str(o.official_link))
        if key in seen:
            continue
        seen.add(key)
        out.append(o)
    return out


def _rank(opps: list[Opportunity]) -> list[Opportunity]:
    def key(o: Opportunity) -> tuple[float, int]:
        deadline_bonus = 0
        if o.deadline:
            deadline_bonus = 1
        return (o.eligibility_score + 0.05 * deadline_bonus, 0)

    ranked = sorted(opps, key=key, reverse=True)
    for i, o in enumerate(ranked, start=1):
        o.rank = i
    return ranked


def _make_checklist(profile: UserProfile, opps: list[Opportunity]) -> list[str]:
    base = [
        "Create a 1-page resume/CV (PDF).",
        "Write a 150-word bio.",
        "Prepare transcripts (if student-focused).",
        "Draft 3 short project bullets relevant to AI/data science.",
        "Collect 1–2 references (if required).",
    ]
    if profile.free_only:
        base.append("Confirm the program is free to apply (no application fee).")
    if any(o.type == "startup_credits" for o in opps):
        base.append("Prepare a 1-paragraph startup/product description (for credits).")
    return base


def _drafts(profile: UserProfile) -> dict[str, str]:
    return {
        "Personal statement bullets": (
            "- Your background and why this opportunity fits\n"
            "- One AI/data science project with measurable impact\n"
            "- Your near-term goal (research, nonprofit impact, or startup)\n"
            "- Why you specifically are eligible (status, location, program fit)\n"
        ),
        "Why me (50–80 words)": (
            "I bring a strong data science foundation and hands-on experience building AI-driven solutions. "
            "I’m looking for a free, mission-aligned program that supports research and real-world impact, "
            "and I’m ready to contribute through clear execution, rigorous experimentation, and collaboration."
        ),
    }


def _node_plan(state: PipelineState) -> PipelineState:
    state.queries = _build_queries(state.profile, state.round)
    state.notes.append(f"Round {state.round}: queries={state.queries}")
    return state


def _node_search(state: PipelineState) -> PipelineState:
    urls: list[str] = []
    for q in state.queries:
        try:
            urls.extend(_web_search_duckduckgo(q))
        except Exception as e:
            # Keep the pipeline runnable even without a provider wired in.
            state.notes.append(f"search failed for query={q!r}: {e}")
    state.urls = list(dict.fromkeys(urls))
    return state


def _node_fetch_and_extract(state: PipelineState) -> PipelineState:
    for url in state.urls:
        if url in state.raw_pages:
            continue
        try:
            html = _fetch_text(url)
            state.raw_pages[url] = html
            opp = _extract_opportunity_from_page(url, html, state.profile)
            if opp:
                state.opportunities.append(opp)
        except Exception as e:
            state.notes.append(f"fetch/extract failed for {url}: {e}")
    state.opportunities = _dedupe(state.opportunities)
    return state


def _node_validate_and_rank(state: PipelineState) -> PipelineState:
    state.opportunities = _rank(state.opportunities)
    return state


def _should_continue(state: PipelineState) -> str:
    have = len([o for o in state.opportunities if o.deadline and o.official_link])
    if have >= state.min_results:
        return "done"
    if state.round + 1 >= state.max_rounds:
        return "done"
    return "continue"


def run_grantscout(profile: UserProfile, min_results: int = 10, max_search_rounds: int = 5) -> dict[str, Any]:
    """
    Returns a JSON-serializable report.

    Note: uses a keyless DuckDuckGo HTML search for demo purposes.
    For production, swap in a real search provider.
    """
    state = PipelineState(
        profile=profile,
        queries=[],
        urls=[],
        raw_pages={},
        opportunities=[],
        notes=[],
        round=0,
        max_rounds=max_search_rounds,
        min_results=min_results,
    )

    # Manual agentic loop (keeps the app runnable without strict LangGraph state typing).
    while True:
        state = _node_plan(state)
        state = _node_search(state)
        state = _node_fetch_and_extract(state)
        state = _node_validate_and_rank(state)
        if _should_continue(state) == "done":
            break
        state.round += 1

    opps = [o.model_dump() for o in state.opportunities]
    return {
        "opportunities": opps,
        "checklist": _make_checklist(profile, state.opportunities),
        "drafts": _drafts(profile),
        "notes": state.notes,
    }

