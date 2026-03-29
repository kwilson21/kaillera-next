# Virtual Gamepad Device Test

Automated visual regression test for the virtual gamepad layout across
every major phone and tablet resolution. Tests both portrait and landscape
orientations, with and without simulated browser chrome (Safari address bar,
Chrome toolbar, etc).

## What it tests

- 25 devices (iPhones, Androids, iPads, Android tablets)
- 4 variants each: landscape+browser, landscape+full, portrait+browser, portrait+full
- **100 total screenshots** per run

## How to run

```bash
# 1. Start the static file server from the web/ directory
cd web && python3 -m http.server 18888 --bind 127.0.0.1 &

# 2. Copy test page into web/ (needed for the server to serve it)
cp tests/vgp-test.html web/vgp-test.html

# 3. Run the test (requires playwright: npm install playwright)
node tests/vgp-device-test.mjs

# 4. Review results
open tests/vgp-screenshots/index.html

# 5. Clean up
rm web/vgp-test.html
kill %1  # stop the server
```

## Output

- `tests/vgp-screenshots/phone/` — all phone screenshots
- `tests/vgp-screenshots/tablet/` — all tablet screenshots
- `tests/vgp-screenshots/index.html` — visual review page with all screenshots organized by category

## What to check

1. **No button overlaps** — no two buttons should touch or overlap
2. **Game canvas not covered** — the green 4:3 rectangle should have no buttons on it
3. **Toolbar clear** — no buttons should extend below the toolbar bar
4. **C-button diamond symmetric** — should be a proper diamond, not squished
5. **D-pad cross centered** — arrows should be centered in their container
6. **Buttons scale proportionally** — smaller on small phones, larger on tablets
7. **L/Z on left, R on right** — consistent shoulder button positioning

## Browser chrome simulation

Real browser chrome heights (subtracted from device viewport):
- Safari on iPhone: 80px (address bar + tab bar + status bar)
- Chrome on Android: 56px (address bar)
- Safari on iPad: 50px (compact address bar)
- Chrome on Android tablet: 40px

The layout uses `dvh` units (dynamic viewport height) which automatically
adjust on real devices when the browser chrome appears/disappears. The test
simulates this by reducing the viewport height.

## Devices tested

### Phones
iPhone SE, 8, X, 12 Mini, 12, 12 Pro Max, 14, 14 Plus, 14 Pro Max,
15, 15 Plus, 15 Pro Max, Pixel 5, Pixel 7, Galaxy S8, S9+, S24, A55,
Moto G4

### Tablets
iPad Mini, iPad (gen 7), iPad Pro 11, Galaxy Tab S4, Galaxy Tab S9, Nexus 10
