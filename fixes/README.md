# Fixes

Sanitized before/after snippets for each finding. Secrets, environment values, the database
project URL, and the admin email address have been removed or replaced with placeholders.

| Folder | Finding | Files |
|--------|---------|-------|
| [`01-fail-closed-lead-email`](01-fail-closed-lead-email) | Lead-email endpoint failed open | `before.js`, `after.js` (runnable reduced excerpts, exercised by [`/tests`](../tests)) |
| [`02-anonymous-insert-policy`](02-anonymous-insert-policy) | Over-permissive anonymous insert rule | `before.sql`, `after.sql` |
| [`03-security-headers`](03-security-headers) | Missing clickjacking / hardening headers | `before.vercel.json`, `after.vercel.json` |
| [`04-dependency-advisories`](04-dependency-advisories) | Vulnerable build-tool dependencies | `README.md` (version table) |

To see the core fix for finding 1:

```bash
diff fixes/01-fail-closed-lead-email/before.js fixes/01-fail-closed-lead-email/after.js
```
