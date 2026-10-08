# Security Review: guazviolin.com

An OWASP-based security review of [guazviolin.com](https://guazviolin.com), a live booking site
for my violin performance business. The site takes event inquiries from the public, stores them
in a database, emails me a notification, and gives me a private admin CRM to manage leads.

**Result:** 4 findings (2 Medium, 2 Low). All fixed, verified, and deployed in October 2026.

| | |
|---|---|
| **Stack** | React + Vite (frontend), Vercel serverless functions (API), Supabase / Postgres with Row Level Security (database + auth), Resend (email) |
| **Reviewer** | Joshua Guaz (site owner and developer) |
| **Method** | Manual code and configuration review, mapped to the [OWASP Top 10 (2025)](https://owasp.org/Top10/) |
| **AI use** | AI-assisted (Claude). Every finding was reproduced, fixed, and verified by me |

---

## Findings at a glance

| # | Finding | OWASP | Severity | Status |
|---|---------|-------|----------|--------|
| 1 | Lead-email endpoint **failed open** and relayed request content into my inbox | A10 Mishandling of Exceptional Conditions | Medium | Fixed |
| 2 | Anonymous **database insert rule allowed any values** (`with check (true)`) | A01 Broken Access Control | Medium | Fixed |
| 3 | Missing **clickjacking** and browser-hardening headers | A02 Security Misconfiguration | Low | Fixed |
| 4 | 3 high-severity **npm advisories** in build tools | A03 Software Supply Chain Failures | Low | Fixed |

---

## Scope

**In scope**
- Public pages and the booking/inquiry form
- `POST /jgv`: serverless function that emails me when a new inquiry arrives
- Supabase schema and Row Level Security (RLS) policies for the `booking_leads` table
- Admin CRM authentication (Supabase Auth)
- Vercel configuration (rewrites, response headers)
- npm dependencies, the shipped JavaScript bundle, and the full git history

**Out of scope:** Supabase, Vercel, and Resend platform infrastructure; denial-of-service testing; social engineering.

## Methodology

I walked each OWASP Top 10 category against the code and configuration. For each one I asked:
*what can an anonymous visitor reach, and what happens when a dependency fails?*

| OWASP 2025 category | What I checked | Result |
|---|---|---|
| A01 Broken Access Control | RLS policies for anonymous vs. admin read/insert/update | **Finding 2**; anonymous reads correctly blocked |
| A02 Security Misconfiguration | Response headers, Vercel config, Supabase auth settings | **Finding 3**; public sign-up disabled |
| A03 Software Supply Chain Failures | `npm audit`, lockfile | **Finding 4** |
| A04 Cryptographic Failures | Which keys ship to the browser; secrets in git history | Pass: only the publishable key is in the bundle, no secrets in any commit |
| A05 Injection | Output encoding in React and in HTML emails | Pass: React escapes by default, email templates use `escapeHtml`, no `dangerouslySetInnerHTML` |
| A07 Authentication Failures | Who can sign in to the admin CRM | Pass: sign-up off, admin access gated on a single account |
| A10 Mishandling of Exceptional Conditions | Behavior of the email endpoint when the database lookup fails | **Finding 1** |

---

## Finding 1: Lead-email endpoint failed open (Medium)

**What happened.** When someone submits the booking form, the browser saves the lead to the
database and then calls `POST /jgv` to email me. To stop abuse, the endpoint looks up the lead
ID in the database and builds the email from the *stored* copy. But if that lookup failed (missing
or invalid service key, database unreachable), the code **fell through and emailed whatever the
request body contained.**

**Impact.** Anyone could send a POST with arbitrary text and links and have it delivered to my
inbox through my own trusted notification pipeline. That's an open relay for phishing content
aimed at me, and a way to burn my email-provider quota. It required no authentication.

**Root cause.** The verification step had three outcomes (`found`, `missing`, `unverified`), but
only `missing` was treated as a rejection. `unverified` was handled like "close enough" and fell
back to untrusted input.

```js
// Before: 'unverified' falls through to the attacker-controlled body
const lead = stored.status === 'found' ? storedLead : submitted;

// After: anything other than a verified lead stops here
if (stored.status !== 'found') {
  return response.status(503).json({ error: 'Lead notification temporarily unavailable.' });
}
const lead = storedLead; // always the database copy
```

**Fix.** The endpoint now **fails closed**: if the lead can't be verified, it returns `503` and sends
nothing. The lead itself is already saved in the CRM, so no inquiry is lost. Emails are always built
from the stored row, never from the request.
[Full before/after →](fixes/01-fail-closed-lead-email)

**Verification.** Five handler test cases (in [`/tests`](tests)), plus two regression tests proving
the old code was exploitable:

| Case | Expected | Result |
|---|---|---|
| No service key configured | 503, no email | Pass |
| Invalid service key | 503, no email | Pass |
| Lead ID not in database | 404, no email | Pass |
| Real lead | 200, one email built from the stored copy (not the request) | Pass |
| Lead already notified | 200, no duplicate email | Pass |
| *Regression:* old code, no key | Relays attacker content | Confirmed vulnerable |
| *Regression:* old code, invalid key | Relays attacker content | Confirmed vulnerable |

A live request to the deployed endpoint with a fake lead ID was also refused, and no email was sent.

## Finding 2: Anonymous insert rule allowed any values (Medium)

**What happened.** The Postgres RLS policy that lets the public booking form create leads was
`with check (true)`: any row an anonymous user sent was accepted as-is.

**Impact.** An anonymous user calling the database API directly (with the public key that every
browser has) could create leads with a fake status like "Booked", fabricated admin notes and quote
amounts, back-dated timestamps, a pre-set `notifiedAt` flag that silently suppresses my
notification email, or multi-megabyte payloads to bloat the table.

**Root cause.** The policy controlled *who* could insert but not *what* they could insert. The
form only ever sends a blank new inquiry, but the database didn't enforce that.

**Fix.** Anonymous inserts must now look exactly like a fresh form submission: status
`New inquiry`, empty admin fields, a `created_at` within ±5 minutes of now, no `notifiedAt`, and a
16 KB cap on the lead payload. The admin account gets its own separate insert policy.
[Full before/after →](fixes/02-anonymous-insert-policy)

**Verification.** Policy reviewed against every column of `booking_leads` and applied in Supabase.
Confirmed live with `select policyname, roles, with_check from pg_policies where tablename = 'booking_leads';`.

## Finding 3: Missing clickjacking protection (Low)

**What happened.** The site sent no `X-Frame-Options` or `frame-ancestors` directive, so any site
could embed it in an invisible iframe, including the admin CRM login.

**Fix.** Added security headers for every route in `vercel.json`: `X-Frame-Options: DENY`,
`Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, and a restrictive `Permissions-Policy`.
[Full before/after →](fixes/03-security-headers)

**Verification.** `curl -I https://guazviolin.com` shows all five headers in production.

## Finding 4: Vulnerable build-tool dependencies (Low)

`npm audit` flagged 3 high-severity advisories in transitive build dependencies (`nanoid`,
`postcss`, `source-map-js`). These run only at build time and aren't shipped to visitors, so
practical risk was low. Fixed with `npm audit fix` (lockfile-only change). `npm audit` now reports 0
vulnerabilities. [Version table →](fixes/04-dependency-advisories)

---

## Lessons learned

**Fail closed, not open.** A security check has to define what happens when the check itself can't
run. My code handled "lead not found" correctly but treated "couldn't check" as permission. The bug
only appeared when a key was misconfigured, which is exactly when nobody is watching. Now every
non-success outcome is a rejection, and the tests cover the failure paths, not just the happy path.

**Least privilege belongs in the database, not the UI.** The booking form only sends blank
inquiries, but the public API key lets anyone skip the form and talk to the database directly.
Row Level Security has to describe the *exact* shape of a legitimate anonymous write. Constraining
who can insert isn't enough.

**Check the boring stuff too.** Headers and dependency advisories take minutes to fix and remove
whole classes of issues.

---

## Run the tests

Requires Node.js 20+. No dependencies to install. Supabase and the email API are mocked.

```bash
npm test
```

```
✔ 1. no service key configured -> 503 and no email
✔ 2. invalid service key (database rejects it) -> 503 and no email
✔ 3. lead id not in the database -> 404 and no email
✔ 4. real lead -> 200, one email built from the STORED lead, lead marked notified
✔ 5. lead already notified -> 200 but no second email
✔ regression: BEFORE fix, no service key relays attacker content into the inbox
✔ regression: BEFORE fix, invalid service key relays attacker content into the inbox
ℹ tests 7
ℹ pass 7
```

## Repository layout

```
.
├── README.md            this report
├── fixes/               sanitized before/after code for each finding
└── tests/               runnable handler tests (Node built-in test runner, mocked fetch)
```

## A note on AI assistance

This review was AI-assisted: I used Claude to help walk the OWASP categories, read code, and draft
fixes and tests. I reproduced each finding, reviewed every change, ran the tests, and verified the
fixes in production myself. The application source code is private. The snippets here are
sanitized excerpts with business logic, secrets, and identifying data removed.

## License

MIT (code snippets and tests in this repository).
