# ADR 0010 — Event media in a private Neon Object Storage bucket

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Deciders:** Zack Glick

## Context

The admin stores the sign-in board photos, social photos, and the weekly promo video (about
4–5 MB, 1080×1920). Photos live in Google Drive today, and this app should not depend on Drive.

Netlify Functions can't receive the files: a request body is capped at 6 MB (about 4.5 MB of
binary) with a 60 s limit, and background functions take payloads of only 256 KB.

[Neon Object Storage](https://neon.com/docs/storage/overview), checked 2026-11-16:
- S3-compatible, with presigned PUT/GET URLs (GET links last up to 7 days)
- 5 GB per project on Free, with transfer out sharing the project's 5 GB/month allowance
- a bucket's access level (`private` / `public_read`) is fixed when it is created
- read and write credentials are scoped to a branch, not to a bucket
- buckets branch with the database

## Decision

1. **One private bucket. There is no public bucket.**
   - Uploading: the browser uploads straight to the bucket through presigned PUTs, which the
     server creates only after it checks the user's role.
   - Viewing: always through short-lived presigned GET URLs.
   - Nothing posts directly from the bucket, because social posting is done in the browser
     (ADR 0011). That removes the earlier reason for a public bucket, which was Threads only
     being able to fetch videos from a public URL.
2. **`event_media` table:** `event_date`, `kind` (`signin_board` / `social_photo` /
   `promo_video`), object keys, content type, size, `publicly_usable` (social photos), status
   (`pending` → `ready`), and who uploaded it.
3. **The browser makes the resized copies before upload.** It uploads:
   - the **untouched original** (the archive)
   - a **1600px JPEG** display copy, which also drops metadata such as GPS location
   - a **400px thumbnail**

   No images are processed on the server.

   The file picker uses `accept="image/jpeg,image/png"`, so iOS Safari converts HEIC to JPEG,
   and checks the MIME type, not the extension. **If the browser can't decode a photo** (an
   iPhone HEIC picked in Chrome on a desktop or Android), the upload is refused with a clear
   message: "upload from your iPhone, or export the photo as JPEG". No WASM HEIC decoder in the
   MVP (amended 2026-11-16).
4. **Google Drive is not used.** The old sign-in board photos (45, Aug 2024 to Nov 2026, exported
   from Drive) are imported once, in Phase 3, by a local script (amended 2026-11-17, previously
   deferred):
   - it runs on an operator's machine, not the server, so "no images are processed on the
     server" still holds. It converts HEIC with a local decoder and writes the same three
     objects per photo as a browser upload (original, 1600px JPEG, 400px thumbnail)
   - each photo is matched to an event by the date in its file name, else by its capture date
     (the most recent event on or before it). A dry run prints the match table, and the
     operator confirms uncertain matches before anything is written
   - imported photos are `signin_board`, never `publicly_usable`
   Other old Drive photos (social photos) are still out of scope.

## Consequences

- About 1 GB a year of new storage, well inside the 5 GB free tier for several years.
- The sign-in board photos, which show handwritten names, are never publicly reachable.
- *Settled in Phase 0 (2026-11-16), details and links in the plan:*
  - Object Storage is GA (2026-09-18), though its API endpoints are still labelled Beta
  - iOS Safari converts HEIC to the first type in `accept`. Only Safari 17+ decodes HEIC;
    Chrome on desktop and Android can't
  - Storage credentials work on the branch they're made on and all its children, so staging
    needs its own
- *Still unverified:* whether inherited objects count toward 5 GB, and presigned PUT from mobile
  browsers.
- *Amended 2026-11-16:* the HEIC refusal above.
- *Amended 2026-11-17:* the one-time import of the old sign-in board photos (decision 4).
