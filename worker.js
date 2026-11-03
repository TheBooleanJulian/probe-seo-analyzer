// Probe — SEO & Site Health Analyzer on Cloudflare Workers (port of main.py, FastAPI).
// POST /api/analyze proxies the audit to the Anthropic API (server-side key, web_search tool); GET /api/health;
// everything else is static/ (the single-file frontend).
//
// Secrets: ANTHROPIC_API_KEY (required for /api/analyze), AHREFS_API_KEY (optional, paid tier).
// Var: ANTHROPIC_MODEL. The model call stays direct rather than via thebooleanjulian-llm because the audit relies on
// Anthropic's server-side web_search tool, which the gateway's OpenAI-compatible endpoint doesn't carry.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const AHREFS_API_BASE = 'https://api.ahrefs.com/v3';

const SYSTEM_PROMPT = `You are a combined SEO + GEO (Generative Engine Optimization) audit engine. Fetch and read the
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
fences.`;

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

export function normalizeUrl(v) {
  v = String(v ?? '').trim();
  if (!v) throw new HttpError(422, 'URL is required');
  if (!v.startsWith('http://') && !v.startsWith('https://')) v = 'https://' + v;
  return v;
}

export function extractJson(rawText) {
  let raw = rawText.trim().replace(/^`+|`+$/g, '');
  if (raw.toLowerCase().startsWith('json')) raw = raw.slice(4).trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(raw.slice(first, last + 1));
}

// Best-effort Ahrefs Domain Rating; null on any failure so the AI estimate is used. Only with AHREFS_API_KEY.
async function fetchAhrefsDomainRating(env, target) {
  if (!env.AHREFS_API_KEY) return null;
  const domain = target.replace('https://', '').replace('http://', '').split('/')[0];
  try {
    const res = await fetch(`${AHREFS_API_BASE}/site-explorer/domain-rating?target=${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${env.AHREFS_API_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    return { domainRating: data.domain_rating ?? null, ahrefsRank: data.ahrefs_rank ?? null };
  } catch {
    return null;
  }
}

async function analyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, 'ANTHROPIC_API_KEY is not configured on the server');
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError(422, 'Request body must be JSON with a "url" field');
  const url = normalizeUrl(body.url);
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  let resp;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Audit this URL: ${url}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach Anthropic API: ${err.message}`);
  }
  if (resp.status !== 200) {
    throw new HttpError(502, `Anthropic API error ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  }

  const data = await resp.json();
  const rawText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    if (data.stop_reason === 'max_tokens') {
      throw new HttpError(502, 'Model response was cut off before finishing the JSON (hit the output token limit). Try again — this is usually transient.');
    }
    throw new HttpError(502, `Could not parse model output as JSON: ${err.message} [stop_reason=${data.stop_reason}, raw_len=${rawText.length}]`);
  }

  const ahrefs = await fetchAhrefsDomainRating(env, url);
  // "ahrefs" only when a real, verified lookup succeeded; otherwise authority/backlink figures are AI estimates.
  parsed.dataSource = { authority: ahrefs ? 'ahrefs' : 'ai_estimate', onPage: 'live_fetch' };
  if (ahrefs) parsed.verifiedStats = ahrefs;

  const usage = data.usage || {};
  parsed._meta = { targetUrl: url, model };
  console.log(`[analyze] target=${url} input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} web_searches=${usage.server_tool_use?.web_search_requests}`);
  return parsed;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health' && request.method === 'GET') {
      return json({ status: 'ok', key_configured: Boolean(env.ANTHROPIC_API_KEY) });
    }
    if (pathname === '/api/analyze') {
      if (request.method !== 'POST') return json({ detail: 'Method Not Allowed' }, 405);
      try {
        return json(await analyze(request, env));
      } catch (err) {
        return json({ detail: err.message }, err instanceof HttpError ? err.status : 500);
      }
    }
    if (pathname.startsWith('/api/')) return json({ detail: 'Not Found' }, 404);
    return env.ASSETS.fetch(request);
  }
};
