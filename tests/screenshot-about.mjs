/**
 * Playwright verification for the About modal.
 * Screenshots the About modal on both lobby and play pages,
 * on desktop and mobile viewports, including the expanded story.
 *
 * Usage: npx playwright test tests/screenshot-about.mjs
 *   or:  node tests/screenshot-about.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:27888';
const OUT = 'tests/screenshots/about';

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }, // iPhone 14
};

const run = async () => {
  const browser = await chromium.launch();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(OUT, { recursive: true });

  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();

    // ── Lobby ──────────────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });

    // Verify About link exists
    const lobbyAbout = page.locator('#kn-about');
    await lobbyAbout.waitFor({ state: 'visible', timeout: 5000 });
    console.log(`[${device}] Lobby: About link visible`);

    // Click About
    await lobbyAbout.click();
    await page.waitForSelector('#kn-about-modal', { timeout: 3000 });
    await page.screenshot({ path: `${OUT}/lobby-about-${device}.png`, fullPage: true });
    console.log(`[${device}] Lobby: About modal screenshot taken`);

    // Expand "The Story"
    const storyToggle = page.locator('#kn-about-modal >> text=The Story');
    await storyToggle.click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/lobby-about-story-${device}.png`, fullPage: true });
    console.log(`[${device}] Lobby: About modal + story screenshot taken`);

    // Close via Escape
    await page.keyboard.press('Escape');
    await page.waitForSelector('#kn-about-modal', { state: 'detached', timeout: 2000 });
    console.log(`[${device}] Lobby: About modal closed via Escape`);

    // ── Play page (pre-game overlay) ───────────────────────────────────
    await page.goto(`${BASE}/play.html?room=TEST123&name=Agent21`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // The overlay footer has the About link
    const playAbout = page.locator('#kn-about');
    // Play page may redirect if no room — just check if About exists
    const playAboutVisible = await playAbout.isVisible().catch(() => false);
    if (playAboutVisible) {
      await playAbout.click();
      await page.waitForSelector('#kn-about-modal', { timeout: 3000 });
      await page.screenshot({ path: `${OUT}/play-about-${device}.png`, fullPage: true });
      console.log(`[${device}] Play: About modal screenshot taken`);

      // Close via backdrop click
      await page.mouse.click(10, 10);
      await page.waitForSelector('#kn-about-modal', { state: 'detached', timeout: 2000 });
      console.log(`[${device}] Play: About modal closed via backdrop click`);
    } else {
      console.log(`[${device}] Play: Skipped (page redirected to lobby)`);
    }

    await ctx.close();
  }

  await browser.close();
  console.log(`\nScreenshots saved to ${OUT}/`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
