/**
 * Controller Settings UI — Playwright visual test
 *
 * Tests the Controller Settings modal in three contexts:
 *   1. Pre-game lobby overlay (no gamepad)
 *   2. Pre-game lobby overlay (with simulated gamepad)
 *   3. In-game toolbar button existence
 *
 * Usage: node tests/cs-visual-test.mjs
 * Requires: npm install playwright (or use /tmp/pw-runner/node_modules)
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE_URL || 'https://localhost:27888';
const OUT = path.resolve('tests/cs-screenshots');

const VIEWPORT = { width: 1280, height: 800 };

// Virtual gamepad init script — injected before page load
const GAMEPAD_INIT_SCRIPT = `
  const virtualGamepad = {
    id: 'Virtual Gamepad (STANDARD GAMEPAD Vendor: 045e Product: 028e)',
    index: 0,
    connected: true,
    timestamp: performance.now(),
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({length: 17}, () => ({pressed: false, touched: false, value: 0})),
    hapticActuators: [],
    vibrationActuator: null,
  };

  // Override navigator.getGamepads
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => [virtualGamepad, null, null, null],
    writable: true,
    configurable: true,
  });

  // Fire gamepadconnected event after a short delay (so scripts are loaded)
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad: virtualGamepad }));
    }, 500);
  });
`;

const run = async () => {
  // Clean and create output dir
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let screenshotNum = 0;

  const screenshot = async (page, name) => {
    screenshotNum++;
    const num = String(screenshotNum).padStart(2, '0');
    const filename = `${num}-${name}.png`;
    const filepath = path.join(OUT, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`  [screenshot] ${filename}`);
    return filepath;
  };

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: Pre-game lobby — no gamepad
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 1: Pre-game lobby (no gamepad) ===');

  {
    const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // Step 1: Navigate to homepage
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await screenshot(page, 'homepage');
    console.log('  Homepage loaded');

    // Step 2: Enter player name and create room
    await page.fill('#player-name', 'TestPlayer');
    await page.click('#create-btn');

    // Step 3: Wait for play page to load (URL should contain ?room=)
    await page.waitForURL(/room=/, { timeout: 10000 });
    console.log(`  Play page loaded: ${page.url()}`);

    // Wait for overlay to become visible
    await page.waitForSelector('#overlay:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(1000); // Let animations settle
    await screenshot(page, 'pregame-overlay');
    console.log('  Pre-game overlay visible');

    // Step 4: Verify Controller Settings button exists
    const settingsBtn = page.locator('#overlay-settings-btn');
    await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  Controller Settings button found');

    // Step 5: Click the Controller Settings button
    await settingsBtn.click();
    await page.waitForTimeout(500); // Transition animation

    // Verify the panel opened
    const panel = page.locator('#controller-settings.open');
    await panel.waitFor({ state: 'visible', timeout: 3000 });
    const backdrop = page.locator('#cs-backdrop.visible');
    await backdrop.waitFor({ state: 'visible', timeout: 3000 });
    await screenshot(page, 'settings-modal-open');
    console.log('  Controller Settings modal opened');

    // Step 6: Close via Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Verify closed
    const panelClosed = await page.locator('#controller-settings.open').count();
    console.log(`  Modal closed: ${panelClosed === 0 ? 'YES' : 'NO'}`);
    await screenshot(page, 'settings-modal-closed');

    await ctx.close();
  }

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: Pre-game lobby — with simulated gamepad
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 2: Pre-game lobby (simulated gamepad) ===');

  {
    const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // Inject virtual gamepad BEFORE navigation
    await page.addInitScript(GAMEPAD_INIT_SCRIPT);

    // Navigate to homepage
    await page.goto(BASE, { waitUntil: 'networkidle' });

    // Create room
    await page.fill('#player-name', 'GamepadTest');
    await page.click('#create-btn');
    await page.waitForURL(/room=/, { timeout: 10000 });
    console.log(`  Play page loaded: ${page.url()}`);

    // Wait for overlay
    await page.waitForSelector('#overlay:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(1500); // Wait for gamepad detection

    // Screenshot the gamepad area
    await screenshot(page, 'gamepad-pregame-overlay');

    // Check gamepad status text
    const gamepadStatus = await page.locator('#gamepad-status').textContent();
    console.log(`  Gamepad status: "${gamepadStatus}"`);

    // Click Controller Settings
    const settingsBtn = page.locator('#overlay-settings-btn');
    await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
    await settingsBtn.click();
    await page.waitForTimeout(500);

    // Verify modal open
    const panel = page.locator('#controller-settings.open');
    await panel.waitFor({ state: 'visible', timeout: 3000 });

    // Full modal screenshot
    await screenshot(page, 'gamepad-settings-modal-full');
    console.log('  Full modal screenshot taken');

    // Check visual elements exist
    const checks = {
      'Panel open': (await page.locator('#controller-settings.open').count()) > 0,
      'Backdrop visible': (await page.locator('#cs-backdrop.visible').count()) > 0,
      'Button mapping grid': (await page.locator('.cs-map-grid').count()) > 0,
      'Stick viz (Left)': (await page.locator('.cs-viz-wrap').count()) > 0,
      'Range slider': (await page.locator('#controller-settings input[type="range"]').count()) > 0,
      'Section labels': (await page.locator('.cs-section-label').count()) > 0,
      'Done button': (await page.locator('.cs-quick-btn >> text=Done').count()) > 0,
      'Close button (x)': (await page.locator('.cs-close').count()) > 0,
      'Title text': (await page.locator('.cs-title').textContent()) === 'Controller Settings',
      'Footer with reset': (await page.locator('.cs-footer-reset').count()) > 0,
    };

    console.log('\n  Visual element checks:');
    for (const [name, result] of Object.entries(checks)) {
      console.log(`    ${result ? 'PASS' : 'FAIL'} ${name}`);
    }

    // Check centering — modal should be roughly in the center
    const panelBox = await page.locator('#controller-settings').boundingBox();
    if (panelBox) {
      const centerX = panelBox.x + panelBox.width / 2;
      const centerY = panelBox.y + panelBox.height / 2;
      const viewCenterX = VIEWPORT.width / 2;
      const viewCenterY = VIEWPORT.height / 2;
      const driftX = Math.abs(centerX - viewCenterX);
      const driftY = Math.abs(centerY - viewCenterY);
      console.log(`\n  Centering check:`);
      console.log(`    Panel center: (${Math.round(centerX)}, ${Math.round(centerY)})`);
      console.log(`    Viewport center: (${viewCenterX}, ${viewCenterY})`);
      console.log(`    Drift: X=${Math.round(driftX)}px, Y=${Math.round(driftY)}px`);
      console.log(`    ${driftX < 20 && driftY < 60 ? 'PASS' : 'WARN'} Centering (X<20px, Y<60px)`);
    }

    // Scroll down to capture the bottom sections
    await page.locator('#controller-settings').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    await screenshot(page, 'gamepad-settings-modal-scrolled');
    console.log('  Scrolled modal screenshot taken');

    // Close via JS call (overlay can intercept pointer events on the Done button)
    await page.evaluate(() => window.ControllerSettings.close());
    await page.waitForTimeout(400);
    const stillOpen = await page.locator('#controller-settings.open').count();
    console.log(`  Closed via ControllerSettings.close(): ${stillOpen === 0 ? 'YES' : 'NO'}`);
    await screenshot(page, 'gamepad-settings-modal-done-closed');

    await ctx.close();
  }

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: In-game toolbar button existence
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 3: In-game toolbar button ===');

  {
    const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // Navigate directly to play page
    await page.goto(`${BASE}/play.html?room=TOOLBARTEST&host=1&name=ToolbarCheck`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(2000);

    // Check that the toolbar settings button exists in the DOM
    const toolbarSettingsBtn = page.locator('#toolbar-settings');
    const exists = (await toolbarSettingsBtn.count()) > 0;
    const text = exists ? await toolbarSettingsBtn.textContent() : '';
    console.log(`  #toolbar-settings exists: ${exists}`);
    console.log(`  #toolbar-settings text: "${text}"`);

    // Also verify the more dropdown structure
    const moreDropdown = page.locator('#more-dropdown');
    const moreExists = (await moreDropdown.count()) > 0;
    console.log(`  #more-dropdown exists: ${moreExists}`);

    // The toolbar is hidden (class "hidden") during pre-game, but we can still verify structure
    const toolbarHidden = await page.locator('#toolbar.hidden').count();
    console.log(`  Toolbar hidden (pre-game): ${toolbarHidden > 0 ? 'YES (expected)' : 'NO'}`);

    // Verify the toolbar-more button
    const moreBtn = page.locator('#toolbar-more');
    const moreBtnExists = (await moreBtn.count()) > 0;
    console.log(`  #toolbar-more button exists: ${moreBtnExists}`);

    // Make toolbar visible and hide overlay so it doesn't intercept pointer events
    await page.evaluate(() => {
      document.getElementById('toolbar')?.classList.remove('hidden');
      document.getElementById('overlay')?.classList.add('hidden');
    });
    await page.waitForTimeout(200);
    await screenshot(page, 'toolbar-visible');

    // Open the more dropdown
    await page.click('#toolbar-more');
    await page.waitForTimeout(300);
    await screenshot(page, 'toolbar-more-dropdown-open');
    console.log('  More dropdown opened for screenshot');

    // Verify Controller Settings is in the dropdown
    const settingsInDropdown = page.locator('#toolbar-settings');
    const settingsVisible = await settingsInDropdown.isVisible();
    console.log(`  Controller Settings in dropdown: ${settingsVisible ? 'YES' : 'NO'}`);

    await ctx.close();
  }

  await browser.close();

  console.log(`\n=== All tests complete ===`);
  console.log(`Screenshots saved to: ${OUT}/`);
  console.log(`Total screenshots: ${screenshotNum}`);
};

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
