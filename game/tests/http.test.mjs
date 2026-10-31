import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, loadData } from '../server.mjs';

test('HTTP persistence, authorization, concurrency, validation and future-result isolation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-http-')),
    data = loadData();
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  server = await startServer({ port: 0, host: '127.0.0.1', saveDir: dir, data });
  let base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, options = {}) => {
    const response = await fetch(base + url, options);
    return { status: response.status, data: await response.json() };
  };
  const created = await call('/api/leagues', {
    method: 'POST',
    body: JSON.stringify({ name: 'HTTP Test', slot: 6 }),
  });
  assert.equal(created.status, 201);
  const { id, token } = created.data;
  let state = created.data.state;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const move = (action) =>
    call(`/api/leagues/${id}/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: state.revision, action }),
    });
  await t.test('private data and server files have no HTTP route', async () => {
    for (const route of [
      '/data/worlds.json.gz',
      '/game/data/worlds.json.gz',
      '/saves/' + id + '.json',
      '/server.mjs',
      '/../data/worlds.json.gz',
      '/.git/config',
    ])
      assert.equal((await call(route)).status, 404);
  });
  await t.test('unknown or wrong bearer tokens are rejected', async () => {
    assert.equal((await call(`/api/leagues/${id}`)).status, 401);
    assert.equal(
      (await call(`/api/leagues/${id}`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(48) } }))
        .status,
      401,
    );
  });
  await t.test('two concurrent moves at the same revision commit exactly once', async () => {
    const results = await Promise.all([move({ type: 'autopick' }), move({ type: 'autopick' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    state = results.find((r) => r.status === 200).data.state;
    assert.equal(state.teams[state.human].roster.length, 1);
  });
  await t.test('draft exposes histories and availability without season outcomes', async () => {
    assert.ok(!('world' in state));
    assert.ok(!('rng' in state));
    assert.deepEqual(state.observed, {});
    assert.ok(Object.values(state.pastPoints).every((v) => v.length === 0));
    const result = await call(`/api/leagues/${id}/players/${created.data.catalog.players[0].id}`, {
      headers,
    });
    assert.equal(result.data.weeks.length, 0);
  });
  await t.test('invalid moves are rejected without altering the saved revision', async () => {
    const before = state.revision;
    const invalid = await move({ type: 'draft', player: 'NOT-A-PLAYER' });
    assert.equal(invalid.status, 400);
    const result = await call(`/api/leagues/${id}`, { headers });
    assert.equal(result.data.state.revision, before);
    const malformed = await call(`/api/leagues/${id}/actions`, {
      method: 'POST',
      headers,
      body: '{',
    });
    assert.equal(malformed.status, 400);
  });
  await t.test('draft, lineup and weekly scoring actions persist', async () => {
    const draft = await move({ type: 'finishDraft' });
    assert.equal(draft.status, 200);
    state = draft.data.state;
    assert.equal(state.phase, 'season');
    const optimized = await move({ type: 'optimize' });
    state = optimized.data.state;
    const result = await move({ type: 'advance' });
    assert.equal(result.status, 200);
    state = result.data.state;
    assert.equal(state.week, 2);
    const player = await call(`/api/leagues/${id}/players/${created.data.catalog.players[0].id}`, {
      headers,
    });
    assert.equal(player.data.weeks.length, 1);
    assert.ok(Object.values(state.pastPoints).every((v) => v.length === 1));
  });
  await t.test('server restart restores the same league and revision', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = await startServer({ port: 0, host: '127.0.0.1', saveDir: dir, data });
    base = `http://127.0.0.1:${server.address().port}`;
    const resumed = await call(`/api/leagues/${id}`, { headers });
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.data.state, state);
  });
  await t.test(
    'recap archives stop at completed weeks; universe continuation requires the source key and a finished season',
    async () => {
      const first = await call(`/api/leagues/${id}/recaps/1`, { headers });
      assert.equal(first.data.recap.week, 1);
      assert.equal((await call(`/api/leagues/${id}/recaps/2`, { headers })).data.recap, null);
      assert.equal((await call(`/api/leagues/${id}/recaps/1`)).status, 401);
      const next = (source) =>
        call('/api/leagues', {
          method: 'POST',
          body: JSON.stringify({ mode: 'continue', source }),
        });
      assert.equal((await next({ id, token: 'wrong' })).status, 401);
      assert.equal((await next({ id, token })).status, 400);
    },
  );
});
