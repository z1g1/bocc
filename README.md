# Buffalo Open Coffee Club (BOCC)

Monorepo for the Buffalo Open Coffee Club — a weekly Tuesday morning networking event for Buffalo's small business and entrepreneurial community.

**Website:** [716coffee.club](https://716coffee.club)
**Events:** [Luma](https://luma.com/716coffeeclub)

## Repository Structure

```
bocc/
├── src/, public/   Astro website (repo root) → served at 716coffee.club via Netlify,
│                   plus the admin app (/admin/, /login/) rendered on demand
├── backend/        Netlify Functions API → served at 716coffee.club/.netlify/functions/
└── docs/           All project documentation
    ├── onboarding.md       Start here if you're new
    ├── architecture.md     System overview and data flows
    ├── backend/            Backend technical docs, epics, stories
    ├── website/            Website docs and future work
    └── strategy/           Social media and brand guides
```

## Quick Start

### Website (Astro)

Node 24. From the repo root:

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static site in dist/
```

See `CLAUDE.md` (Website section) for where pages, data and styles live.

### Admin app (`/admin/`)

A login-only area for organizers (ADR 0008): Better Auth (password + passkey, no public
sign-up), roles `admin` / `social`, every change audited. It runs as the `admin_app` database
role from the Astro SSR function. Its settings go in a gitignored `.env.admin` at the repo root
(`ADMIN_DB_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:4321`; see
`docs/backend/NEON_PERMISSIONS.md`).

```bash
npm run dev:admin      # astro dev with .env.admin loaded; sign in at /login/
npm run create-admin   # make a login (prompts; --role admin|social, default admin)
npm run test:db        # admin tests against a throwaway Postgres in Docker (never Neon)
```

Admins manage other users at `/admin/users/`.

### Backend (Netlify Functions)

```bash
cd backend
npm install

# Run tests (~150 tests)
npm test

# Local dev (requires Netlify CLI and environment variables)
netlify dev

# Database migrations run from CI before each dev/main deploy (docs/backend/DEPLOYS.md).
# Manual fallback only (operator; check which Neon branch the env file points at):
npm run migrate
```

Required environment variables (set in Netlify dashboard, never committed):
- `CHECKIN_DB_URL`: Neon Postgres URL for the least-privilege `checkin_writer` role (see `docs/backend/NEON_PERMISSIONS.md`)
- Admin app: `ADMIN_DB_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (optional `ADMIN_DB_POOL_MAX`), per deploy context

Optional:
- `ALLOWED_ORIGIN` — CORS origin (set to `https://716coffee.club` in production)

See `backend/.env.example` for the template.

## Deployment

A single Netlify site deploys from `main` and serves both the website and the
backend functions (config in the root `netlify.toml`). The API is same-origin
with the website, so no CORS is required.

| Part | URL | Source |
|------|-----|--------|
| Website | `716coffee.club` | repo root (`src/`, `public/`) |
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
