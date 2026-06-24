# Buffalo Open Coffee Club (BOCC)

Monorepo for the Buffalo Open Coffee Club — a weekly Tuesday morning networking event for Buffalo's small business and entrepreneurial community.

**Website:** [716coffee.club](https://716coffee.club)
**Community:** [716.social](https://www.716.social)
**Events:** [Eventbrite](https://www.eventbrite.com/e/buffalo-open-coffee-club-tickets-1983098086761)

## Repository Structure

```
bocc/
├── website/        Jekyll static site → served at 716coffee.club via Netlify
├── backend/        Netlify Functions API → served at 716coffee.club/.netlify/functions/
└── docs/           All project documentation
    ├── onboarding.md       Start here if you're new
    ├── architecture.md     System overview and data flows
    ├── backend/            Backend technical docs, epics, stories
    ├── website/            Website docs and future work
    └── strategy/           Social media and brand guides
```

## Quick Start

### Website (Jekyll)

```bash
cd website
bundle install

# Local dev (plain)
bundle exec jekyll serve

# Local dev with SSL (required for Eventbrite embed checkout)
bundle exec jekyll serve --host localhost --ssl-key ssl/localhost.key --ssl-cert ssl/localhost.crt
```

Generate local SSL certs (one-time):
```bash
mkdir -p website/ssl
openssl req -x509 -out website/ssl/localhost.crt -keyout website/ssl/localhost.key \
  -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
  -extensions EXT -config <(printf "[dn]\nCN=localhost\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth") -days 365
```

### Backend (Netlify Functions)

```bash
cd backend
npm install

# Run tests (~299 tests)
npm test

# Local dev (requires Netlify CLI and environment variables)
netlify dev
```

Required environment variables (set in Netlify dashboard, never committed):
- `AIRTABLE_API_KEY` — Airtable API authentication
- `AIRTABLE_BASE_ID` — BOCC Airtable database ID
- `CIRCLE_API_TOKEN` — Circle.so Admin API v2 token
- `CIRCLE_HEADLESS_API` — Circle.so Headless Auth API token (for bot DMs)
- `ALLOWED_ORIGIN` — CORS origin (set to `https://716coffee.club` in production)

See `backend/.env.example` for the template.

## Deployment

A single Netlify site deploys from `main` and serves both the website and the
backend functions (config in the root `netlify.toml`). The API is same-origin
with the website, so no CORS is required.

| Part | URL | Source |
|------|-----|--------|
| Website | `716coffee.club` | `website/` |
| Backend API | `716coffee.club/.netlify/functions/` | `backend/netlify/functions/` |

Each push to `main` costs 15 Netlify credits (one build). The free tier provides 300 credits/month. **Batch changes and merge to `main` infrequently** — every push, including docs-only changes, rebuilds the site.

## Git Workflow

- **`main`** — Production. The single Netlify site auto-deploys from here.
- **`dev`** — Active development. Work here, test locally, then merge to `main` when ready.

```bash
git checkout dev
# make changes, test locally
git add . && git commit -m "Your message"
git checkout main && git merge dev && git push origin main
```

## Documentation

New volunteers and AI agents: start with [`docs/onboarding.md`](docs/onboarding.md).

For system architecture and data flows: [`docs/architecture.md`](docs/architecture.md).

## Previous Repositories

This monorepo consolidates:
- [z1g1/bocc-website](https://github.com/z1g1/bocc-website) (archived)
- [z1g1/bocc-backend](https://github.com/z1g1/bocc-backend) (archived)

Full git history from both repos is preserved.

## License

See [LICENSE](LICENSE).
