# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Buffalo Open Coffee Club (BOCC) website — a Jekyll static site hosted on GitHub Pages at `716coffee.club`. The site serves a weekly Tuesday morning networking event for Buffalo's small business and entrepreneurial community.

## Build & Development Commands

```bash
# Install dependencies (first time or after clone)
bundle install

# Local development with SSL (required for Eventbrite embed checkout)
bundle exec jekyll serve --host localhost --ssl-key ssl/localhost.key --ssl-cert ssl/localhost.crt

# Generate SSL certs for local dev (one-time setup, see README.md for full command)
openssl req -x509 -out ssl/localhost.crt -keyout ssl/localhost.key \
  -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
  -extensions EXT -config <(printf "[dn]\nCN=localhost\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth") -days 365

# Plain serve (without Eventbrite embed support)
bundle exec jekyll serve
```

Ruby environment managed via `rbenv` + `ruby-build`. Gems installed locally to `vendor/bundle`.

## Architecture

**Static site generator**: Jekyll with the `github-pages` gem, using `minimal-mistakes` remote theme (v4.26.2, `sunrise` skin).

**Hosting**: GitHub Pages via the `main` branch. Custom domain configured in `CNAME`.

**Key pages** (all Markdown with YAML front matter):
- `index.md` — Landing page with embedded Eventbrite checkout widget (event `1983098086761`)
- `about.md` — `/about/` — Event history, photo gallery
- `sponsorship.md` — `/sponsorship/` — Sponsor pitch with LinkedIn testimonial gallery
- `code-of-conduct.md` — `/code-of-conduct/`

**Check-in system** (`checkin/` + `js/checkin.js`):
- HTML forms at `/checkin/bocc` and `/checkin/coffee-and-code` collect attendee info
- `js/checkin.js` handles form submission, stores data in `localStorage` for return visitors, and POSTs to a separate backend at `https://bocc-backend.netlify.app/.netlify/functions/checkin`
- URL parameters: `debug`, `token`, `eventId`, `local` (set `local=1` to skip API calls)
- Check-in pages exist for `/checkin/bocc` and `/checkin/bocc-afternoon` (Coffee and Code moved to separate site)

**External integrations**:
- Eventbrite embedded checkout widget on the index page
- Backend API on Netlify Functions (separate `bocc-backend` repo)
- Contact/sponsor forms via Google Forms

**Images**: All stored in `assets/images/`. Header overlay image reused across multiple pages.

**Legacy**: `output/` directory contains old Pelican-generated HTML (project was migrated from Pelican to Jekyll).

## Git Workflow

This project deploys directly from `main` via GitHub Pages — there is no staging branch or CI pipeline. The `working` branch exists for in-progress development. Note: the `.gitignore` has unresolved merge conflict markers that should be cleaned up.

## Important Notes

- `_config.yml` changes require a server restart (Jekyll does not auto-reload config)
- SSL certs (`ssl/`, `*.key`, `*.cert`) are gitignored — each developer generates their own
- The `vendor/` directory contains bundled gems and is gitignored
- `_site/` is the Jekyll build output and is gitignored
