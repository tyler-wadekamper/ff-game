// Single-player browser edition. State stays in IndexedDB on this device.
// Bundled outcomes are inspectable by the device owner; this is not a secure server.
import {
  createLeague,
  botsUntilHuman,
  applyAction,
  publicState,
  assertLeague,
  GameError,
} from './engine.mjs';

const ready = (async () => {
  const [catalogResponse, worldsResponse] = await Promise.all([
    fetch(new URL('./catalog.json', import.meta.url)),
    fetch(new URL('./worlds.json.gz', import.meta.url)),
  ]);
  if (!catalogResponse.ok || !worldsResponse.ok)
    throw Error('The game download failed. Reload to retry.');
  const catalog = await catalogResponse.json();
  const data = await new Response(
    worldsResponse.body.pipeThrough(new DecompressionStream('gzip')),
  ).json();
  if (catalog.version !== data.version) throw Error('Game data changed. Reload to update.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('fourth-forever-browser-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('leagues', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('Allow browser storage to save your league.'));
  });
  return { catalog, data, db, players: new Map(catalog.players.map((p) => [p.id, p])) };
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
  const { catalog, data, db, players } = await ready;
  const route = message.url,
    method = message.method ?? 'GET';
  const input = message.body ? JSON.parse(message.body) : {};
  const response = (body, status = 200) => ({ status, body });
  const view = (state) => publicState(state, catalog, players, data.worlds[state.world]);
  if (route === '/api/catalog' && method === 'GET') return response(catalog);
  if (route === '/api/leagues' && method === 'POST') {
    const id = crypto.randomUUID();
    const token = [...crypto.getRandomValues(new Uint8Array(24))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    const state = createLeague({
      name: input.name,
      slot: input.slot,
      seed: crypto.getRandomValues(new Uint32Array(1))[0],
      version: catalog.version,
      worlds: data.worlds.length,
    });
    botsUntilHuman(state, catalog, players);
    return transaction(db, id, () => ({
      record: { id, token, state },
      response: response({ id, token, state: view(state) }, 201),
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
      state.version !== catalog.version ||
      !Number.isInteger(state.world) ||
      !data.worlds[state.world] ||
      state.teams?.length !== 12 ||
      !['draft', 'season', 'complete'].includes(state.phase) ||
      !Number.isInteger(state.human) ||
      state.human < 0 ||
      state.human > 11
    )
      throw new GameError('This backup does not match the current game.');
    assertLeague(state, players);
    return transaction(db, input.id, () => ({
      record: { id: input.id, token: input.token, state },
      response: response({ id: input.id, token: input.token }),
    }));
  }
  const match = route.match(
    /^\/api\/leagues\/([a-f0-9-]{36})(?:\/(actions|backup|players\/[^/]+))?$/,
  );
  if (!match) return response({ error: 'Not found.' }, 404);
  return transaction(db, match[1], (record) => {
    const answer = (body, status) => ({ response: response(body, status) });
    if (!record)
      return answer(
        { error: 'League not found on this device. Import a full backup to restore it.' },
        404,
      );
    if (message.authorization !== 'Bearer ' + record.token)
      return answer({ error: 'Invalid recovery key.' }, 401);
    const state = record.state;
    if (state.version !== catalog.version)
      return answer({ error: 'This save uses a different player database.' }, 409);
    if (!match[2] && method === 'GET') return answer({ state: view(state) });
    if (match[2] === 'backup' && method === 'GET')
      return answer({
        format: 'fourth-forever-browser-v1',
        id: record.id,
        token: record.token,
        league: state,
      });
    if (match[2]?.startsWith('players/') && method === 'GET') {
      const id = decodeURIComponent(match[2].slice(8));
      if (!players.has(id)) return answer({ error: 'Player not found.' }, 404);
      return answer({
        columns: data.columns,
        weeks: data.worlds[state.world][id].slice(0, Math.min(18, state.week - 1)),
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
      applyAction(next, input.action ?? {}, catalog, players, data.worlds[state.world]);
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
