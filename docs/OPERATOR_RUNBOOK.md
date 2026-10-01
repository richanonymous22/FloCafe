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
The token is shown once, is single-use and expires in 24 h (`ttl_seconds` to change). The merchant enters it on
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
