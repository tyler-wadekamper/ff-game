// Single-player browser edition. State stays in IndexedDB on this device.
// Bundled outcomes are inspectable by the device owner; this is not a secure server.
import {
  createLeague,
  botsUntilHuman,
  applyAction,
  publicState,
  assertLeague,
  GameError,
  hydrateLeague,
} from './engine.mjs';
import { universeServices } from './universe-store.mjs';
import { weeklyRecap } from './season-recaps.mjs';

const ready = (async () => {
  const [catalogResponse, worldsResponse, marketResponse, realResponse] = await Promise.all([
    fetch(new URL('./catalog.json', import.meta.url)),
    fetch(new URL('./worlds.json.gz', import.meta.url)),
    fetch(new URL('./adp-model.json.gz', import.meta.url)),
    fetch(new URL('./real-players.json.gz', import.meta.url)),
  ]);
  if (!catalogResponse.ok || !worldsResponse.ok || !marketResponse.ok || !realResponse.ok)
    throw Error('The game download failed. Reload to retry.');
  const catalog = await catalogResponse.json();
  const data = await new Response(
    worldsResponse.body.pipeThrough(new DecompressionStream('gzip')),
  ).json();
  const adpModel = await new Response(
    marketResponse.body.pipeThrough(new DecompressionStream('gzip')),
  ).json();
  const realPlayers = await new Response(
    realResponse.body.pipeThrough(new DecompressionStream('gzip')),
  ).json();
  if (catalog.version !== data.version) throw Error('Game data changed. Reload to update.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('fourth-forever-browser-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('leagues', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('Allow browser storage to save your league.'));
  });
  const players = new Map(catalog.players.map((p) => [p.id, p]));
  return {
    catalog,
    data,
    db,
    players,
    services: universeServices({ catalog, privateData: data, adpModel, realPlayers, players }),
  };
})();

function transaction(db, id, update) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('leagues', 'readwrite');
    const store = tx.objectStore('leagues');
    let result;
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        const changed = update(request.result);
        if (changed.record) store.put(changed.record);
        result = changed.response;
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(Error('Your move could not be saved. Browser storage may be full.'));
    tx.onabort = () => reject(Error('Your move was not saved.'));
  });
}

async function handle(message) {
  const { catalog, data, db, players, services } = await ready;
  const route = message.url,
    method = message.method ?? 'GET';
  const input = message.body ? JSON.parse(message.body) : {};
  const response = (body, status = 200) => ({ status, body });
  if (route === '/api/catalog' && method === 'GET') return response(services.baseCatalog);
  if (route === '/api/leagues' && method === 'POST') {
    const id = crypto.randomUUID();
    const token = [...crypto.getRandomValues(new Uint8Array(24))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    let source = null;
    if (input.mode === 'continue') {
      if (typeof input.source?.id !== 'string')
        throw new GameError('Choose a completed saved universe.');
      source = await transaction(db, input.source?.id, (record) => ({ response: record }));
      if (!source || source.token !== input.source?.token)
        throw new GameError('The previous season needs its recovery key on this device.');
    }
    const created = services.create(
      input,
      source,
      crypto.getRandomValues(new Uint32Array(1))[0],
      crypto.randomUUID(),
    );
    const { state, universe, context } = created;
    return transaction(db, id, () => ({
      record: { id, token, state, universe },
      response: response(
        {
          id,
          token,
          state: publicState(state, context.catalog, context.players, context.world),
          catalog: context.catalog,
        },
        201,
      ),
    }));
  }
  if (route === '/api/import' && method === 'POST') {
    if (
      input.format !== 'fourth-forever-browser-v1' ||
      !input.league ||
      typeof input.id !== 'string' ||
      typeof input.token !== 'string'
    )
      throw new GameError('Choose a full browser-edition backup file.');
    const state = input.league;
    if (
      !Number.isInteger(state.world) ||
      state.teams?.length !== 12 ||
      !['draft', 'season', 'complete'].includes(state.phase) ||
      !Number.isInteger(state.human) ||
      state.human < 0 ||
      state.human > 11
    )
      throw new GameError('This backup does not match the current game.');
    if (
      input.universe &&
      (!Number.isInteger(input.universe.season) ||
        input.universe.season < 1 ||
        input.universe.season > 100)
    )
      throw new GameError('Invalid universe season in this backup.');
    const imported = { id: input.id, token: input.token, state, universe: input.universe ?? null };
    const context = services.context(imported);
    hydrateLeague(state, context.catalog, context.players, context.world);
    assertLeague(state, context.players);
    return transaction(db, input.id, () => ({
      record: imported,
      response: response({ id: input.id, token: input.token }),
    }));
  }
  const match = route.match(
    /^\/api\/leagues\/([a-f0-9-]{36})(?:\/(actions|backup|players\/[^/]+|recaps\/\d+))?$/,
  );
  if (!match) return response({ error: 'Not found.' }, 404);
  return transaction(db, match[1], (record) => {
    let migrated = false;
    const answer = (body, status) => ({
      record: migrated ? record : undefined,
      response: response(body, status),
    });
    if (!record)
      return answer(
        { error: 'League not found on this device. Import a full backup to restore it.' },
        404,
      );
    if (message.authorization !== 'Bearer ' + record.token)
      return answer({ error: 'Invalid recovery key.' }, 401);
    const state = record.state;
    const { catalog, players, world } = services.context(record);
    migrated = hydrateLeague(state, catalog, players, world);
    const view = (state) => publicState(state, catalog, players, world);
    if (!match[2] && method === 'GET') return answer({ state: view(state), catalog });
    if (match[2]?.startsWith('recaps/') && method === 'GET')
      return answer({ recap: weeklyRecap(state, catalog, Number(match[2].slice(7))) });
    if (match[2] === 'backup' && method === 'GET')
      return answer({
        format: 'fourth-forever-browser-v1',
        id: record.id,
        token: record.token,
        league: state,
        universe: record.universe ?? null,
      });
    if (match[2]?.startsWith('players/') && method === 'GET') {
      const id = decodeURIComponent(match[2].slice(8));
      if (!players.has(id)) return answer({ error: 'Player not found.' }, 404);
      return answer({
        columns: data.columns,
        weeks: world[id].slice(0, Math.min(18, state.week - 1)),
      });
    }
    if (match[2] === 'actions' && method === 'POST') {
      if (input.revision !== state.revision)
        return answer(
          {
            error: 'Another tab updated this league. Your view has been refreshed.',
            state: view(state),
          },
          409,
        );
      const next = structuredClone(state);
      applyAction(next, input.action ?? {}, catalog, players, world);
      return { record: { ...record, state: next }, response: response({ state: view(next) }) };
    }
    return answer({ error: 'Method not allowed.' }, 405);
  });
}

self.onmessage = async ({ data: message }) => {
  try {
    self.postMessage({ id: message.id, ...(await handle(message)) });
  } catch (error) {
    self.postMessage({
      id: message.id,
      status: error instanceof GameError ? 400 : 500,
      body: { error: error.message || 'That move could not be saved.' },
    });
  }
};
