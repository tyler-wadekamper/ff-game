import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { applyAction, publicState, hydrateLeague, GameError } from './engine.mjs';
import { universeServices } from './universe-store.mjs';
import { weeklyRecap } from './season-recaps.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export function loadData() {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'data/catalog.json'), 'utf8'));
  const privateData = JSON.parse(gunzipSync(readFileSync(path.join(ROOT, 'data/worlds.json.gz'))));
  if (catalog.version !== privateData.version)
    throw new Error('Game data versions differ. Run npm run data:game.');
  const adpModel = JSON.parse(gunzipSync(readFileSync(path.join(ROOT, 'data/adp-model.json.gz'))));
  return {
    catalog,
    privateData,
    adpModel,
    players: new Map(catalog.players.map((p) => [p.id, p])),
  };
}
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ...['config.mjs', 'player-insights.mjs'].map((name) => [
    '/' + name,
    ['../' + name, 'text/javascript; charset=utf-8'],
  ]),
]);
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) throw new GameError('Request too large.');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new GameError('Send a valid JSON object.');
  }
}
function tokenMatches(stored, provided) {
  if (typeof provided !== 'string' || provided.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(provided));
}
export async function startServer({
  port = Number(process.env.PORT ?? 3000),
  host = '0.0.0.0',
  saveDir = path.join(ROOT, 'saves'),
  data = loadData(),
} = {}) {
  await fs.mkdir(saveDir, { recursive: true });
  const { catalog, privateData, players } = data,
    locks = new Map(),
    creationWindows = new Map();
  const services = universeServices(data);
  const savePath = (id) => path.join(saveDir, id + '.json');
  async function save(id, record) {
    const temp = savePath(id) + '.tmp';
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, savePath(id));
  }
  async function serialized(id, fn) {
    const previous = locks.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(fn);
    locks.set(id, job);
    try {
      return await job;
    } finally {
      if (locks.get(id) === job) locks.delete(id);
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, 'http://localhost'),
        route = url.pathname;
      if (req.method === 'GET' && route === '/api/health')
        return json(res, 200, { ok: true, version: catalog.version });
      if (req.method === 'GET' && route === '/api/catalog') {
        const content = Buffer.from(JSON.stringify(services.baseCatalog));
        if (req.headers['accept-encoding']?.includes('gzip')) {
          const { gzipSync } = await import('node:zlib');
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            Vary: 'Accept-Encoding',
            'Cache-Control': 'no-cache',
          });
          res.end(gzipSync(content));
          return;
        }
        return json(res, 200, services.baseCatalog);
      }
      if (req.method === 'POST' && route === '/api/leagues') {
        const address = req.socket.remoteAddress ?? 'unknown',
          now = Date.now();
        for (const [key, window] of creationWindows)
          if (now - window.start > 3600000) creationWindows.delete(key);
        const window = creationWindows.get(address) ?? { start: now, count: 0 };
        if (window.count >= 30)
          return json(res, 429, {
            error: 'Too many new leagues this hour. Resume an existing franchise or try later.',
          });
        window.count++;
        creationWindows.set(address, window);
        const options = await body(req),
          id = randomUUID(),
          token = randomBytes(24).toString('hex');
        let source = null;
        if (options.mode === 'continue') {
          if (!/^[a-f0-9-]{36}$/.test(options.source?.id ?? ''))
            throw new GameError('Choose a completed saved universe.');
          try {
            source = JSON.parse(await fs.readFile(savePath(options.source.id), 'utf8'));
          } catch {
            throw new GameError('That completed season could not be found.');
          }
          if (!tokenMatches(source.token, options.source.token))
            return json(res, 401, { error: 'The prior universe needs its recovery key.' });
        }
        const created = services.create(
          options,
          source,
          randomBytes(4).readUInt32LE(),
          randomUUID(),
        );
        const { state, universe, context } = created;
        await save(id, { token, state, universe });
        return json(res, 201, {
          id,
          token,
          state: publicState(state, context.catalog, context.players, context.world),
          catalog: context.catalog,
        });
      }
      const match = route.match(
        /^\/api\/leagues\/([a-f0-9-]{36})(?:\/(actions|players\/[^/]+|recaps\/\d+))?$/,
      );
      if (match) {
        const id = match[1];
        return await serialized(id, async () => {
          let record;
          try {
            record = JSON.parse(await fs.readFile(savePath(id), 'utf8'));
          } catch (e) {
            if (e.code === 'ENOENT') return json(res, 404, { error: 'League not found.' });
            throw e;
          }
          const token = req.headers.authorization?.replace(/^Bearer /, '');
          if (!tokenMatches(record.token, token))
            return json(res, 401, { error: 'This league needs its saved recovery key.' });
          const state = record.state;
          const { catalog, players, world } = services.context(record);
          if (hydrateLeague(state, catalog, players, world)) await save(id, record);
          if (req.method === 'GET' && !match[2])
            return json(res, 200, { state: publicState(state, catalog, players, world), catalog });
          if (req.method === 'GET' && match[2]?.startsWith('recaps/'))
            return json(res, 200, {
              recap: weeklyRecap(state, catalog, Number(match[2].slice(7))),
            });
          if (req.method === 'GET' && match[2]?.startsWith('players/')) {
            const player = decodeURIComponent(match[2].slice(8));
            if (!players.has(player)) return json(res, 404, { error: 'Player not found.' });
            return json(res, 200, {
              columns: privateData.columns,
              weeks: world[player].slice(0, Math.min(18, state.week - 1)),
            });
          }
          if (req.method === 'POST' && match[2] === 'actions') {
            const input = await body(req);
            if (input.revision !== state.revision)
              return json(res, 409, {
                error: 'Another tab updated this league. Your view has been refreshed.',
                state: publicState(state, catalog, players, world),
              });
            const next = structuredClone(state);
            applyAction(next, input.action ?? {}, catalog, players, world);
            await save(id, { ...record, state: next });
            return json(res, 200, { state: publicState(next, catalog, players, world) });
          }
          return json(res, 405, { error: 'Method not allowed.' });
        });
      }
      if (req.method === 'GET' && files.has(route)) {
        const [file, type] = files.get(route);
        const content = await fs.readFile(path.join(ROOT, 'public', file));
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': file === 'sw.js' ? 'no-cache' : 'no-cache',
        });
        res.end(content);
        return;
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof GameError) return json(res, 400, { error: error.message });
      console.error('Game server error:', error.message);
      json(res, 500, { error: 'That move could not be saved. Refresh and try again.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log(`Fourth & Forever is running at http://localhost:${server.address().port}`);
}
