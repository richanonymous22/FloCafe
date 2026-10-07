# Pilot guide: trying the till on a real PC, then with one merchant

A **pilot version** is a Windows installer for you and one trusted tester. It needs **no cloud, no licence key and no
certificate**. It works fully on its own, takes sales, prints, makes reports and backups, and has a **simulated card
terminal** so card payments can be tried without a real provider. It says **PILOT VERSION** in the corner of the screen
and under Settings → Licence. Never give a pilot version to a paying merchant.

## 1. Get the installer (about 15 minutes, no coding)

1. Open the repository on GitHub, then **Actions**.
2. Choose **Pilot Windows installer** in the list on the left, then **Run workflow** (green button), then **Run workflow** again.
3. Wait for the run to finish (about 10 to 15 minutes). Open the run and download **pilot-windows-installer** from
   "Artifacts" at the bottom. Unzip it. Inside is a file like `Plemmo EPOS Setup 3.1.0.exe`.

(You can also build it on a Windows PC with Node 22: `npm ci` then `npm run pilot:win`; the installer is in `release/`.)

## 2. Install it

1. Double-click the `.exe`. Windows will say **"Windows protected your PC"** because the installer is not signed (a
   certificate costs money and is only needed for public release). Click **More info**, then **Run anyway**.
2. Follow the installer (it can add a desktop shortcut). Start the till.
3. On first run create the owner account (email and password). Then set up the business in Settings: name, address, VAT
   number if registered, receipt message.
   If you see a **sign-in** screen instead, the till already holds an owner account (for example from an earlier
   install). Click **First time on this till? Set it up** to check. To start from nothing: uninstall, delete the folder
   `%APPDATA%\plemmo-epos` (on some builds `%APPDATA%\Plemmo EPOS`) (type that into the File Explorer address bar), then install again. This erases that till's data. Add a few items (or Items & stock → Items file → import a CSV).

## 3. Try everything (30 to 45 minutes)

Tick these off on your own PC first. Write down anything surprising; screenshots help.

- [ ] Sell something for cash, give change, see the receipt. Print it if a printer is connected (Settings → Devices).
- [ ] Settings → Card payments → choose **Simulated terminal**. Take a card payment; it approves after a moment. An amount
      ending **.05** is declined, **.06** never answers (cancel it), **.07** says the terminal is offline. A card payment
      with a tip works. Record a card by hand too (the button under the card pane): it is labelled unconfirmed.
- [ ] Split a bill between cash and card. Refund part of a sale (Orders). Void an unpaid order.
- [ ] Items & stock → Offers → create "3 for 2" on one item. Add three to the cart: the saving shows. Charge it.
- [ ] Add a team member (Team → Add a team member): a cashier, and a supervisor with a PIN. Sign in as the cashier on
      another browser or after signing out; try a refund (it asks for a manager or supervisor PIN).
- [ ] Open the cash drawer with a float, take cash, pay in and out, close it with a count, then run the **Z report**
      (Reports → End of day). Check the totals against what you did.
- [ ] Items & stock → Stock value and a Stocktake. Settings → Data → download a backup.
- [ ] Close the till and reopen it: everything is still there.

## 4. Giving it to one merchant

Do this only after step 3 went well.

1. Tell them plainly: this is a **test version**, card payments are **simulated** (no real card is charged, they must
   keep using their own card machine), and they should keep doing what they do today alongside it for the first days.
2. Install it for them (or screen-share). Set up their business, items and staff together. If they use a printer or
   barcode scanner, set those up and note the make and model: `docs/HARDWARE_TEST_MATRIX.md` is the sheet to fill in.
3. After the first day compare the till's **Z report** with their own takings. Any difference is the thing to chase.
4. Ask them each day: what was slow, what was confusing, what did you do on paper instead? Keep a list.
5. Backups: Settings → Data → download a backup at the end of each day to a USB stick, for the first week.

## 5. Where their data lives, and updating

The data is a single database file on that PC (Windows: `%APPDATA%` in a folder named after the product). Back it up
with the Backup button, not by copying files while the till is running. Installing a newer pilot installer over the old
one keeps the data (the till backs the database up before upgrading it). Uninstalling does not delete the data.

## 6. Before real merchants

A pilot version is not the product you sell. Before paying merchants: a real card provider, a code-signing certificate
(or accept the SmartScreen prompt and tell customers to expect it), the cloud and licence keys (`docs/LICENCE_KEYS.md`,
`docs/CLOUD_HOSTING.md`), and the checks in `docs/HANDOFF.md`.
