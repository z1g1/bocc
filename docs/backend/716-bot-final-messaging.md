> **Retired (2026-11-07):** Circle and profile photo enforcement were removed. Kept for history only. See [ADR 0006](../adr/0006-retire-circle-postgres-only.md).

# 716.social Bot — Profile Photo Reminders (Final Copy)

## The Story Arc

A quirky, self-aware robot introduces itself with humor → establishes persistent determination → drops the jokes to get real → reluctantly says goodbye. The bot becomes a character the user has a relationship with, making the escalation feel personal rather than procedural.

---

## Variables

- `${userName}` — User's display name
- `${warningsRemaining}` — Remaining reminders before deactivation
- `${nextCheckDate}` — Date of next automated check

---

## Message #1 — "The Introduction" (Week 1)

```
🤖 *Beep boop!* Hey ${userName},

So, fun fact — I'm a robot and even *I* have a profile photo. Just saying. 👀

We noticed your 716.social profile is still rocking the default avatar. Profile photos are a big deal around here — they help build trust and make our community feel more like, well, a community. They're also part of our [community guidelines](https://www.716.social/coc).

No rush panic — this is just **reminder 1 of 4**. But heads up: accounts without photos do eventually get temporarily deactivated. You've got **${warningsRemaining} more reminders** before that happens.

Just pop over to your profile settings and upload any photo. It takes about 12 seconds. (I timed it. Because I'm a robot. That's what we do.)

Need help? Reach the admin team via this [form](https://forms.gle/y5itkP1Ax7TdiSQD6). 

*End transmission* 📡
— 716.social Bot
```

---

## Message #2 — "The Persistent One" (Week 2)

```
🤖 ${userName}! Round 2.

My job is to remind you about your missing profile photo, and I am *very* good at my job. (It's literally the only thing I do.)

**Reminder 2 of 4** — **${warningsRemaining} left** before temporary deactivation per our [community guidelines](https://www.716.social/coc).

Go to **profile settings**, upload a photo, and I'll stop bugging you. Deal?

Help available via [this form](https://forms.gle/y5itkP1Ax7TdiSQD6).

— 716.social Bot 🤖
```

---

## Message #3 — "The Serious One" (Week 3)

```
🤖 ${userName} — this is getting real.

**Reminder 3 of 4.** Your account will be temporarily deactivated if a profile photo isn't added before the next check.

I don't want to see you go! (Well, technically I can't *see* anything, but you get the idea.)

**Please add a photo now:** profile settings → upload → done.

Per our [community guidelines](https://www.716.social/coc), all members need a profile photo.

[Contact admins if you need help](https://forms.gle/y5itkP1Ax7TdiSQD6).

— 716.social Bot
```

---

## Message #4 — "The Goodbye" (Week 4)

```
🚨 ${userName} — final warning from the bot.

I've sent 3 reminders and time's up. Without a profile photo by **${nextCheckDate}**, your account will be temporarily deactivated per our [community guidelines](https://www.716.social/coc).

**Profile settings → upload a photo.** That's all it takes.

If you do get deactivated, reach out via this [form](https://forms.gle/y5itkP1Ax7TdiSQD6) — add a photo and you'll be back in.

*One last beep boop.* 🤖
— 716.social Bot
```

---

## Message #5 — "The Celebration" (Triggered when photo is added)

```
🤖 *BEEP BOOP BEEP BOOP!!* 🎉

${userName}!! You did it! My sensors are detecting a profile photo and I am — if a robot can be — *thrilled.*

You look great. (Okay fine, I can't actually judge that. But my photo-detection algorithm is giving you two thumbs up. 👍👍)

Thanks for being part of the 716.social community — now everyone can put a face to the name!

*Happy beep boop.* 🤖
— 716.social Bot
```

---

## Narrative Summary

| # | Trigger | Tone | Robot Emoji Use | Humor Level | Length |
|---|---------|------|----------------|-------------|--------|
| 1 | Week 1 | Warm, self-deprecating | Bookends the message | High — "I timed it" | ~120 words |
| 2 | Week 2 | Confident, playful | Opens and closes | Medium — "literally the only thing I do" | ~60 words |
| 3 | Week 3 | Concerned, dropping the act | Opens only, no closing quip | Low — one small joke, then serious | ~70 words |
| 4 | Week 4 | Resigned, reluctant goodbye | Warning emoji replaces robot opener, robot returns at the very end | Minimal — "one last beep boop" | ~65 words |
| 5 | Photo added | Joyful, personality returns full force | Bookends with extra enthusiasm | High — back to peak robot energy | ~55 words |

The full arc: the robot's personality **dims** as urgency rises (messages 1→4), then **snaps back to full brightness** when the user adds their photo (message 5). The "happy beep boop" in #5 directly mirrors the "one last beep boop" in #4 — turning what could have been a goodbye into a reunion.
