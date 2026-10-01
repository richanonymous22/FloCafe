# Operator runbook — merchants, plans and licences

All calls go to the cloud service's operator API with `Authorization: Bearer $PLEMMO_CLOUD_ADMIN_TOKEN`
(unset token = the whole surface is closed). Examples use `$CLOUD` for the cloud base URL. Every change is
written to the sync log (`plan_saved`, `merchant_created`, `merchant_suspend`, …).

Licences are always derived from a **plan**; you never hand-edit limits for one merchant except the term.

## Plans (data, not code)
```sh
curl -X PUT $CLOUD/admin/v1/plans/retail-starter -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name":"Retail Starter","features":["core.pos","retail.catalog","retail.inventory"],"device_limit":2,"location_limit":1,"grace_days":14,"term_days":365}'
curl $CLOUD/admin/v1/plans -H "Authorization: Bearer $T"
```
`is_active:false` retires a plan: it can no longer be sold or switched to; existing merchants keep it.
Feature keys are the ones the till checks (`core.pos`, `retail.*`, `hospitality.*`, `advanced.multi_location`).

## New merchant
```sh
curl -X POST $CLOUD/admin/v1/merchants -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name":"Corner Shop","contact_email":"owner@example.com","plan_id":"retail-starter"}'   # optional "term_days":30 for a trial
```
Returns the **merchant code** (`MRC-XXXX-XXXX`, safe to read over the phone: two check characters catch typos;
case, spaces and O/0, I/L/1 mix-ups are tolerated) and its organisation id, with the licence already issued.

## Activate a terminal
```sh
curl -X POST $CLOUD/admin/v1/merchants/MRC-XXXX-XXXX/activation-tokens -H "Authorization: Bearer $T" -d '{}'
```
The response carries an **`activation_code`** (`<cloud address>~<token>`, when the cloud knows its public address via `PLEMMO_CLOUD_PUBLIC_URL`): that single string is what the merchant types on the till (Settings → Licence & cloud, or the activation screen). The token is shown once, is single-use and expires in 24 h (`ttl_seconds` to change). The merchant enters it on
the terminal's "Activate this device" screen. Enrolment is refused — without using up the token — when the
licence is suspended or revoked, or the plan's device limit is reached.

## Day-to-day
| Need | Call |
| --- | --- |
| Find a merchant | `GET /admin/v1/merchants?q=corner` (name, code or email) · `GET /admin/v1/merchants/MRC-…` (adds licence and device health) |
| Rename / contact / notes | `PUT /admin/v1/merchants/MRC-…` |
| Suspend (unpaid, dispute) | `POST …/suspend {"reason":"…"}` → licence `suspended`; tills show the blocked screen once they next verify |
| Reactivate | `POST …/reactivate` (suspended only) |
| Renew | `POST …/renew {"term_days":365}` → extends from the later of today and the current expiry; a lapsed licence becomes active |
| Change plan | `POST …/plan {"plan_id":"pro"}` → limits and features re-derived; status and expiry carry over |
| Replace a terminal | revoke the old device, issue a new activation token (the freed slot counts again) |
| Close for good | `POST …/close` → licence `revoked`; final: cannot be reactivated, re-planned or enrolled |

## What a terminal sees
A terminal fetches its licence signed with the cloud's licence key and verifies it against the public key
pinned in the app; an unverifiable licence is ignored in favour of the cached one, and the cached one keeps the
shop trading through the plan's grace days after expiry. Suspension and revocation take effect at the next
successful check (so a shop that is offline keeps trading until it reconnects and the grace period ends).

## Release builds: the licence policy and signing keys
A release build ships `license-policy.json` next to the app (never in the source tree):
```json
{ "requireActivation": true, "publicKeys": { "k1": "-----BEGIN PUBLIC KEY-----…" }, "cloudUrl": "https://…" }
```
`requireActivation` makes an unactivated till refuse to take sales. `publicKeys` pins the licence-signing keys
the build trusts; the cloud signs with `PLEMMO_LICENSE_SIGNING_KEY` and names it with
`PLEMMO_LICENSE_SIGNING_KEY_ID` (default `k1`). **Rotating a key:** release a build that pins both the old and
the new public key, wait until tills have updated, then switch the cloud to the new private key and id. A licence
signed by an unpinned key is refused and the till keeps its last good licence. The private key lives only in the
cloud's secret store, never in a browser or a repository.

A device removed from the account (revoked in the cloud) keeps trading until it next checks its licence while
online, then pauses sales; its records stay viewable.
