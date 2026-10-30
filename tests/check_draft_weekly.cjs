// Optional offline UI smoke test: Playwright + system Chromium.
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
    // Managed Chromium disables file://; setContent loads our own standalone HTML.
    await page.setContent(fs.readFileSync(path.join(root, 'reports/DRAFT_WEEKLY_EXPLORER.html'), 'utf8'), {waitUntil: 'load'});
    const data = JSON.parse(await page.locator('#report-data').textContent());
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    assert.equal(data.players.length, 972);
    assert.equal(await page.locator('#player option').count(), 972);
    assert.equal(await page.locator('#board tr').count(), 193);
    assert.equal(await page.locator('.weekbar').count(), 18);
    assert.equal(await page.locator('#weeks tr').count(), 19);
    assert.equal(data.summary.weekly_gates_passed, data.summary.weekly_gates_total);
    for (const p of data.players) {
      assert.equal(p.calendars.length, 6);
      for (let i = 0; i < 6; i += 2) {
        const a = p.calendars[i], b = p.calendars[i + 1];
        assert.equal(a.rows.length, 18); assert.equal(b.rows.length, 18);
        assert.equal(a.bye, b.bye);
        const sums = c => c.rows[0].map((_, j) => c.rows.reduce((s, r) => s + r[j], 0));
        sums(a).forEach((v, j) => assert.ok(Math.abs(v - sums(b)[j]) < 1e-7));
        assert.ok(a.rows[a.bye - 1].every(v => v === 0));
      }
    }
    const price = await page.locator('#price').textContent();
    const totals = await page.locator('#totals').textContent();
    const bars = await page.locator('#chart').innerHTML();
    await page.selectOption('#path', '1');
    assert.equal(await page.locator('#price').textContent(), price);
    assert.equal(await page.locator('#totals').textContent(), totals);
    assert.notEqual(await page.locator('#chart').innerHTML(), bars);
    await page.selectOption('#season', '1');
    assert.equal(await page.locator('#price').textContent(), price);
    await page.selectOption('#limit', '9999');
    assert.equal(await page.locator('#board tr').count(), 973);
    await page.selectOption('#position', 'TE');
    const tightEnds = data.players.filter(p => p.position === 'TE');
    assert.equal(await page.locator('#board tr').count(), tightEnds.length + 1);
    await page.fill('#search', tightEnds[0].id);
    assert.equal(await page.locator('#board button').count(), 1);
    await page.locator('#board button').click();
    assert.match(await page.locator('#price').textContent(), new RegExp(tightEnds[0].id));
    assert.equal(await page.locator('#history tr').count(), tightEnds[0].history.length + 1);
    assert.equal(await page.locator('#comps tr').count(), tightEnds[0].comparables.length + 1);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator('.weekbar').count(), 18);
    await page.screenshot({path: path.join(root, 'artifacts/draft_weekly_mobile.png'), fullPage: true});
    await page.setViewportSize({width: 1280, height: 960});
    await page.selectOption('#player', '0');
    await page.locator('#calendar').scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(root, 'artifacts/draft_weekly_screenshot.png')});
    assert.deepEqual(errors, []);
    assert.deepEqual(remote, [], 'Standalone report made network requests');
    console.log('Draft/weekly browser checks passed: all 972 players and six calendars, exact path totals, fixed ADP, filters, history/comparables, 18 bars, desktop/mobile, embedded images, no JS errors or network.');
  } finally {await browser.close()}
})().catch(e => {console.error(e);process.exit(1)});
