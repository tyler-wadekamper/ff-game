const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const { preparePagesRoot } = await import(
    pathToFileURL(path.join(root, 'game/prepare-pages.mjs'))
  );
  const built = await preparePagesRoot();
  // Test the source branch too: Pages must launch index.html rather than README.md.
  const site = process.env.PAGES_FROM_SOURCE === '1' ? root : built;
  for (const name of await fs.readdir(built)) {
    assert.deepEqual(
      await fs.readFile(path.join(root, name)),
      await fs.readFile(path.join(built, name)),
    );
  }
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.gz': 'application/gzip',
  };
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (!route.startsWith('/ff-game/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const relative = route.slice('/ff-game/'.length) || 'index.html';
      const file = path.resolve(site, relative);
      if (!file.startsWith(site + path.sep)) throw Error('Not found');
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [],
      bad = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      if (r.status() >= 400) bad.push([r.status(), r.url()]);
    });
    const base = `http://127.0.0.1:${server.address().port}/ff-game/`;
    const wait = () => page.waitForFunction(() => !document.querySelector('.busy-indicator'));
    const state = () =>
      page.evaluate(async () => {
        const c = JSON.parse(localStorage.getItem('ff-current'));
        return (
          await (
            await FF_API('/api/leagues/' + c.id, {
              headers: { Authorization: 'Bearer ' + c.token },
            })
          ).json()
        ).state;
      });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#team-city');
    assert.equal(await page.locator('[data-quick-start]').count(), 1);
    const start = await page.locator('[data-quick-start]').boundingBox();
    assert.ok(
      start.y >= 0 && start.y + start.height <= 844,
      'Start button must be visible without scrolling',
    );
    assert.match(await page.locator('.footnote').last().textContent(), /device/);
    await page.locator('[data-quick-start]').click();
    await page.waitForSelector('[data-draft]');
    await wait();
    await page.locator('[data-draft]').first().click();
    await wait();
    await page.locator('[data-finish]').click();
    await page.locator('[data-finish-confirm]').click();
    await page.waitForSelector('[data-advance]');
    await wait();
    assert.equal((await state()).picks.length, 168);
    // Real UI reserve -> free pickup into the open slot, then activate on recovery.
    let firstState = await state();
    const injured = firstState.teams[firstState.human].roster.find(
      (id) => firstState.injuryReports[id].irEligible,
    );
    if (injured) {
      await page.locator(`[data-profile="${injured}"]`).first().click();
      await page.waitForSelector('.career-table');
      assert.ok(await page.locator('.outlook').count());
      await page.screenshot({
        path: path.join(root, 'artifacts/player_career_mobile.png'),
        fullPage: false,
      });
      await page.locator(`#dialog [data-reserve="${injured}"]`).click();
      await wait();
      const stashed = await state();
      assert.equal(stashed.teams[stashed.human].ir.length, 1);
      assert.equal(stashed.teams[stashed.human].roster.length, 13);
      await page.locator('.nav [data-route="waivers"]').click();
      await page.locator(`[data-position="${injured.split('-')[0]}"]`).click();
      await page.locator('[data-acquire]:not([disabled])').first().click();
      assert.equal(await page.locator('#drop-player').inputValue(), '');
      await page.locator('[data-submit-claim]').click();
      await wait();
      assert.equal((await state()).teams[firstState.human].roster.length, 14);
      await page.locator('.nav [data-route="team"]').click();
    }
    await page.locator('.nav [data-route="depth"]').click();
    await page.selectOption('#depth-club', 'DET');
    assert.equal(await page.locator('.depth-grid .card').count(), 4);
    await page.locator('.nav [data-route="team"]').click();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // The same /ff-game/ deployment must remain playable without any backend or network.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[data-advance]');
    for (let week = 1; week <= 18; week++) {
      const current = await state();
      for (const id of current.teams[current.human].ir ?? [])
        if (!current.injuryReports[id].irEligible) {
          await page.locator(`[data-activate-ir="${id}"]`).click();
          await page.locator('[data-submit-claim]').click();
          await wait();
        }
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
        (w) => document.querySelector('dialog[open] [data-weekly-report="' + w + '"]'),
        week,
      );
      assert.ok((await page.locator(`[data-weekly-report="${week}"] .award-card`).count()) >= 8);
      if (week === 3)
        await page.screenshot({
          path: path.join(root, 'artifacts/weekly_recap_mobile.png'),
          fullPage: false,
        });
      await page.locator('[data-close]').last().click();
      await wait();
      assert.equal((await state()).week, week + 1);
    }
    const completed = await state();
    assert.equal(completed.phase, 'complete');
    assert.ok(Number.isInteger(completed.champion));
    await page.locator('[data-settings]').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-backup]').click();
    const download = await downloadPromise;
    const backupPath = path.join(root, 'artifacts/static-recovery-test.json');
    await download.saveAs(backupPath);
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
    assert.equal(backup.league.week, 19);
    // Cross-device recovery requires the whole save, not only a server access key.
    const other = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
      second = await other.newPage();
    await second.goto(base, { waitUntil: 'networkidle' });
    await second.waitForSelector('#team-city');
    await second.evaluate(async (payload) => {
      await FF_IMPORT(payload);
      localStorage.setItem('ff-current', JSON.stringify({ id: payload.id, token: payload.token }));
    }, backup);
    await second.reload({ waitUntil: 'networkidle' });
    await second.waitForSelector('.champion');
    const restored = await second.evaluate(async () => {
      const c = JSON.parse(localStorage.getItem('ff-current'));
      return (
        await (
          await FF_API('/api/leagues/' + c.id, { headers: { Authorization: 'Bearer ' + c.token } })
        ).json()
      ).state;
    });
    assert.equal(restored.champion, completed.champion);
    assert.deepEqual(restored.results, completed.results);
    await second.screenshot({
      path: path.join(root, 'artifacts/static_game_completed.png'),
      fullPage: true,
    });
    await second.locator('.nav [data-route="recaps"]').click();
    assert.equal(await second.locator('[data-season-report]').count(), 1);
    await second.screenshot({
      path: path.join(root, 'artifacts/season_yearbook_desktop.png'),
      fullPage: true,
    });
    await second.locator('[data-show-recap="1"]').click();
    await second.waitForSelector('dialog [data-weekly-report="1"]');
    assert.equal(await second.locator('dialog [data-weekly-report="1"]').count(), 1);
    await second.locator('[data-close]').click();
    await second.locator('.nav [data-route="team"]').click();
    await second.locator('[data-continue]').click();
    await second.locator('#setup-form [data-create]').click();
    await second.waitForFunction(
      () => !document.querySelector('dialog[open]') && !document.querySelector('.busy-indicator'),
    );
    await second.waitForSelector('[data-draft]');
    const next = await second.evaluate(async () => {
      const c = JSON.parse(localStorage.getItem('ff-current'));
      return await (
        await FF_API('/api/leagues/' + c.id, { headers: { Authorization: 'Bearer ' + c.token } })
      ).json();
    });
    assert.equal(next.state.seasonYear, completed.seasonYear + 1);
    assert.equal(next.state.universe.id, completed.universe.id);
    assert.ok(next.catalog.players.some((p) => backup.league.picks.some((x) => x.player === p.id)));
    const retained = next.catalog.players.find(
      (p) =>
        backup.league.picks.some((x) => x.player === p.id) &&
        !next.state.picks.some((x) => x.player === p.id),
    );
    await second.fill('#search', retained.name);
    await second.locator(`[data-profile="${retained.id}"]`).click();
    await second.waitForSelector('.career-table');
    assert.match(await second.locator('.career-table').first().innerText(), /2026/);
    await second.screenshot({
      path: path.join(root, 'artifacts/player_career_desktop.png'),
      fullPage: false,
    });
    await second.locator('[data-close]').click();
    await second.locator('[data-settings]').click();
    await second.locator('[data-new]').click();
    await second.locator('#setup-form [data-create]').click();
    await second.waitForFunction(
      () => !document.querySelector('dialog[open]') && !document.querySelector('.busy-indicator'),
    );
    await second.waitForSelector('[data-draft]');
    const brandNew = await second.evaluate(async () => {
      const c = JSON.parse(localStorage.getItem('ff-current'));
      return await (
        await FF_API('/api/leagues/' + c.id, { headers: { Authorization: 'Bearer ' + c.token } })
      ).json();
    });
    assert.notEqual(brandNew.state.universe.id, next.state.universe.id);
    assert.ok(
      brandNew.catalog.players.every((p) => !next.catalog.players.some((q) => q.id === p.id)),
    );
    await fs.rm(backupPath);
    assert.deepEqual(errors, []);
    assert.deepEqual(bad, []);
    await fs.writeFile(
      path.join(root, 'artifacts/static_browser_checks.json'),
      JSON.stringify(
        {
          passed: true,
          subdirectory: '/ff-game/',
          source: process.env.PAGES_FROM_SOURCE === '1' ? 'main/root' : 'generated build',
          sourceAndPublishingFilesIdentical: true,
          visibleQuickStart: true,
          weeksPlayedOffline: 18,
          fullDraft: true,
          saveReload: true,
          crossBrowserBackupRestore: true,
          injuryReserveUI: Boolean(injured),
          cityDepthCharts: true,
          weeklyAndYearlyRecaps: true,
          continuationRetainsHistory: true,
          newUniverseRegeneratesPlayers: true,
          jsErrors: errors,
          httpErrors: bad,
        },
        null,
        2,
      ),
    );
    console.log(
      'Static Pages build passed: subdirectory assets, 168-pick draft, offline reload, all 18 weeks offline, local saves and full cross-browser backup recovery.',
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
