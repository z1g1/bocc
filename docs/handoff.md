# Handoff: Astro port release, then the admin app

Written 2026-11-16 (Monday) at the end of a long session. Read this first, then
`CLAUDE.md` and `docs/admin/ADMIN_APP_PLAN.md`.

## Where things stand

- **Phase 0** (spikes) is done. Results and the seven accepted ADR changes are in
  `docs/admin/ADMIN_APP_PLAN.md` and ADRs 0007–0011. The spike branch and its Neon/Netlify
  resources were cleaned up.
- **Phase 1** (Jekyll → Astro port) is **in production** since 2026-11-16 (`main` at `867dffa`,
  fast-forwarded from `dev`), including the check-in page as an Astro page. Release checks are
  in the plan's Phase 1 section. The "Next step" section below is done; kept for reference.
- **Phase 2+** (login, roles, data views, etc.) has **not started**. Zack wants Phase 1 shipped
  first.

Recent commits on `dev`:

| Commit | What |
|---|---|
| `ff47a30` | Port the website from Jekyll to Astro (Phase 1) |
| `1db3bb4` | Update docs for the Astro port |
| `4c2d357` | Record Phase 1 branch-deploy checks and staging DB setup |
| `3f71563` | Remove the Wilson Foundation funding acknowledgement (nav.yml, Footer.astro, checkin/bocc.html) |
| `15a6e6d` | Note the funding-line edit to the frozen check-in page |

## Next step: the Phase 1 production deploy

Waiting on Zack's go-ahead and timing. The recommendation given was to merge **after
Tuesday's event** (2026-11-17, check-in runs in the morning ET), though rollback is one click.
Do not push to `main` without an explicit go-ahead; each push costs 15 of 300 monthly Netlify
credits.

Once approved:

1. `cd backend && npm test` (152 tests should pass).
2. `npm run build` at the repo root (see the local-VM note below).
3. `git checkout main && git pull && git merge dev && git push origin main`, then back to `dev`.
4. Verify https://716coffee.club once the deploy is live:
   - `/`, `/about/`, `/sponsorship/`, `/code-of-conduct/`, `/privacy/`, `/assets/images/brand/`,
     an `/events/YYYY-MM-DD/` page, `/sitemap.xml`, `/feed.xml`, `/llms.txt`, `/robots.txt`
     return 200; an expired event date 302s to `/`; an unknown path gets the custom 404.
   - `/checkin/bocc` returns 200 with no redirect (and `?token=…` kept), has no Google
     Analytics, and `/js/checkin.js` matches `public/js/checkin.js` (unchanged from the old
     production file).
   - No "Wilson" / "Springboard" text on any page.
   - One check-in POST to `/.netlify/functions/checkin` with `debug: "1"` returns 200 and its
     row lands in Neon **production** with `debug = true`.
5. Tick "Merge to `main`" in the Phase 1 section of `docs/admin/ADMIN_APP_PLAN.md`, commit on
   `dev`. (Batch that commit with the next real work, since docs changes also rebuild.)

**Rollback:** Netlify → Deploys → the previous production deploy → "Publish deploy".

## Key facts for the port

- Astro 7.4.12 at the **repo root** (it must be at the Netlify base, or the adapter's
  `.netlify/v1` output isn't found in Phase 2). `output: "static"` for now; `@astrojs/netlify`
  arrives in Phase 2.
- Node 24, `ASTRO_TELEMETRY_DISABLED=1` (set in `netlify.toml`).
- Sass is compiled by `scripts/build-css.mjs` to `public/assets/css/main.css` (gitignored). That
  URL is fixed.
- The check-in page is `src/pages/checkin/bocc.astro` (site layout, `analytics={false}`), built
  to `checkin/bocc.html` by a small hook in `astro.config.mjs` so `/checkin/bocc` doesn't
  redirect. Sponsor redirect: `src/data/sponsor.yml`. (It was a frozen static file until
  2026-11-16; ADR 0007 decision 3 was amended.)
- Markdown renderer: `src/lib/markdown.ts` (`marked` + SmartyPants mode `"2"`).
- Reproducible builds: `BOCC_TODAY=YYYY-MM-DD`, `BOCC_BUILD_TIME=<ISO>`.
- The release checks (HTML/CSS/JSON-LD diff against a mirror of the live site) are recorded in
  the plan's Phase 1 section. The comparison tools lived in the session scratchpad and are gone;
  rebuild them if a re-comparison is needed.

**Local VM quirk** (this machine only, no AVX2): Astro's native compiler dies with
`Illegal instruction`. Before building locally:
`npm install --no-save --force @astrojs/compiler-binding-wasm32-wasi@<same version as @astrojs/compiler-binding>`
and move `node_modules/@astrojs/compiler-binding-linux-x64-gnu` out of `node_modules`.
Netlify is unaffected.

## Staging

- `dev` branch deploy: https://dev--bocc-backend.netlify.app, against the Neon `dev` branch
  (its own rotated `checkin_writer` password). Branch deploys are free.
- Netlify Free plan limits found this session: env var **scopes are Pro-only**, and `dev` is a
  **reserved branch keyword** (no branch-specific value). So `CHECKIN_DB_URL` uses the
  "Branch deploys" and "Deploy Previews" context values for staging; Production keeps its own.
  Details in `docs/backend/NEON_PERMISSIONS.md` ("Staging").

## Open items for Zack (not agent work)

- Delete the three leftover spike env vars in Netlify.
- Chrome unattended scheduled-task test on Modron's machine (later this week; Phase 0 item).
- Open question: how the Thursday social-check alert reaches Zack (Phase 5).
- LinkedIn API version pin (202511) still to confirm before Phase 5.

## After Phase 1 ships

Start **Phase 2** in `docs/admin/ADMIN_APP_PLAN.md` (Better Auth 1.7.25, `auth` schema,
admin/social roles, data views). The plan and ADR 0008 hold the decisions; don't reopen them.
If a check fails, propose an ADR change instead.

## Rules that bite

- Never push to `main` without Zack's go-ahead. Run backend tests and the root build first.
- Check-in is live every Tuesday morning ET: don't break `src/pages/checkin/bocc.astro`,
  `public/js/checkin.js` or `/.netlify/functions/checkin`. Use `debug: "1"` for every test
  check-in.
- Neon: project `young-queen-80162551`. The app uses `checkin_writer` only; the owner URL never
  goes in Netlify. CLI: `NEON_API_KEY="$(cat ~/.config/neon/api-key)" neon …`.
- Never print secrets (`.env.local`, `.env.backfill`, DB URLs).
- Migrations: new files only, and `npm run migrate` before deploying code that uses them.
- Don't automate against the real Meta, TikTok or LinkedIn accounts; no stealth/bot-evasion tools.
- Leave the untracked `docs/website/redesign-social/` alone (it's Zack's).
- Commit often on `dev` with the standard footer.
