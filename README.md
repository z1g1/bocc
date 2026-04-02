# Buffalo Open Coffee Club (BOCC)

Monorepo for the Buffalo Open Coffee Club — a weekly Tuesday morning networking event for Buffalo's small business and entrepreneurial community.

**Website:** [716coffee.club](https://716coffee.club)
**Community:** [716.social](https://www.716.social)
**Events:** [Eventbrite](https://www.eventbrite.com/e/buffalo-open-coffee-club-tickets-1983098086761)

## Repository Structure

```
bocc/
├── website/        Jekyll static site → deployed to 716coffee.club via Netlify
├── backend/        Netlify Functions API → deployed to bocc-backend.netlify.app
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

Both sites deploy automatically from `main` via Netlify:

| Site | URL | Netlify Base Directory |
|------|-----|----------------------|
| Website | `716coffee.club` | `website/` |
| Backend API | `bocc-backend.netlify.app` | `backend/` |

Each push to `main` costs 30 Netlify credits (15 per site). The free tier provides 300 credits/month. **Batch changes and merge to `main` infrequently** (aim for 4-6 pushes/month). Build ignore scripts prevent unnecessary rebuilds when only docs or the other site changed.

## Git Workflow

- **`main`** — Production. Both sites auto-deploy from here.
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
