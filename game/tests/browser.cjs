const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const { startServer } = await import(pathToFileURL(path.join(root, 'game/server.mjs')));
  const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-browser-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', saveDir });
  let browser;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }),
      page = await context.newPage();
    const errors = [],
      failed = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push([r.status(), r.url()]);
    });
    const wait = async () => {
      await page.waitForFunction(() => !document.querySelector('.busy-indicator'));
    };
    const state = () =>
      page.evaluate(async () => {
        const c = JSON.parse(localStorage.getItem('ff-current'));
        return (
          await (
            await fetch('/api/leagues/' + c.id, { headers: { Authorization: 'Bearer ' + c.token } })
          ).json()
        ).state;
      });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(root, 'artifacts/game_welcome.png'), fullPage: true });
    await page.fill('#team-name', 'Sunday Test Club');
    await page.selectOption('#draft-slot', '6');
    await page.locator('[data-create]').click();
    await page.waitForSelector('[data-draft]');
    await wait();
    let s = await state();
    assert.equal(s.teams[s.human].roster.length, 0);
    assert.equal(s.picks.length, 6);
    await page.locator('[data-position="WR"]').click();
    assert.ok((await page.locator('#player-rows').innerText()).includes('WR'));
    await page.locator('[data-queue]').first().click();
    await wait();
    assert.equal((await state()).queue.length, 1);
    await page.locator('[data-autopick]').click();
    await wait();
    assert.equal((await state()).teams[s.human].roster.length, 1);
    await page.locator('[data-position="ALL"]').click();
    await page.locator('[data-draft]').first().click();
    await wait();
    assert.equal((await state()).teams[s.human].roster.length, 2);
    await page.locator('[data-profile]').first().click();
    await page.waitForSelector('#player-weeks');
    await page.waitForFunction(() =>
      document.querySelector('#player-weeks').textContent.includes('hasn’t started'),
    );
    await page.locator('[data-close]').click();
    await page.screenshot({
      path: path.join(root, 'artifacts/game_draft_desktop.png'),
      fullPage: true,
    });
    await page.locator('[data-board]').click();
    assert.equal(await page.locator('.board-head').count(), 12);
    await page.locator('[data-close]').click();
    await page.locator('[data-finish]').click();
    await page.locator('[data-finish-confirm]').click();
    await page.waitForSelector('[data-advance]');
    await wait();
    s = await state();
    assert.equal(s.phase, 'season');
    assert.equal(s.picks.length, 192);
    assert.ok(s.teams.every((t) => t.roster.length === 16));
    assert.equal(await page.locator('[data-lineup-slot]').count(), 8);
    await page.locator('[data-optimize]').click();
    await wait();
    const select = page.locator('[data-lineup-slot="1"]'),
      options = await select
        .locator('option')
        .evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean));
    await select.selectOption(options.at(-1));
    await wait();
    await page.locator('[data-optimize]').click();
    await wait();
    await page.screenshot({
      path: path.join(root, 'artifacts/game_lineup_desktop.png'),
      fullPage: true,
    });
    await page.locator('[data-advance]').click();
    if (
      await page
        .locator('[data-play-confirm]')
        .isVisible()
        .catch(() => false)
    )
      await page.locator('[data-play-confirm]').click();
    await page.waitForFunction(() =>
      document.querySelector('dialog[open]')?.textContent.includes('Week 1 is in the books'),
    );
    await page.locator('[data-close]').last().click();
    await wait();
    s = await state();
    assert.equal(s.week, 2);
    await page.locator('.nav [data-route="waivers"]').click();
    await page.locator('[data-acquire]:not([disabled])').first().click();
    await page.fill('#waiver-bid', '100');
    await page.locator('[data-submit-claim]').click();
    await wait();
    s = await state();
    assert.equal(s.claims.length, 1);
    const claim = s.claims[0];
    await page.locator('[data-waivers]').click();
    await wait();
    s = await state();
    assert.equal(s.teams[s.human].faab, 0);
    assert.ok(s.teams[s.human].roster.includes(claim.add));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(root, 'artifacts/game_waivers_mobile.png'),
      fullPage: false,
    });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'Mobile layout overflows the viewport',
    );
    await page.locator('[data-route="team"]').click();
    await page.locator('[data-optimize]').click();
    await wait();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-advance]');
    assert.equal((await state()).week, 2);
    await page.setViewportSize({ width: 1440, height: 1050 });
    for (let week = 2; week <= 18; week++) {
      await page.locator('[data-optimize]').click();
      await wait();
      await page.locator('[data-advance]').click();
      await page.waitForFunction(() => document.querySelector('dialog[open]'));
      if (
        await page
          .locator('[data-play-confirm]')
          .isVisible()
          .catch(() => false)
      )
        await page.locator('[data-play-confirm]').click();
      await page.waitForFunction(
        (w) =>
          document
            .querySelector('dialog[open]')
            ?.textContent.includes('Week ' + w + ' is in the books'),
        week,
      );
      await page.locator('[data-close]').last().click();
      await wait();
      assert.equal((await state()).week, week + 1);
    }
    s = await state();
    assert.equal(s.phase, 'complete');
    assert.ok(Number.isInteger(s.champion));
    await page.locator('[data-route="league"]').click();
    assert.equal(await page.locator('.standings tbody tr').count(), 12);
    await page.screenshot({ path: path.join(root, 'artifacts/game_champion.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    await fs.writeFile(
      path.join(root, 'artifacts/game_browser_checks.json'),
      JSON.stringify(
        {
          passed: true,
          weeksPlayed: 18,
          desktop: [1440, 1050],
          mobile: [390, 844],
          queueManualAutoDraft: true,
          lineupChanges: true,
          waiverBudgetAndOwnership: true,
          reloadResume: true,
          mobileNavigation: true,
          champion: true,
          jsErrors: errors,
          httpErrors: failed,
        },
        null,
        2,
      ),
    );
    console.log(
      'Browser passed: new league, queue/manual/auto draft, board, profiles, lineups, exact FAAB claim, mobile, reload/resume, all 18 weekly advances, standings and champion. No JS or HTTP errors.',
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(saveDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
