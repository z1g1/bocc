/**
 * Message Templates for Profile Photo Enforcement
 * TipTap JSON formatted messages for Circle.so Member API
 *
 * Epic 4: Profile Photo Enforcement System
 * STORY-14: Member API DM Integration
 *
 * Story arc: A quirky self-aware robot whose personality dims as urgency rises
 * (messages 1-4), then snaps back to full brightness when photo is added (message 5).
 * Copy from docs/716-bot-final-messaging.md
 */

/**
 * Convert plain text with basic formatting to TipTap JSON
 * Supports: paragraphs, **bold**, *italic*, [links](url), line breaks
 *
 * @param {string} text - Plain text with markdown-style formatting
 * @returns {object} TipTap JSON structure
 */
const textToTipTap = (text) => {
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);

  const content = paragraphs.map(para => {
    const lines = para.split('\n');
    const lineContent = [];

    lines.forEach((line, index) => {
      if (index > 0) {
        lineContent.push({ type: 'hardBreak' });
      }

      // Parse **bold**, *italic*, and markdown links [text](url)
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
      parts.forEach(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
          // Bold text
          lineContent.push({
            type: 'text',
            marks: [{ type: 'bold' }],
            text: part.slice(2, -2)
          });
        } else if (part.startsWith('*') && part.endsWith('*')) {
          // Italic text
          lineContent.push({
            type: 'text',
            marks: [{ type: 'italic' }],
            text: part.slice(1, -1)
          });
        } else if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) {
          // Markdown link [text](url) → TipTap link mark
          const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          lineContent.push({
            type: 'text',
            marks: [{
              type: 'link',
              attrs: {
                href: match[2],
                target: '_blank'
              }
            }],
            text: match[1]
          });
        } else if (part.length > 0) {
          // Regular text
          lineContent.push({
            type: 'text',
            text: part
          });
        }
      });
    });

    return {
      type: 'paragraph',
      content: lineContent
    };
  });

  return {
    body: {
      type: 'doc',
      content: content
    }
  };
};

/**
 * Warning 1 — "The Introduction" (Week 1)
 * High humor, robot bookends, self-deprecating
 * @param {string} memberName - Member's display name
 * @returns {object} TipTap JSON message
 */
const warning1 = (memberName) => {
  const text = `🤖 *Beep boop!* Hey ${memberName},

So, fun fact — I'm a robot and even *I* have a profile photo. Just saying. 👀

We noticed your 716.social profile is still rocking the default avatar. Profile photos are a big deal around here — they help build trust and make our community feel more like, well, a community. They're also part of our [community guidelines](https://www.716.social/coc).

No rush panic — this is just **reminder 1 of 4**. But heads up: accounts without photos do eventually get temporarily deactivated. You've got **3 more reminders** before that happens.

Just pop over to your profile settings and upload any photo. It takes about 12 seconds. (I timed it. Because I'm a robot. That's what we do.)

Need help? Reach the admin team via this [form](https://forms.gle/y5itkP1Ax7TdiSQD6).

*End transmission* 📡
— 716.social Bot`;

  return textToTipTap(text);
};

/**
 * Warning 2 — "The Persistent One" (Week 2)
 * Medium humor, confident, playful
 * @param {string} memberName - Member's display name
 * @returns {object} TipTap JSON message
 */
const warning2 = (memberName) => {
  const text = `🤖 ${memberName}! Round 2.

My job is to remind you about your missing profile photo, and I am *very* good at my job. (It's literally the only thing I do.)

**Reminder 2 of 4** — **2 left** before temporary deactivation per our [community guidelines](https://www.716.social/coc).

Go to **profile settings**, upload a photo, and I'll stop bugging you. Deal?

Help available via [this form](https://forms.gle/y5itkP1Ax7TdiSQD6).

— 716.social Bot 🤖`;

  return textToTipTap(text);
};

/**
 * Warning 3 — "The Serious One" (Week 3)
 * Low humor, dropping the act, concerned
 * @param {string} memberName - Member's display name
 * @returns {object} TipTap JSON message
 */
const warning3 = (memberName) => {
  const text = `🤖 ${memberName} — this is getting real.

**Reminder 3 of 4.** Your account will be temporarily deactivated if a profile photo isn't added before the next check.

I don't want to see you go! (Well, technically I can't *see* anything, but you get the idea.)

**Please add a photo now:** profile settings → upload → done.

Per our [community guidelines](https://www.716.social/coc), all members need a profile photo.

[Contact admins if you need help](https://forms.gle/y5itkP1Ax7TdiSQD6).

— 716.social Bot`;

  return textToTipTap(text);
};

/**
 * Final Warning — "The Goodbye" (Week 4)
 * Minimal humor, reluctant farewell
 * @param {string} memberName - Member's display name
 * @param {string} nextCheckDate - Date of next automated check
 * @returns {object} TipTap JSON message
 */
const finalWarning = (memberName, nextCheckDate) => {
  const text = `🚨 ${memberName} — final warning from the bot.

I've sent 3 reminders and time's up. Without a profile photo by **${nextCheckDate}**, your account will be temporarily deactivated per our [community guidelines](https://www.716.social/coc).

**Profile settings → upload a photo.** That's all it takes.

If you do get deactivated, reach out via this [form](https://forms.gle/y5itkP1Ax7TdiSQD6) — add a photo and you'll be back in.

*One last beep boop.* 🤖
— 716.social Bot`;

  return textToTipTap(text);
};

/**
 * Thank You — "The Celebration" (Triggered when photo is added)
 * Full brightness return, joyful, peak robot energy
 * @param {string} memberName - Member's display name
 * @returns {object} TipTap JSON message
 */
const thankYouMessage = (memberName) => {
  const text = `🤖 *BEEP BOOP BEEP BOOP!!* 🎉

${memberName}!! You did it! My sensors are detecting a profile photo and I am — if a robot can be — *thrilled.*

You look great. (Okay fine, I can't actually judge that. But my photo-detection algorithm is giving you two thumbs up. 👍👍)

Thanks for being part of the 716.social community — now everyone can put a face to the name!

*Happy beep boop.* 🤖
— 716.social Bot`;

  return textToTipTap(text);
};

/**
 * Admin Alert (Final Warnings & Deactivations)
 * System-generated notification for admin oversight
 *
 * @param {string} action - Type of action (FINAL_WARNING | DEACTIVATION | ERROR)
 * @param {string} memberName - Member's full name
 * @param {string} memberEmail - Member's email address
 * @param {number} warningCount - Current warning count
 * @param {string} memberId - Circle member ID
 * @param {string} additionalContext - Additional context or error details
 * @returns {object} TipTap JSON message
 */
const adminAlert = (action, memberName, memberEmail, warningCount, memberId, additionalContext = '') => {
  const timestamp = new Date().toISOString();
  const profileUrl = `https://www.716.social/u/${memberId}`;

  const text = `**[716.social Bot] Profile Photo Enforcement Alert**

**Action:** ${action}
**Member:** ${memberName} (${memberEmail})
**Warning Count:** ${warningCount}
**Circle Profile:** ${profileUrl}

${additionalContext}

---
Automated enforcement run: ${timestamp}`;

  return textToTipTap(text);
};

/**
 * Get warning message based on warning level
 * Convenience function for enforcement logic
 *
 * @param {string} memberName - Member's display name
 * @param {number} warningLevel - Warning level (1-4)
 * @param {string} nextCheckDate - Date of next enforcement run (for level 4)
 * @returns {object} TipTap JSON message
 */
const getWarningMessage = (memberName, warningLevel, nextCheckDate = 'next Monday') => {
  switch (warningLevel) {
    case 1:
      return warning1(memberName);
    case 2:
      return warning2(memberName);
    case 3:
      return warning3(memberName);
    case 4:
      return finalWarning(memberName, nextCheckDate);
    default:
      throw new Error(`Invalid warning level: ${warningLevel}. Must be 1-4`);
  }
};

module.exports = {
  textToTipTap,
  warning1,
  warning2,
  warning3,
  finalWarning,
  thankYouMessage,
  adminAlert,
  getWarningMessage
};
