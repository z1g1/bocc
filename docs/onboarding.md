# Onboarding Guide

Welcome to the Buffalo Open Coffee Club (BOCC) project. This guide gets new volunteers and AI agents up to speed quickly.

## What is BOCC?

A weekly Tuesday morning networking event (7:30-9 AM) for Buffalo's small business and entrepreneurial community. We meet at a local coffee shop and connect people. The tech stack supports event registration, attendee check-in, and community management.

## System Overview

```
Attendee visits 716coffee.club
    ↓
RSVPs on Luma (embedded on the homepage and event pages)
    ↓
Attends event, scans QR code
    ↓
Check-in form (src/pages/checkin/bocc.astro, served at /checkin/bocc)
    ↓
js/checkin.js POSTs to backend API
    ↓
Backend: validates → stores in Neon Postgres → returns streak
```

For a detailed technical diagram, see [architecture.md](architecture.md).

## Repository Layout

| Directory | What's In It | Deploy Target |
|-----------|-------------|---------------|
| `src/`, `public/` (repo root) | Astro website: pages, YAML data, Markdown, Sass, static files | Netlify → `716coffee.club` |
| `backend/` | Netlify Functions (Node.js serverless) + `db/migrations/` | Netlify → `716coffee.club/.netlify/functions/` |
| `docs/` | All documentation (you're reading it) | Not deployed |

## Getting Started

### Prerequisites

- **Git** for version control
- **Node.js** 24 + npm for the website and the backend
- **Netlify CLI** (`npm install -g netlify-cli`) for local backend development
- **Neon CLI** (`npm install -g neon`), only if you manage the database

### Clone and Set Up

```bash
git clone https://github.com/z1g1/bocc.git
cd bocc
```

### Run the Website Locally

```bash
npm install      # at the repo root
npm run dev
# Open http://localhost:4321
```

Local SSL certs are optional — see the main [README.md](../README.md) for the openssl command.

### Run the Admin App Locally

The admin app (`/admin/`, ADR 0008) needs a database. Put `ADMIN_DB_URL` (an `admin_app` URL on
a Neon **dev** branch, never `production`), `BETTER_AUTH_SECRET` and
`BETTER_AUTH_URL=http://localhost:4321` in a gitignored `.env.admin` at the repo root, then:

```bash
npm run create-admin   # make yourself a login
npm run dev:admin      # sign in at http://localhost:4321/login/
npm run test:db        # admin tests on a throwaway Postgres (needs Docker; never touches Neon)
```

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
1. `npm run dev` (repo root)
2. `cd backend && netlify dev`

The website check-in form talks to the production backend by default (same-origin: `716coffee.club/.netlify/functions/`). To test against your local backend, add `?local=1` to the check-in URL.

## Environment Variables (Secrets)

The backend requires this secret, set in the Netlify dashboard (never committed to git):

| Variable | Service | Purpose |
|----------|---------|---------|
| `CHECKIN_DB_URL` | Neon | Least-privilege `checkin_writer` connection (attendees, check-ins) |

Optional: `ALLOWED_ORIGIN` — CORS origin (production: `https://716coffee.club`)

The static website has **no secrets**. The admin app needs `ADMIN_DB_URL`,
`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` (optional `ADMIN_DB_POOL_MAX`), set per Netlify deploy
context; see `docs/backend/NEON_PERMISSIONS.md`.

If you need access to these services, ask the project maintainer (Zack Glick).

## External Services

| Service | Purpose | Dashboard |
|---------|---------|-----------|
| **Netlify** | Hosting for both website and backend | netlify.com |
| **Neon** | Postgres database for attendees and check-ins | console.neon.tech |
| **Airtable** | Read-only archive of older records | airtable.com |
| **Luma** | Event RSVPs and calendar | luma.com/716coffeeclub |
| **Eventbrite** | Discovery listing only | eventbrite.com |
| **GitHub** | Source code and version control | github.com/z1g1/bocc |

## Deployment

A single Netlify site (serving both the website and the functions) auto-deploys when you push to `main`. Each push costs 15 Netlify credits (one build). The free tier gives 300 credits/month, so **limit pushes to main to ~4-6 per month**.

**Workflow:**
1. Work on the `dev` branch
2. Test locally (website: `npm run build` and `npm run dev`, backend: `npm test`)
3. When ready, merge `dev` → `main` and push (the `main` deploy waits for approval in GitHub)
4. The "Migrate and deploy" GitHub workflow migrates Neon, then deploys through a Netlify build hook

Database schema changes: add a new file to `backend/db/migrations/`. The workflow applies it
before the code that needs it goes live. Keep it expand-then-contract, so it works with the code
that is live while it runs. See [docs/backend/DEPLOYS.md](backend/DEPLOYS.md).

## Key Files to Know

### Website
- `src/data/site.yml` — Site settings: title, description, analytics id, event facts
- `src/data/home.yml` — Homepage copy (the Luma calendar embed is in `src/components/home/Signup.astro`)
- `src/pages/events/[date].astro` — the `/events/YYYY-MM-DD/` pages, rendered from Neon on request (ADR 0009); event links are edited in the admin
- `public/js/checkin.js` — Check-in form logic (the most complex JS file)
- `src/pages/checkin/bocc.astro` — The check-in page (site layout, no analytics). Keep its
  element IDs: `public/js/checkin.js` reads them
- `src/data/sponsor.yml` — The post-check-in sponsor redirect (on/off, name, link, delay)
- `src/layouts/Default.astro` — CSP, fonts, scripts; `src/components/Seo.astro` and
  `EventJsonLd.astro` — metadata and structured data

### Backend
- `backend/netlify/functions/checkin.js` — Main API endpoint
- `backend/netlify/functions/utils/check-in.js` — Check-in use-case
- `backend/netlify/functions/utils/validation.js` — Input validation
- `backend/netlify/functions/utils/pg-store.js` — Postgres check-in store
- `backend/db/migrations/` — Database schema, views, and roles
- `netlify.toml` — Netlify build, functions, and redirect config

### Documentation
- `docs/backend/NEON_PERMISSIONS.md` — Database roles, grants, and key handling
- `docs/adr/` — Architecture decisions (datastore: 0003, 0004, 0005, 0006; admin app: 0007–0011)
- `docs/admin/ADMIN_APP_PLAN.md` — Phased plan for the Astro port and admin app
- `docs/admin/PHASE2_RELEASE.md` — Operator steps to release login, roles and the data views
- `docs/strategy/` — Social media strategies and brand guide

## Common Tasks for Volunteers

- **Update event info**: Edit `src/data/site.yml` (event facts) or `src/data/home.yml` (homepage copy)
- **Update sponsor redirect**: Edit `src/data/sponsor.yml`
- **Add a new page**: Create a new `.md` file in `src/content/pages/` with YAML front matter,
  including a `permalink`
- **Fix a backend bug**: Edit files in `backend/netlify/functions/`, run `npm test`
- **Update social media strategy**: Edit docs in `docs/strategy/`
- **Review API permissions**: See `docs/backend/NEON_PERMISSIONS.md`

## Questions?

Contact the project maintainer or open an issue on [GitHub](https://github.com/z1g1/bocc/issues).
