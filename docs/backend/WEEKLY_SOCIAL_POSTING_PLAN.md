# Plan: Weekly social posting beyond LinkedIn

Status: **Proposed** (2026-10-27). Nothing here is built yet.

## Goal

One command creates the week's BOCC announcement on every channel, using the same image and text:

1. **LinkedIn**: the event and the publishing post from the admin's profile (built today in
   `tools/linkedin-events`).
2. **Facebook Page**: a photo post as the BOCC Page.
3. **Instagram**: a story on the BOCC business account.
4. **First comment**: a comment that links to the LinkedIn event, added to every post that can
   take one.

The text comes from the existing copy in `config.py`, so `--alternate-location` (the food hall
weeks) changes every channel at once. The Meta side goes through a **Meta Business portfolio**
(business.facebook.com) that owns the Page, the Instagram account and the app.

## What the platforms allow (checked 2026-10-27)

| Need | Facebook Page | Instagram story | LinkedIn post |
|---|---|---|---|
| Publish image + text | Yes. `POST /{page-id}/photos` with the caption, using a Page token ([Posts guide](https://developers.facebook.com/docs/pages-api/posts/)) | Image yes. `POST /{ig-id}/media` with `media_type=STORIES`, then `media_publish` ([Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)). **Stories have no caption field** | Yes, already built |
| Image format | URL in the docs (direct `source` upload not confirmed, see Phase 0) | **JPEG only, 8 MB max, 9:16 recommended, and only from a public `image_url`**. Meta fetches it with cURL | PNG/JPEG, already built |
| First comment with a link | Probably yes. `POST /{post-id}/comments` as the Page. Endpoint and permission not confirmed in the docs (reference 404'd), see Phase 0 | **No.** No caption, no comments, and "Publishing stickers (i.e., link, poll, location) is not supported" | Yes. `POST /rest/socialActions/{postUrn}/comments`. The [Getting Access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) page lists `w_member_social` (already granted) as "Post, comment and like posts". The Comments page calls it `w_member_social_feed`, so confirm in Phase 0 |
| Create an event | **No.** The Page reference (v26.0) has no `events` edge. Facebook Events stay manual | n/a | Yes, already built |
| Limits | Normal Page limits | 100 API posts per 24h (well clear) | 150 member requests a day |

Two of these change what you asked for:

- **The Instagram story can't carry the text or the link.** To show the text, it has to be drawn
  onto the image. The link can't be added at all, and that stays a manual sticker in the app if
  you want one.
- **The Instagram story needs a 9:16 JPEG at a public URL.** Our cover is a 16:9 PNG on a local
  disk, so the tool has to make a story version and host it somewhere Meta can fetch.

## How it works

```
bocc-event week --image cover.jpg [--alternate-location] --live
  1. LinkedIn   create event → post from admin profile          (existing)
  2. LinkedIn   first comment on that post: "Details & RSVP: <event url>"
  3. Facebook   photo post as the Page: same image, same text
  4. Facebook   first comment as the Page: "RSVP on LinkedIn: <event url>"
  5. Instagram  build a 1080x1920 JPEG (cover + text) → host → STORIES container → publish
  each step → ledger entry per (date, channel), so a rerun resumes and never double-posts
```

LinkedIn goes first because every other step needs the event URL. A failure stops the run.
`bocc-event week --date … --live` then resumes at the first step that isn't done, the same way
`post` works today.

## Design

**Package layout** (`tools/linkedin-events` → rename to `tools/social-posting` in Phase 4):
- `meta.py`: Graph API client. Same rules as `client.py`: token goes only to
  `https://graph.facebook.com`, redirects aren't followed, and the token is never printed.
  Pinned to `v26.0` in `config.py`, with a sunset note like the one for `LINKEDIN_VERSION`.
- `story.py`: makes the 9:16 JPEG (cover fitted onto a brand-colour background, plus the post
  text).
- `channels.py`: one small step per channel (`publish(ctx) → result`), so later weekly posts
  (see Phase 5) plug in without changing the orchestration.
- `ledger.py`: entries become `{date: {channel: {status, id, url, …}}}`. Old LinkedIn-only
  entries are read as the `linkedin` channel.
- `cli.py`: new `week` command with `--only facebook,instagram` / `--skip instagram`. `create`
  and `post` keep working.

**Hosting the story image.** Two options, in order of preference:
1. Upload it to the Page as an **unpublished** photo (`published=false`), read back its CDN URL,
   and pass that as `image_url`. There's nothing to deploy and no new service. This isn't a
   documented pattern, so Phase 0 has to prove it works.
2. Fallback: commit the JPEG to `website/assets/images/social/` and wait for the deploy. That's
   reliable, but it costs 15 Netlify credits a week and adds a wait. (Not recommended as the
   weekly path.)

**Copy.** Add `FACEBOOK_COMMENT_TEMPLATE` / `LINKEDIN_COMMENT_TEMPLATE` (`{event_url}`) and keep
everything in `config.py`. The links go in the first comment, never in the post body, which
matches `docs/strategy/LINKEDIN-WEEKLY-CHECKLIST.md`.

**Dry run stays the default.** It prints every payload, writes the story JPEG to a local file for
review, and sends nothing. `--live` asks for one confirmation that lists every channel.

## Security and permissions

Per the root `CLAUDE.md`, write a new `docs/backend/META_PERMISSIONS.md` before any code. The
plan is:

- **One Meta app** owned by the BOCC Business portfolio, in Development mode or **Standard
  Access**. The docs say Standard Access is for "apps that will only be used by people who have
  roles on them", which fits a tool used only by our own admins. That means no App Review and no
  business verification.
- **A System User token**, generated in the Business portfolio, scoped to the BOCC Page and the
  IG account only. It isn't tied to Zack's personal login, so it doesn't expire after 60 days
  like a user token would.
- **Permissions, least privilege:** `pages_manage_posts`, `pages_read_engagement`,
  `pages_manage_engagement` (comments), `instagram_basic`, `instagram_content_publish`, and
  `business_management` only if the System User calls need it. Nothing for ads, messaging or
  insights.
- **Secrets:** `META_SYSTEM_USER_TOKEN`, `META_PAGE_ID` and `META_IG_USER_ID` come from env vars or
  a 0600 file under `~/.config/bocc-social/`, never the repo. The Page token is derived at run
  time (`GET /me/accounts`) and never stored.
- **LinkedIn:** no new scope, if Phase 0 confirms that `w_member_social` covers comments.
  Otherwise update `LINKEDIN_PERMISSIONS.md` first.

## Phases

### Phase 0: Prove the unknowns (manual, with Graph API Explorer / curl, ~1 hour)

- [ ] Set up the Business portfolio: the Page and the IG account are both in it, and IG is
      linked to the Page as a professional account.
- [ ] Create the app and the System User, generate the token with only the scopes above, and
      record the token's expiry setting.
- [ ] A Page photo post with a caption, uploaded with multipart `source` (not a URL).
- [ ] A comment as the Page on that post, recording the exact permission it needed.
- [ ] An unpublished Page photo whose URL works as an IG `image_url` for a STORIES container.
- [ ] A LinkedIn comment on a test post with the current token, checking whether the plain URL is
      clickable.
- [ ] Write `META_PERMISSIONS.md` from what actually worked. Change this plan if anything failed.

### Phase 1: LinkedIn first comment (small, only uses the access we already have)

- [ ] `events.comment_on_post()`, a `linkedin_comment` ledger step, tests, and a README update.

### Phase 2: Facebook Page post and comment

- [ ] `meta.py` client + `facebook` and `facebook_comment` steps, with tests using the mock
      transport, like the LinkedIn tests.

### Phase 3: Instagram story

- [ ] `story.py` (1080x1920 JPEG ≤ 8 MB, sRGB), the hosting step, the STORIES container,
      `media_publish`, and a container status check before publishing.

### Phase 4: `week` command, ledger migration, rename

- [ ] Orchestrate, resume, confirm. Rename to `tools/social-posting` (CLI name `bocc-social`; keep
      a `bocc-event` alias). Update the `bocc-linkedin-event` skill, `CLAUDE.md` and the READMEs.

### Phase 5 (later, optional): the rest of the week's boilerplate

The strategy docs describe a Monday reminder, Tuesday recap and Wednesday carousel. Each would be
a new step built on the same channels, which can be added once the announcement runs reliably.

## Decisions needed

1. **Story text:** draw the post text onto the story image (needs **Pillow**, the stable,
   maintained imaging library, as the first runtime dependency), or ship only the image? *Recommend
   drawing it on.* Otherwise the story says nothing about the food hall on alternate weeks.
2. **Story image hosting:** unpublished Page photo (recommended, if Phase 0 proves it works) or a
   website deploy (15 credits a week)?
3. **Instagram feed post too?** A feed post has a caption, so it could carry the text. But links
   in IG captions and comments aren't clickable, and the docs don't confirm an endpoint for a
   top-level comment on our own media. *Recommend leaving it out for now.*
4. **Facebook Events:** the API can't create them, and the Facebook strategy calls them the most
   important feature on the platform. Keep the recurring event manual, or link the LinkedIn event
   from the Page post (what this plan does)?
5. **Phase 5 scope:** is "boilerplate for the week" just the announcement on three channels, or
   also the Monday, Tuesday and Wednesday posts?
