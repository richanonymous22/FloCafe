# Releasing

## What a release build needs

The source tree deliberately carries no commercial secrets or policy. A release build adds them:

| Setting | Where it comes from | Why |
| --- | --- | --- |
| `PLEMMO_RELEASE_CLOUD_URL` | repository variable | the https address tills connect to; activation codes may omit it |
| `PLEMMO_LICENSE_PUBLIC_KEYS` | repository variable (public keys are not secret) | `{"k1":"-----BEGIN PUBLIC KEY-----…"}`: the licence-signing keys this build trusts. Pin old **and** new while rotating |
| `PLEMMO_RELEASE_UPDATE_URL` | optional variable | an https generic update feed; otherwise updates come from the GitHub releases named in `build.publish` |
| code-signing certificate | secrets (`WINDOWS_CERTS`, `MAC_CERTS`, …) | without one Windows shows "unknown publisher" |

`node scripts/prepare-release.cjs --platform win|mac|linux|appx|mas` checks all of it and writes
`build-release/license-policy.json` (activation required + the pinned keys + the cloud address), which
electron-builder ships next to the app. It **refuses to continue** if the cloud address is missing or not https,
no licence key is pinned, a key is unreadable, not Ed25519, or a *private* key, or an AppX / macOS build still
carries the upstream project's Store or Apple identity. The `release:*` scripts and the release workflow run it
first. `tests/release-policy.test.ts` covers every refusal.

A build without that file is a development build: it does not insist on activation and trusts no pinned key.

## Updates on the till

Updates download in the background and are installed only when it is safe (`main/services/update-manager.ts`):

* **Never mid-sale.** A payment being taken or taken in the last two minutes, or an order opened or changed in
  the last ten minutes and not finished, blocks installing. The till says why (Settings → Updates).
* **Never without a safety copy.** The database is backed up and the copy checked (`PRAGMA integrity_check`)
  before the restart.
* **Always on the record.** Each install is in the update history and the audit log. On the next start the new
  version checks the database (integrity and foreign keys) and marks the entry *Done* or *Failed*.
* **Modes** (owner): *Ask me* (default — nothing installs until someone presses Install), *Install in quiet
  hours* (default window 03:00–05:00 in the shop's time zone, each till waits a different 0–44 minutes so a shop's
  tills never restart together, and only when **nothing** is open), *Only when I check*. "Remind me later" pauses
  prompts and automatic installs for an hour, four hours or a day.
* Store builds (Microsoft Store, Mac App Store) are updated by the store; Linux deb/rpm/snap by their package
  managers; only Windows NSIS, macOS and AppImage self-update.

### Rolling back
Every install keeps the backup taken just before it (named in the update history). To go back: reinstall the
previous version's installer, then restore that backup with the database tools (Settings → Data). Anything sold
since the update is not in the backup, so roll back only when the new version is unusable; tills that were
synced have those sales in the cloud.

## Staged rollout
Release to one pilot till first (Install in quiet hours **off**), watch Settings → Updates history show *Done*,
then publish the release for the rest. The cloud can hold back old clients with `PLEMMO_MIN_CLIENT_PROTOCOL`
only after a release is out (see `docs/CLOUD_HOSTING.md`).

## Before tagging
`npm test`, `npm run test:meridian`, a changelog entry for the version, `package.json` version = tag (the
workflow checks this), and `node scripts/prepare-release.cjs --platform <p> --check` with the real variables.
