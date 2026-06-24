# Architecture Deepening Review + Security Hardening — June 2026

Durable record of the June 2026 work: an architecture-deepening pass over the
backend (5 candidates, all landed) followed by a pre-go-live security review.
Shipped on branch `dev` via **PR #2** (`dev → main`). Test suite grew
**~299 → 329 passing** (2 integration skipped); production dependency audit:
**0 vulnerabilities**.

Architecture vocabulary (module, interface, depth, seam, adapter, leverage,
locality, deletion test) and the domain glossary live in [`CONTEXT.md`](../CONTEXT.md).

---

## Architecture candidates (all landed on `dev`)

Each was a **behaviour-preserving** refactor turning a shallow module into a deep,
testable one, with tests added. Commits are on `dev`.

| # | Candidate | Seam / module created | Commit | Notes |
|---|-----------|----------------------|--------|-------|
| 02 | Config adapter | `utils/config.js` | `08777d9` | Single validated source of env/config; **fail-fast at import**. See [ADR-0001](adr/0001-config-fail-fast-at-import.md). |
| 01 | Check-in use-case | `utils/check-in.js` (`checkInAttendee`) | `65c9563` | Handler 151→83 lines, now a thin HTTP adapter; returns a discriminated result (`invalid`/`duplicate`/`created`), throws only on unexpected infra errors. |
| 03 | Circle transport | `utils/circle-http.js` | `7b5957b` | One authed-client factory + shared `logCircleError` (replaced ~10 duplicated blocks); bot JWT memoized per process. |
| 04 | Enforcement handler factory | `makeEnforcementHandler({filterEmail})` | `8fb434c` | Manual handler 67→15 lines; manual endpoint stays hard-wired to the test user (safety affordance). |
| 05 | Per-member enforcement step | `enforceMember` / `recordOutcome` | `8fb434c` | Collapsed two duplicated loops in `runEnforcement`; both seams unit-tested. |

**Key design decisions** (grilled, see commit messages for full rationale):
- Validation lives inside the check-in use-case (handler has no business branches).
- Expected outcomes are a discriminated union; unexpected failures throw → handler `catch → 500`.
- Identities (bot/admin/test user) are env-overridable constants; safety limits (500/1000) are code-only constants.
- Error normalization into domain error classes was **declined** — only `getAllMembers` branches on an error status (kept its 401 message).

---

## Security review (pre-go-live)

| ID | Severity | OWASP | Issue | Status |
|----|----------|-------|-------|--------|
| **H2** | High (was **live on `main`**) | A01/A05 | Scheduled `profile-photo-enforcement` endpoint was **publicly invocable over HTTP and executed** (confirmed via `?dryRun=true` probe → 200 + real summary). Schedule declared in `netlify.toml`, so Netlify served it on the public path. | **Fixed** `78cd08c` — shared authorization gate (genuine Netlify scheduled invocation via unspoofable `X-NF-Event: schedule`, **or** valid `x-enforcement-token`; anonymous → 401, fail-closed). See [ADR-0002](adr/0002-enforcement-endpoint-authorization.md). |
| **H1** | High | A01/A04 | Manual enforcement endpoint unauthenticated. | **Fixed** `71fb07c` / `78cd08c` — requires `x-enforcement-token` (constant-time compare); stays test-user-only. |
| **M1** | High (deps) | A06 | Production deps `airtable→lodash`, `axios→form-data` flagged. | **Fixed** `71fb07c` — `npm audit fix` → 0 prod vulns (axios 1.13.4→1.18.1, lodash→4.18.1, form-data→4.0.6). |
| **M2** | Medium | A05 | Permissive `*` CORS on enforcement endpoints. | **Fixed** `71fb07c`/`78cd08c` — no CORS header emitted (server/cron-invoked). |
| **M3** | Medium | A05 | Enforcement handler returned `error.message`/stack to client. | **Fixed** `71fb07c` — generic client error; detail logged server-side only. |
| **L1** | Low | A04 | No server-side rate limit / spam check on public `/checkin`. | **Deferred → issue #5** |
| **L2** | Low | A09 | PII (email/phone/token) in function logs. | **Deferred → issue #6** |
| **L3** | Low | A05 | Missing `Referrer-Policy` / `Permissions-Policy` (HSTS + X-Frame + nosniff already present). | **Deferred → issue #7** |

**Verified intact** (refactor did not weaken): Airtable formula-injection escaping, server-side input validation/sanitization, secret handling (env-only, fail-fast, names-not-values in logs), check-in 500-path sanitization, no eval/SSRF, `Object.freeze` config, safety limits.

**Dev-only dependencies:** 18 moderate vulns remain in jest's transitive tree; they do **not** ship (bundled functions use prod deps only). `npm audit fix --force` would bump jest majors — deferred, not blocking.

---

## Open follow-up work (GitHub issues)

| Issue | Type | Summary |
|-------|------|---------|
| [#3](https://github.com/z1g1/bocc/issues/3) | bug | Circle check-in counter never increments past 1 (`incrementCheckinCount` always called without `currentCount`). |
| [#4](https://github.com/z1g1/bocc/issues/4) | refactor | DTO-ify `airtable.js` (stop leaking Airtable record shape) — deferred from candidate 01. |
| [#5](https://github.com/z1g1/bocc/issues/5) | security | Rate limiting + server-side spam protection on `/checkin` (L1). |
| [#6](https://github.com/z1g1/bocc/issues/6) | security | Redact PII from function logs (L2). |
| [#7](https://github.com/z1g1/bocc/issues/7) | security | Add `Referrer-Policy` / `Permissions-Policy` headers (L3). |
| [#8](https://github.com/z1g1/bocc/issues/8) | robustness | Bot JWT cache: refresh on 401 / handle expiry (from candidate 03). |
| [#9](https://github.com/z1g1/bocc/issues/9) | hardening | Move enforcement schedule to in-code config for platform-level 404 (defense-in-depth, ADR-0002). |

---

## Open operational items (require a human / Netlify — not code)

- **Incident check (pending):** during H2 verification, an earlier `curl` without `?dryRun=true` hit the live, unguarded endpoint in **production mode** and may have triggered a real enforcement run. Review the Airtable `No Photo Warnings` table, the bot's sent DMs, and the `profile-photo-enforcement` function logs for unintended warnings/DMs/deactivations.
- **Deploy prerequisites:** `ENFORCEMENT_TRIGGER_TOKEN` (set) and `ALLOWED_ORIGIN=https://716coffee.club` (already set) in Netlify.
- **Post-deploy verification:** `curl -i https://716coffee.club/.netlify/functions/profile-photo-enforcement` should return **401**; trigger the scheduled function via Netlify **"Run now"** and confirm **200** in logs (proves cron still works through the new gate).

---

## References
- PR: https://github.com/z1g1/bocc/pull/2
- [ADR-0001 — Config fail-fast at import](adr/0001-config-fail-fast-at-import.md)
- [ADR-0002 — Enforcement endpoint authorization](adr/0002-enforcement-endpoint-authorization.md)
- [`CONTEXT.md`](../CONTEXT.md) — domain & architecture glossary
