# Licence keys: step by step

You only need this when you start selling to paying merchants (not for the pilot). It creates the **licence key**: a
pair of long codes. The **private** half stays secret on your cloud server and signs each merchant's licence. The
**public** half is built into the till installer so a till can tell a real licence from a forged one. Anyone who has
the private half can make licences for free, so it must never be shared, emailed, pasted into a chat or put in GitHub.

## 1. Make the keys (2 minutes, on your own computer)

You need Node 22 installed and this repository on your computer.

1. Open a terminal in the repository folder.
2. Pick a folder **outside** the repository, for example `C:\Users\you\plemmo-secrets` on Windows or `~/plemmo-secrets`.
3. Run:

   ```
   node scripts/generate-licence-key.cjs --out C:\Users\you\plemmo-secrets
   ```

4. It creates four files there and prints their location (it prints no key and refuses to overwrite old ones):

   | File | What it is | Where it goes |
   | --- | --- | --- |
   | `host-env.txt` | **SECRET**: the private key, its id (`k1`) and the operator token | The cloud host's secret settings only |
   | `licence-signing-key.private.pem` | **SECRET**: the same private key as a file | A password manager or an encrypted backup |
   | `release-env.txt` | Public values for a release build | GitHub secrets (step 3) |
   | `licence-signing-key.public.pem` | The public key | Safe to keep with the release notes |

5. Make **two safe copies** of the secret files (a password manager's secure notes, and an encrypted USB stick). If you
   lose the private key you cannot issue or renew licences, and every installed till would need a new build.

## 2. Put the secret half on the cloud host

Open `host-env.txt`. Each line is `NAME=value`. In your host's dashboard (for example Render: your service → Environment)
add each as a **secret environment variable**: `PLEMMO_LICENSE_SIGNING_KEY`, `PLEMMO_LICENSE_SIGNING_KEY_ID`,
`PLEMMO_CLOUD_ADMIN_TOKEN`. The operator token is the password for the operator console at `https://<your cloud>/operator`.
Also set `PLEMMO_CLOUD_DB_URL` (your database's connection string) and `PLEMMO_CLOUD_PUBLIC_URL` (your cloud's https
address); see `docs/CLOUD_HOSTING.md`. Then delete `host-env.txt` from any shared place; keep the copies from step 1.

## 3. Put the public half into the release build

In GitHub: your repository → Settings → Secrets and variables → Actions → New repository secret. Add
`PLEMMO_LICENSE_PUBLIC_KEYS` (copy the value after `=` from `release-env.txt`) and `PLEMMO_RELEASE_CLOUD_URL` (your cloud's
https address). The release workflow reads them. A release build **refuses to build** without them, so you cannot ship a
till that accepts any licence by mistake.

## 4. Check it works

1. Open `https://<your cloud>/operator`, enter the operator token.
2. Create a plan (Plans tab), then a merchant (Merchants tab). Press **Issue activation code**.
3. On a release-built till, Settings → Licence → paste the code → Activate. The till shows the plan and expiry.

## Changing the key later (rotation)

Run the script again with a new id (`--id k2`) and a **different** folder. Build a release that lists **both** public keys
in `PLEMMO_LICENSE_PUBLIC_KEYS` (`{"k1":"…","k2":"…"}`), wait until tills have updated, then switch the cloud to the new
private key and id. Details: `docs/OPERATOR_RUNBOOK.md`.
