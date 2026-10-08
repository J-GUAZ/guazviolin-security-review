# 04 · Vulnerable build-tool dependencies

`npm audit` reported 3 high-severity advisories in transitive build-time dependencies
(pulled in by Vite). They were fixed with `npm audit fix`, which updated `package-lock.json` only:

| Package         | Before  | After   |
|-----------------|---------|---------|
| `nanoid`        | 3.3.13  | 3.3.20  |
| `postcss`       | 8.5.15  | 8.5.29  |
| `source-map-js` | 1.2.1   | 1.2.2   |

After the update, `npm audit` reports `found 0 vulnerabilities`.

These packages only run during `vite build` and aren't shipped in the production bundle,
so the practical risk to site visitors was low. They were still fixed to keep the build
pipeline clean and the audit output meaningful.
