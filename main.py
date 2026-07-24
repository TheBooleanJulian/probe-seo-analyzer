"""
Probe — SEO & Site Health Analyzer
FastAPI backend: proxies audit requests to the Anthropic API (server-side key)
and serves the single-file HTML frontend from /static.
"""

import json
import os

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
ANTHROPIC_VERSION = "2023-06-01"

# Optional: only set on the server once there's a paid Ahrefs plan behind it.
# When present, authority numbers are swapped for real Ahrefs data instead of
# the AI's estimate. This is the hook for a future paid tier — see README.
AHREFS_API_KEY = os.environ.get("AHREFS_API_KEY", "")
AHREFS_API_BASE = "https://api.ahrefs.com/v3"

app = FastAPI(title="Probe — SEO Analyzer", version="1.2.0")

SYSTEM_PROMPT = """You are a combined SEO + GEO (Generative Engine Optimization) audit engine. Fetch and read the
given URL using web search/fetch, then output ONLY a single valid JSON object (no markdown fences, no prose before
or after) matching exactly this schema:
{
 "overallScore": number 0-100,
 "categories": {
   "technical": number 0-100,
   "content": number 0-100,
   "authority": number 0-100,
   "ux": number 0-100,
   "geo": number 0-100
 },
 "meta": {
   "title": string,
   "titleLength": number,
   "description": string,
   "descriptionLength": number,
   "headings": [string]
 },
 "technicalChecks": [
   {"label": string, "status": "pass"|"warn"|"fail", "detail": string}
 ],
 "geoChecks": [
   {"label": string, "status": "pass"|"warn"|"fail", "detail": string}
 ],
 "issues": [
   {"severity": "critical"|"warning"|"info", "title": string, "detail": string}
 ],
 "actionables": [
   {"title": string, "detail": string, "category": "technical"|"content"|"authority"|"ux"|"geo", "impact": number, "effort": "Low"|"Medium"|"High"}
 ],
 "estimatedStats": {
   "domainAge": string,
   "backlinkTier": string,
   "socialPresence": string,
   "contentDepth": string
 },
 "geoStats": {
   "aiBotAccess": string,
   "structuredData": string,
   "llmsTxt": string,
   "answerReadiness": string
 },
 "keywords": [string]
}

"categories.geo" and "geoChecks" cover Generative Engine Optimization — how well the page is set up to be read,
cited, and quoted by AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude). Evaluate specifically:
whether known AI crawlers are allowed in robots.txt (GPTBot, ClaudeBot/anthropic-ai, PerplexityBot, Google-Extended,
OAI-SearchBot), whether an llms.txt file exists, presence and correctness of schema.org structured data (Article,
FAQPage, HowTo, Organization), whether the page states clear, quotable, self-contained facts/definitions near the
top rather than burying them, clarity of author/entity/organization identity (E-E-A-T signals AI engines use to
judge trustworthiness), and visible freshness/last-updated signals. Produce 4-6 geoChecks entries in the same
{label, status, detail} shape as technicalChecks.

Rules for "actionables" (5-8 items, spanning both SEO and GEO categories): each is a concrete, specific, prioritized
fix the site owner can actually do. "impact" is your best-effort estimate of how many overall score points fixing
it could add (1-15), used to sort by priority — higher impact first. "effort" reflects how much work the fix
realistically takes.

Every number and label you produce (scores, domain age, backlink tier, social presence, AI bot access, etc.) is a
best-effort estimate from what you can observe on the live page and public web results — you do NOT have access to
a crawled backlink index or verified analytics. Never state estimated figures as if they were measured facts; where
you can't verify something, say so briefly in the relevant detail field. Do not wrap the JSON in markdown code
fences."""


class AnalyzeRequest(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def normalize_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL is required")
        if not v.startswith(("http://", "https://")):
            v = "https://" + v
        return v


async def fetch_ahrefs_domain_rating(target: str) -> dict | None:
    """Best-effort call to Ahrefs' v3 Domain Rating endpoint.

    Only runs when AHREFS_API_KEY is configured on the server (i.e. once
    there's a paid Ahrefs plan behind this deployment). Returns None on any
    failure so the caller can fall back to the AI estimate — this must never
    break the main audit. Endpoint: GET /v3/site-explorer/domain-rating.
    Docs: https://docs.ahrefs.com/en/api/reference/site-explorer/get-domain-rating
    """
    if not AHREFS_API_KEY:
        return None
    domain = target.replace("https://", "").replace("http://", "").split("/")[0]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{AHREFS_API_BASE}/site-explorer/domain-rating",
                params={"target": domain},
                headers={
                    "Authorization": f"Bearer {AHREFS_API_KEY}",
                    "Accept": "application/json",
                },
            )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return {
            "domainRating": data.get("domain_rating"),
            "ahrefsRank": data.get("ahrefs_rank"),
        }
    except (httpx.RequestError, ValueError):
        # Verified data is a bonus, not a requirement — silently fall back.
        return None


def extract_json(raw_text: str) -> dict:
    raw = raw_text.strip()
    raw = raw.strip("`")
    if raw.lower().startswith("json"):
        raw = raw[4:].strip()
    first, last = raw.find("{"), raw.rfind("}")
    if first == -1 or last == -1:
        raise ValueError("No JSON object found in model response")
    return json.loads(raw[first : last + 1])


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not configured on the server")

    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 4096,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": f"Audit this URL: {req.url}"}],
        "tools": [
            {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
        ],
    }
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(ANTHROPIC_API_URL, headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise HTTPException(502, f"Could not reach Anthropic API: {exc}") from exc

    if resp.status_code != 200:
        raise HTTPException(
            502, f"Anthropic API error {resp.status_code}: {resp.text[:400]}"
        )

    data = resp.json()
    text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
    raw_text = "\n".join(text_blocks)

    try:
        parsed = extract_json(raw_text)
    except (ValueError, json.JSONDecodeError) as exc:
        stop_reason = data.get("stop_reason")
        if stop_reason == "max_tokens":
            raise HTTPException(
                502,
                "Model response was cut off before finishing the JSON (hit the output "
                "token limit). Try again — this is usually transient.",
            ) from exc
        snippet = ""
        if isinstance(exc, json.JSONDecodeError):
            start = max(0, exc.pos - 80)
            snippet = f" | near: ...{raw_text[start:exc.pos + 80]!r}..."
        raise HTTPException(
            502,
            f"Could not parse model output as JSON: {exc} "
            f"[stop_reason={stop_reason}, raw_len={len(raw_text)}]{snippet}",
        ) from exc

    ahrefs_data = await fetch_ahrefs_domain_rating(req.url)

    parsed["dataSource"] = {
        # "ahrefs" only when a real, verified lookup succeeded; otherwise every
        # authority/backlink figure in the response is an AI estimate.
        "authority": "ahrefs" if ahrefs_data else "ai_estimate",
        "onPage": "live_fetch",  # title/meta/headings/technical checks are read live, not estimated
    }
    if ahrefs_data:
        parsed["verifiedStats"] = ahrefs_data

    usage = data.get("usage", {})
    parsed["_meta"] = {"targetUrl": req.url, "model": ANTHROPIC_MODEL}
    print(
        f"[analyze] target={req.url} input_tokens={usage.get('input_tokens')} "
        f"output_tokens={usage.get('output_tokens')} "
        f"web_searches={usage.get('server_tool_use', {}).get('web_search_requests')}"
    )
    return parsed


@app.get("/api/health")
async def health():
    return {"status": "ok", "key_configured": bool(ANTHROPIC_API_KEY)}


# Serve the frontend last so /api/* routes above take priority.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
