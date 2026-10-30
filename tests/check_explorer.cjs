// Optional browser smoke test; uses Playwright and a system Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 960}});
    const errors = [], remote = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => {if (/^https?:/.test(r.url())) remote.push(r.url())});
    // Load our own HTML directly; managed Chromium disables file:// navigation.
    await page.setContent(fs.readFileSync(path.join(root,'reports/SEASON_EXPLORER.html'),'utf8'),{waitUntil:'load'});
    const data = JSON.parse(await page.locator('#report-data').textContent());
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    assert.equal(await page.locator('#player option').count(),12);
    assert.match(await page.locator('#checks').textContent(), /realism gates passed/);
    const initial = await page.locator('#rankImage').getAttribute('src');
    await page.selectOption('#mode','ppr');
    assert.notEqual(await page.locator('#rankImage').getAttribute('src'),initial);
    assert.equal(await page.locator('#rankImage').getAttribute('src'),data.images.position_distributions_ppr);
    await page.selectOption('#player','11');
    const selected = data.players[11];
    assert.match(await page.locator('#profileSummary').textContent(),new RegExp(selected.id));
    assert.equal(await page.locator('#history tr').count(),selected.history.length+1);
    assert.equal(await page.locator('#alternatives tr').count(),4);
    assert.match(await page.locator('#alternatives tr').nth(1).textContent(),new RegExp(selected.alternatives[0].ppr.toFixed(1).replace('.','\\.')));
    await page.selectOption('#mode','score');
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    assert.equal(errors.length,0,errors.join('\n'));
    assert.equal(remote.length,0,'Standalone report made network requests');
    await page.screenshot({path:path.join(root,'artifacts/explorer_screenshot.png'),fullPage:true});
    console.log('Browser smoke passed: images decoded, score/PPR switch, player/history tables, alternatives, no JS errors, no network requests.');
  } finally {await browser.close()}
})().catch(e => {console.error(e);process.exit(1)});
