# Brand

`brand.json` is the single place the product's name and links are defined. Everything a merchant can see —
window and tray titles, the sign-in and setup screens, receipts' "powered by" line, backup folder names,
support messages — reads it through `main/brand.ts` (and, in the browser, `GET /api/brand`).

To rebrand: edit this file (or set `PLEMMO_BRAND_NAME`, `PLEMMO_BRAND_SHORT_NAME`, `PLEMMO_BRAND_COMPANY`,
`PLEMMO_BRAND_POWERED_BY`, `PLEMMO_BRAND_SUPPORT_EMAIL`, `PLEMMO_BRAND_WEBSITE_URL`, `PLEMMO_BRAND_TERMS_URL`,
`PLEMMO_BRAND_PRIVACY_URL` in the environment). An empty URL hides that link; it is never replaced by a
default pointing somewhere else. No domain is built into the application: the cloud address comes from
`PLEMMO_CLOUD_URL` and nothing else.

Not driven from here (build-time): the installer's product name, app id and icons in `package.json` /
`assets/` — change those with the installer config when the final name is chosen.
