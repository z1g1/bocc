# Onboarding Guide

Welcome to the Buffalo Open Coffee Club (BOCC) project. This guide gets new volunteers and AI agents up to speed quickly.

## What is BOCC?

A weekly Tuesday morning networking event (7:30-9 AM) for Buffalo's small business and entrepreneurial community. We meet at a local coffee shop and connect people. The tech stack supports event registration, attendee check-in, and community management.

## System Overview

```
Attendee visits 716coffee.club
    ↓
Registers via Eventbrite embed on homepage
    ↓
Attends event, scans QR code
    ↓
Check-in form (website/checkin/bocc.html)
    ↓
js/checkin.js POSTs to backend API
    ↓
Backend: validates → stores in Neon Postgres → invites to Circle.so
    ↓
Weekly: enforcement bot checks profile photos via Circle.so API
```

For a detailed technical diagram, see [architecture.md](architecture.md).

## Repository Layout

| Directory | What's In It | Deploy Target |
|-----------|-------------|---------------|
| `website/` | Jekyll static site (HTML, Markdown, JS, CSS) | Netlify → `716coffee.club` |
| `backend/` | Netlify Functions (Node.js serverless) + `db/migrations/` | Netlify → `716coffee.club/.netlify/functions/` |
| `docs/` | All documentation (you're reading it) | Not deployed |

## Getting Started

### Prerequisites

- **Git** for version control
- **Ruby** (3.3.x) + Bundler for the website (managed via `rbenv`)
- **Node.js** (20+) + npm for the backend
- **Netlify CLI** (`npm install -g netlify-cli`) for local backend development
- **Neon CLI** (`npm install -g neon`), only if you manage the database

### Clone and Set Up

```bash
git clone https://github.com/z1g1/bocc.git
cd bocc
```

### Run the Website Locally

```bash
cd website
bundle install
bundle exec jekyll serve
# Open http://localhost:4000
```

For Eventbrite embed testing, you need local SSL certs — see the main [README.md](../README.md) for the openssl command.

### Run the Backend Locally

```bash
cd backend
npm install

# Run tests (no API keys or database needed)
npm test

# Run the dev server (requires environment variables)
# Copy .env.example to .env and fill in values, then:
netlify dev
```

For local development, point `CHECKIN_DB_URL` at a **Neon dev branch**, never `production`.
Ask the maintainer for a branch and a `checkin_writer` URL.

### Run Both Together

In two terminals:
1. `cd website && bundle exec jekyll serve`
2. `cd backend && netlify dev`

The website check-in form talks to the production backend by default (same-origin: `716coffee.club/.netlify/functions/`). To test against your local backend, add `?local=1` to the check-in URL.

## Environment Variables (Secrets)

The backend requires these secrets, all set in the Netlify dashboard (never committed to git):

| Variable | Service | Purpose |
|----------|---------|---------|
| `CHECKIN_DB_URL` | Neon | Least-privilege `checkin_writer` connection (attendees, check-ins) |
| `AIRTABLE_API_KEY` | Airtable | Enforcement warning records |
| `AIRTABLE_BASE_ID` | Airtable | Identifies the BOCC base |
| `CIRCLE_API_TOKEN` | Circle.so | Admin API for member management |
| `CIRCLE_HEADLESS_API` | Circle.so | Bot user for sending DMs |

Optional: `ALLOWED_ORIGIN` — CORS origin (production: `https://716coffee.club`)

The website has **no secrets** — it's a static Jekyll site.

If you need access to these services, ask the project maintainer (Zack Glick).

## External Services

| Service | Purpose | Dashboard |
|---------|---------|-----------|
| **Netlify** | Hosting for both website and backend | netlify.com |
| **Neon** | Postgres database for attendees and check-ins | console.neon.tech |
| **Airtable** | Enforcement warnings; historical check-in archive | airtable.com |
| **Circle.so** | Community platform (716.social) | app.circle.so |
| **Eventbrite** | Event registration and ticketing | eventbrite.com |
| **GitHub** | Source code and version control | github.com/z1g1/bocc |

## Deployment

A single Netlify site (serving both the website and the functions) auto-deploys when you push to `main`. Each push costs 15 Netlify credits (one build). The free tier gives 300 credits/month, so **limit pushes to main to ~4-6 per month**.

**Workflow:**
1. Work on the `dev` branch
2. Test locally (website: `bundle exec jekyll serve`, backend: `npm test`)
3. When ready, merge `dev` → `main` and push
4. The site deploys automatically within 2-3 minutes

Database schema changes are **not** applied by deploys. Add a new file to
`backend/db/migrations/` and run `npm run migrate` from `backend/` (operator with the owner URL)
**before** deploying code that depends on it.

## Key Files to Know

### Website
- `website/_config.yml` — Jekyll configuration (restart server after changes)
- `website/index.md` — Homepage with Eventbrite embed
- `website/js/checkin.js` — Check-in form logic (the most complex JS file)
- `website/_data/sponsor.yml` — Post-check-in sponsor redirect config
- `website/_includes/head/custom.html` — CSP headers, structured data, analytics

### Backend
- `backend/netlify/functions/checkin.js` — Main API endpoint
- `backend/netlify/functions/utils/check-in.js` — Check-in use-case
- `backend/netlify/functions/utils/validation.js` — Input validation
- `backend/netlify/functions/utils/pg-store.js` — Postgres check-in store
- `backend/netlify/functions/utils/circle.js` — Circle.so API client
- `backend/db/migrations/` — Database schema, views, and roles
- `netlify.toml` — Netlify config including scheduled function cron

### Documentation
- `docs/backend/NEON_PERMISSIONS.md` — Database roles, grants, and key handling
- `docs/backend/CIRCLE_PERMISSIONS.md` — Circle.so API permissions setup
- `docs/backend/SAFETY_LIMITS_SPECIFICATION.md` — Why safety limits exist
- `docs/adr/` — Architecture decisions (datastore: 0003, 0004, 0005)
- `docs/strategy/` — Social media strategies and brand guide

## Common Tasks for Volunteers

- **Update event info**: Edit `website/index.md` (Eventbrite widget, event details)
- **Update sponsor redirect**: Edit `website/_data/sponsor.yml`
- **Add a new page**: Create a new `.md` file in `website/` with YAML front matter
- **Fix a backend bug**: Edit files in `backend/netlify/functions/`, run `npm test`
- **Update social media strategy**: Edit docs in `docs/strategy/`
- **Review API permissions**: See `docs/backend/NEON_PERMISSIONS.md` and `docs/backend/CIRCLE_PERMISSIONS.md`

## Questions?

Contact the project maintainer or open an issue on [GitHub](https://github.com/z1g1/bocc/issues).
