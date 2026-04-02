# Message Templates for Epic 4: Profile Photo Enforcement

> **SUPERSEDED**: This was the original planning document with placeholder copy. The final production messages are defined in [`docs/716-bot-final-messaging.md`](716-bot-final-messaging.md) and implemented in `netlify/functions/utils/message-templates.js`.
>
> Key changes from this spec:
> - Messages now use a character-driven "716.social Bot" story arc (not generic corporate copy)
> - Each warning level (1-4) has unique personality and copy
> - **No deactivation DM** — after message 4 the account is simply deactivated
> - Thank-you message is a celebratory robot personality return
> - TipTap parser supports **bold**, *italic*, and [links](url)

This document defines the message templates required for the profile photo enforcement system.

## Overview

The enforcement system requires **4 member-facing message templates** plus admin alerts to communicate throughout the enforcement lifecycle. (Originally 5 — the deactivation notice DM was removed.)

## Template Requirements

### Delivery Method

**⚠️ PENDING DECISION**: Implementation approach for member notifications

- **Option A**: In-app DMs via Circle.so Member API (Headless) - requires Headless Auth token
- **Option B**: Email notifications via SendGrid or similar service
- **Option C**: Hybrid approach (emails for MVP, migrate to DMs later)

**Admin notifications**: TBD based on member notification approach

---

## 1. Standard Warning (Warnings 1-3)

**Purpose**: Inform member they need to add a profile photo, friendly but clear tone

**Recipient**: Member without profile photo (warnings 1, 2, or 3)

**Sender**: 716.social Bot (https://www.716.social/u/73e5a590)

**Variables**:
- `{member_name}` - Member's first name or display name
- `{warning_number}` - Current warning number (1, 2, or 3)
- `{warnings_remaining}` - Warnings remaining before final warning (4, 3, or 2)

**Placeholder Template**:
```
[PLACEHOLDER - User needs to provide copy]

Suggested structure:
- Greeting with member name
- Explain profile photo policy
- Encourage adding a photo
- Mention current warning number
- State how many warnings remain
- Link to help docs or instructions
- Friendly, helpful tone
```

**Example Structure** (for user to customize):
```
Hi {member_name},

We noticed you haven't added a profile photo to your 716.social account yet. Profile photos help build community trust and make our space more welcoming for everyone.

This is reminder #{warning_number} out of 4 before we need to temporarily deactivate accounts without photos. You have {warnings_remaining} more reminders before a final warning.

Adding a photo is easy: just go to your profile settings and upload an image that represents you.

Thanks for being part of our community!
— The 716.social Team
```

---

## 2. Final Warning (Warning 4)

**Purpose**: Urgent notice that account will be deactivated on next enforcement run if no photo added

**Recipient**: Member without profile photo (4th warning)

**Sender**: 716.social Bot

**Variables**:
- `{member_name}` - Member's first name or display name
- `{next_check_date}` - Date of next enforcement run (e.g., "next Monday")

**Placeholder Template**:
```
[PLACEHOLDER - User needs to provide copy]

Suggested structure:
- Greeting with member name
- CLEARLY state this is the FINAL warning
- Explain account will be deactivated after next check
- Provide exact timeline (next Monday at 9 AM)
- Give instructions for adding photo
- Explain re-invitation process if deactivated
- More urgent but still professional tone
```

**Example Structure** (for user to customize):
```
Hi {member_name},

🚨 FINAL WARNING: This is your 4th and final reminder to add a profile photo to your 716.social account.

If a profile photo is not added by {next_check_date}, your account will be temporarily deactivated per our community guidelines.

TO AVOID DEACTIVATION:
1. Go to your profile settings
2. Upload a profile photo
3. That's it!

If your account is deactivated, you can contact circle@zackglick.com to be re-invited after adding a photo.

Please act now to keep your account active.

— The 716.social Team
```

---

## 3. Deactivation Notice (Warning 5)

**Purpose**: Inform member their account is being deactivated, provide re-invitation instructions

**Recipient**: Member being deactivated (would be 5th warning)

**Sender**: 716.social Bot

**Timing**: Sent immediately before `DELETE /community_members/{id}` API call

**Variables**:
- `{member_name}` - Member's first name or display name
- `{admin_email}` - Admin contact email (circle@zackglick.com)

**Placeholder Template**:
```
[PLACEHOLDER - User needs to provide copy]

Suggested structure:
- Greeting with member name
- Clearly state account is being deactivated NOW
- Explain reason (no profile photo after 4 warnings)
- Provide re-invitation contact info
- Explain re-invitation process
- Apologetic but firm tone
```

**Example Structure** (for user to customize):
```
Hi {member_name},

Your 716.social account is being deactivated because a profile photo was not added after multiple reminders.

We're sorry to see you go, but our profile photo policy helps create a trustworthy community environment.

TO REJOIN:
1. Have a profile photo ready to upload
2. Contact us at {admin_email}
3. We'll send you a new invitation
4. Add your profile photo immediately upon rejoining

We hope to see you back in the community soon with a photo!

— The 716.social Team
```

**Note**: This message may not be deliverable if sent via in-app DM after deactivation. Consider:
- Send DM *before* DELETE API call
- Or send via email regardless of primary notification method
- Or both (DM + email as backup)

---

## 4. Thank You Message (Photo Added)

**Purpose**: Positive reinforcement when member adds profile photo, stop enforcement tracking

**Recipient**: Member who was previously in "No Profile Photo" segment but now has a photo

**Sender**: 716.social Bot

**Variables**:
- `{member_name}` - Member's first name or display name

**Placeholder Template**:
```
[PLACEHOLDER - User needs to provide copy]

Suggested structure:
- Greeting with member name
- Thank them for adding photo
- Positive reinforcement
- Encourage continued community participation
- Warm, welcoming tone
```

**Example Structure** (for user to customize):
```
Hi {member_name},

Thanks for adding your profile photo! 🎉

Your photo helps make 716.social a more welcoming and trustworthy community for everyone. We appreciate you taking the time to complete your profile.

Keep engaging, sharing, and connecting with the community!

— The 716.social Team
```

---

## 5. Admin Alert (Final Warnings & Deactivations)

**Purpose**: Notify admin of final warnings and deactivations for oversight

**Recipient**: Admin (circle@zackglick.com, Circle ID: 2d8e9215)

**Sender**: System (automated enforcement function)

**Delivery Method**: TBD based on notification implementation (DM, email, or both)

**Variables**:
- `{action}` - Type of action (FINAL_WARNING | DEACTIVATION | ERROR)
- `{member_name}` - Member's full name
- `{member_email}` - Member's email address
- `{warning_count}` - Current warning count
- `{member_id}` - Circle member ID
- `{timestamp}` - When action occurred
- `{error_details}` - (Optional) Error message if action = ERROR

**Template** (system-generated, not user-customizable):
```
Subject: [716.social Bot] Profile Photo Enforcement Alert

Action: {action}
Member: {member_name} ({member_email})
Warning Count: {warning_count}
Circle Profile: https://www.716.social/u/{member_id}

{Additional context or error details}

---
Automated enforcement run: {timestamp}
```

**Action Types**:

- **FINAL_WARNING**: Member received their 4th warning (one more before deactivation)
- **DEACTIVATION**: Member's account was deactivated after 5th check without photo
- **ERROR**: Enforcement failed for this member (API error, unexpected state, etc.)

**Additional Context Examples**:
- Final warning: "Member has until next Monday's enforcement run to add a photo."
- Deactivation: "Account deactivated via DELETE /community_members/{member_id}. Member can be re-invited manually."
- Error: "Failed to send warning DM: Circle API returned 403 Forbidden. Member skipped."

---

## Implementation Notes

### Message Formatting

**For In-App DMs (Option A - Member API)**:
- Use Circle's rich text format (TipTap JSON)
- Support basic formatting: bold, italic, links
- Example:
```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Hi " },
        { "type": "text", "marks": [{"type": "bold"}], "text": "John" },
        { "type": "text", "text": ", ..." }
      ]
    }
  ]
}
```

**For Email (Option B/C)**:
- Use HTML email templates with plain text fallback
- Include 716.social branding/logo
- Mobile-responsive design
- Clear CTA buttons ("Add Profile Photo")

### Message Storage

**Option 1**: Hard-coded in `/netlify/functions/utils/message-templates.js`
```javascript
module.exports = {
  standardWarning: (name, warningNum, remaining) => `Hi ${name}, ...`,
  finalWarning: (name, nextDate) => `Hi ${name}, 🚨 FINAL WARNING ...`,
  // etc.
}
```

**Option 2**: Stored in Airtable "Message Templates" table (more flexible, allows admin editing)

**Option 3**: Environment variables (simple but harder to manage multi-line)

**Recommended**: Option 1 (hard-coded) for MVP, migrate to Option 2 for admin self-service later

### Localization

Current scope: English only

Future enhancement: Support multiple languages based on member's profile language preference

### Testing

- Use Test Glick user (zglicka@gmail.com) as recipient for all message types
- Verify formatting renders correctly (especially for DMs with rich text)
- Test variable substitution (ensure no `undefined` or `{placeholder}` appears)
- Verify admin alerts are delivered and readable

---

## Action Items for User

Please provide customized copy for these 4 member-facing messages:

1. **Standard Warning** (Warnings 1-3)
2. **Final Warning** (Warning 4)
3. **Deactivation Notice** (Warning 5)
4. **Thank You Message** (Photo added)

Admin alerts (Message #5) will be auto-generated by the system and don't require user customization.

**When providing copy, please consider**:
- Tone: Friendly but clear enforcement expectations
- Length: Keep messages concise (under 200 words)
- Links: Include any help docs or profile settings URLs
- Branding: Use "716.social" and "716.social Bot" consistently
- Emojis: Optional, use sparingly for emphasis (e.g., 🚨 for final warning, 🎉 for thank you)

---

**Document Status**: SUPERSEDED — See `docs/716-bot-final-messaging.md` for final copy
**Last Updated**: 2026-02-13
**Epic**: EPIC-4 Profile Photo Enforcement
