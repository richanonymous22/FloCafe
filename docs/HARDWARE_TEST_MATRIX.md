# Hardware test matrix

Every row is **untested** until someone runs it on the real device and writes the date, device model, firmware and
result. Do not change an entry to "verified" from a simulator or a code read-through.

Status words: `not tested`, `simulated only` (an automated test with a fake device exists), `verified on device`.

| Area | Device / model | What to try | Automated coverage | Status | Date, firmware, tester, notes |
| --- | --- | --- | --- | --- | --- |
| Receipt printer | Epson TM-T20 (network) | Print a sale receipt, £ and accented names, open the drawer, cut | fake TCP printer (`printer.test`) | simulated only | |
| Receipt printer | Epson TM-T88 (USB) | As above | none | not tested | |
| Receipt printer | Star TSP143 | As above (Star command set) | none | not tested | |
| Receipt printer | Generic 80mm ESC/POS (network) | As above, plus paper-out and cover-open errors | fake TCP printer | simulated only | |
| Pound sign £ | Each printer above | Receipt shows £, not a stray character (code page 858 vs 437) | none | not tested | |
| Cash drawer | Via printer kick port | Opens on a cash sale, a refund and a no-sale | drawer pulse bytes asserted | simulated only | |
| Barcode scanner | USB keyboard-wedge | Scan into the register, into stocktake and goods-in; wrong-code beep | jsdom scan tests | simulated only | |
| Barcode scanner | Bluetooth | As above, including reconnect after sleep | none | not tested | |
| Customer display | Pole display (serial) | Shows item and total | none | not tested | |
| Scale | Serial/USB retail scale | Weighed item price | none | not tested | |
| Card terminal | Provider TBD | Approve, decline, cancel, unplug mid-payment, refund, settlement | simulator only | not tested | |
| Tablet | iPad / Android (kiosk, KDS) | Layout, touch targets, orientation, sleep/wake | headless layout checks | simulated only | |
| Windows | Windows 10 and 11 | Install, first run, update, uninstall; SmartScreen prompt | none (no Windows machine in CI) | not tested | |
| macOS | Apple silicon | Install, first run, update | none | not tested | |
| Linux | Ubuntu 22.04 | AppImage, .deb | package build in CI | simulated only | |

## Known gaps worth a first look on real hardware

- The `£` sign on thermal printers depends on the printer's code page. The till has no per-printer code page setting
  yet; if £ prints wrongly on a model, that setting is the fix to build.
- Card provider behaviour (timeouts, duplicate taps, power loss mid-payment) can only be proven against a real
  terminal and the provider's sandbox.
