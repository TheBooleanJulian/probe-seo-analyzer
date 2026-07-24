# Probe — SEO & GEO Site Health Analyzer

Point it at a URL, get a live-read audit: overall score, category breakdown
(Technical / Content / Authority / UX / **GEO**), meta & heading checks,
**GEO (Generative Engine Optimization)** checks for AI-answer-engine readiness,
flagged issues, prioritized actionables with estimated score impact, and an
exportable PDF report.

## How it works

- **Frontend** (`static/index.html`) — single-file HTML/CSS/JS, dark-premium UI.
  Posts the target URL to `/api/analyze` and renders the scorecard.
- **Backend** (`main.py`) — FastAPI. Holds the Anthropic API key server-side,
  calls Claude with the `web_search` tool to fetch and read the live page, and
  parses the structured JSON audit back to the frontend.
- **PDF export** — client-side via `window.print()` with a print stylesheet;
  no extra dependencies.

## SEO vs. GEO

- **SEO checks** (Technical / Content / Authority / UX) — the classic search-engine
  factors: title/meta tags, heading structure, HTTPS, canonical tags, backlink
  signals, page structure.
- **GEO checks** (new) — how well the page is set up to be read, cited, and quoted
  by AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude):
  whether AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended,
  OAI-SearchBot) are allowed in `robots.txt`, whether an `llms.txt` file exists,
  schema.org structured data coverage, whether key facts are stated clearly and
  quotably near the top of the page, and author/entity clarity.

## Estimated vs. verified data — important

Every number this app produces from the AI read (scores, backlink tier, domain
age, social presence, AI bot access, etc.) is a **best-effort AI estimate**,
not a measured figure from a crawled index. The UI always shows an
`AI Estimate` badge on these figures so it's never presented as fact.

There's a hook for real numbers: set `AHREFS_API_KEY` on the server (once
there's a paid Ahrefs plan behind it) and the backend will call Ahrefs' v3
Domain Rating endpoint (`GET /v3/site-explorer/domain-rating`) and swap the
badge to `Verified · Ahrefs`, showing real Domain Rating and Ahrefs Rank
alongside the still-AI-estimated fields (backlink tier, social presence,
content depth remain estimates — Ahrefs' full backlink/referring-domain data
needs additional Enterprise-tier endpoints not wired up here yet).

This is currently an all-or-nothing server-side flag, not a per-user paywall.
To turn it into an actual paid tier (e.g. "Pro" users get verified data, free
users get estimates), the natural next step is adding a billing provider
(Stripe is the common choice) and gating the `fetch_ahrefs_domain_rating` call
in `main.py` behind the requesting user's plan instead of a single global key.

## Local setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY

export $(cat .env | xargs)
uvicorn main:app --reload
```

Visit `http://localhost:8000`.

## Environment variables

| Variable            | Required | Default              | Notes                                  |
|---------------------|----------|-----------------------|-----------------------------------------|
| `ANTHROPIC_API_KEY`  | Yes      | —                     | Server-side only, never exposed to the client |
| `ANTHROPIC_MODEL`    | No       | `claude-sonnet-4-6`   | Override to test other models          |
| `PORT`               | No       | `8000`                | Set automatically by Zeabur            |

## Deploying on Zeabur

1. Push this repo to GitHub (see branching note below).
2. In Zeabur, create a new service from the GitHub repo — it will build from
   the included `Dockerfile` automatically (Procfile is included as a
   Nixpacks fallback if Docker build is skipped).
3. Add `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) as environment
   variables on the service.
4. Deploy. Zeabur assigns `PORT` automatically — the app already reads it.

## Branching workflow

Follows the standard `feature → dev → main` pattern:

- Build in `feature/*` branches.
- Merge into `dev` for integration testing against a Zeabur preview
  environment.
- Merge `dev` → `main` to deploy to production once verified.

## Notes on scope

Scores are AI-estimated from a live page read plus public web search signals —
this is not backed by a crawled backlink index (Ahrefs/Moz-grade authority
data isn't available without their paid APIs). Treat category/authority
numbers as directional, not exact.

## License

MIT — see `LICENSE`.
