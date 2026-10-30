const worker = new Worker(new URL('./demo-worker.mjs', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 0;
worker.onmessage = ({ data }) => {
  const job = pending.get(data.id);
  if (!job) return;
  pending.delete(data.id);
  clearTimeout(job.timer);
  job.resolve(Response.json(data.body, { status: data.status }));
};
worker.onerror = () => {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(Error('The game worker stopped. Reload to resume.'));
  }
  pending.clear();
};
globalThis.FF_MODE = 'browser';
globalThis.FF_API = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('The game is taking too long. Reload to resume.'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({
      id,
      url,
      method: options.method ?? 'GET',
      body: options.body,
      authorization: new Headers(options.headers).get('Authorization'),
    });
  });
globalThis.FF_EXPORT = async (credentials) => {
  const response = await FF_API(`/api/leagues/${credentials.id}/backup`, {
    headers: { Authorization: 'Bearer ' + credentials.token },
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
};
globalThis.FF_IMPORT = async (backup) => {
  const response = await FF_API('/api/import', { method: 'POST', body: JSON.stringify(backup) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
};
await import('./app.js');
