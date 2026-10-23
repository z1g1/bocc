// Render grid.html at exactly 3240x3240 and slice into nine 1080x1080 tiles.
// Tiles are numbered in Instagram POSTING order (post 1 first), so that once all
// nine are up the profile shows the composite top-left to bottom-right.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 3240, height: 3240 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve('grid.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'out/bocc-instagram-grid-composite.png', fullPage: false });
  await browser.close();
})();
