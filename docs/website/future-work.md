# Future Work & Open Questions

## Event Pages

`website/scripts/generate_event_pages.rb` runs before each Netlify build and creates a page for each of the next 13 Tuesdays at `/events/YYYY-MM-DD/`, skipping Dec 20 through Jan 2. Each page carries one Event in its structured data, because Google wants one event per URL. They are in the sitemap but not in site navigation. Expired URLs redirect to the home page.

The site needs a deploy at least once a quarter or the dates run out. Run the script locally to preview the pages.

### Open question
The pages are nearly identical and nothing links to them. Check the Events and Pages reports in Search Console a few weeks after deploying. If Google doesn't index them, link to the next event from the home page.

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
Implemented post-check-in countdown redirect. Sponsor config in `_data/sponsor.yml` (name, URL, delay, enabled toggle). Currently defaults to 716coffee.club. Countdown shows "Visiting [name] in 5 seconds..." with "Go now" and "Stay here" options.

### ~~Coffee and Code / BOCC Afternoon Events (UX R16)~~ - RESOLVED 2026-03-21
Coffee and Code moved to their own site -- check-in page removed. BOCC Afternoon Edition promoted on homepage with upcoming dates and RSVP link. Check-in page retained for event-day use.

