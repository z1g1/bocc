# Future Work & Open Questions

## Automated Event startDate in Structured Data

The JSON-LD in `_includes/head/custom.html` has a hardcoded `startDate` for the next event occurrence. The `eventSchedule` property with `repeatFrequency: P1W` and `byDay: Tuesday` handles the recurring signal for Google, but `startDate` should ideally stay near-future.

### Recommended approach
GitHub Actions weekly cron + Liquid template to calculate next Tuesday at build time.

### Concerns
1. **Google doesn't crawl on your schedule.** Even with weekly rebuilds, Google may cache old pages for days/weeks. `eventSchedule` is more important than `startDate` for recurring events.
2. **Christmas exclusion logic.** Event skips the last 2 weeks of December. Need to define exact dates (Dec 18-31? Dec 22-31?) — varies by year.
3. **GitHub Actions cron is best-effort.** Not SLA-backed; may be delayed or skipped during high load.
4. **Silent build failures.** If a cron-triggered build fails, the site stays on the old version. Need failure notifications.
5. **Effort vs benefit.** Google uses `eventSchedule` as the primary signal for recurring events. Manual updates once or twice a year may be sufficient.

### Decision
Deferred — `eventSchedule` is doing the heavy lifting. Revisit if Google Search Console shows issues with event rich results.

---

## Resolved Items

### ~~Dual Eventbrite Event IDs (UX R5)~~ - RESOLVED 2026-03-20
Unified all references to event ID `1983098086761` across index.md, about.md, navigation.yml, custom.html structured data, and _config.yml.

### ~~sessionStorage vs localStorage for Check-in (UX R4)~~ - RESOLVED 2026-03-20
Switched to localStorage with 30-day TTL. Returning visitors are now recognized across weekly visits.

### ~~Parking/Transit/Wayfinding Info (UX R13)~~ - RESOLVED 2026-03-21
Added "Getting Here" section to homepage with entrance directions, escalator/elevator info, parking details, and link to Seneca One's parking page.

### ~~Homepage Social Proof~~ - RESOLVED 2026-03-21
Added "What People Are Saying" section with 3 testimonial blockquotes (Scott Wojtanik, Yelenna Cichocki, Lena Levine) linked to their original LinkedIn posts.

### ~~"What to Expect" First-Timer Content~~ - RESOLVED 2026-03-21
Added "What to Expect" section to homepage explaining the schedule (open networking, Gives and Asks, no hard out), etiquette (no pitching, bring business cards), and first-timer welcome.

---

## Needs User Input

### Sponsor Contact Form (UX R2)
The same Google Form is used for sponsorship inquiries, Code of Conduct violation reports, and general contact. A separate form for sponsorship would improve professionalism. Requires creating a new Google Form.

### ~~Sponsor Redirect After Check-in (UX R7)~~ - RESOLVED 2026-03-21
Implemented post-check-in countdown redirect. Sponsor config in `_data/sponsor.yml` (name, URL, delay, enabled toggle). Currently defaults to 716.social. Countdown shows "Visiting [name] in 5 seconds..." with "Go now" and "Stay here" options.

### ~~Coffee and Code / BOCC Afternoon Events (UX R16)~~ - RESOLVED 2026-03-21
Coffee and Code moved to their own site -- check-in page removed. BOCC Afternoon Edition promoted on homepage with upcoming dates and RSVP link. Check-in page retained for event-day use.

