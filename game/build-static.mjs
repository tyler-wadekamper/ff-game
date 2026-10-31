import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function buildStatic(destination = path.join(root, '../_site')) {
  const target = path.resolve(destination);
  if (target === root || target === path.dirname(root))
    throw Error('Use a separate output directory.');
  await fs.mkdir(target, { recursive: true });
  const names = ['app.js', 'style.css', 'icon.svg', 'icon-192.png', 'icon-512.png'];
  for (const name of names)
    await fs.copyFile(path.join(root, 'public', name), path.join(target, name));
  const modules = [
    'engine.mjs',
    'strategy.mjs',
    'config.mjs',
    'injuries.mjs',
    'player-insights.mjs',
    'season-recaps.mjs',
    'universe.mjs',
    'universe-store.mjs',
  ];
  for (const name of modules) await fs.copyFile(path.join(root, name), path.join(target, name));
  for (const name of ['demo-boot.mjs', 'demo-worker.mjs'])
    await fs.copyFile(path.join(root, 'browser', name), path.join(target, name));
  for (const name of ['catalog.json', 'worlds.json.gz', 'adp-model.json.gz'])
    await fs.copyFile(path.join(root, 'data', name), path.join(target, name));
  let html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
  html = html.replaceAll('href="/', 'href="./').replace('src="/app.js"', 'src="./demo-boot.mjs"');
  await fs.writeFile(path.join(target, 'index.html'), html);
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8'),
  );
  Object.assign(manifest, { id: './', start_url: './', scope: './' });
  for (const icon of manifest.icons) icon.src = '.' + icon.src;
  await fs.writeFile(path.join(target, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(target, '.nojekyll'), '');
  const assets = [
    './',
    './index.html',
    './manifest.webmanifest',
    ...names.map((n) => './' + n),
    ...modules.map((n) => './' + n),
    './demo-boot.mjs',
    './demo-worker.mjs',
    './catalog.json',
    './worlds.json.gz',
    './adp-model.json.gz',
  ];
  const hash = createHash('sha256');
  for (const asset of assets.filter((a) => a !== './'))
    hash.update(await fs.readFile(path.join(target, asset)));
  const cache = 'fourth-forever-browser-' + hash.digest('hex').slice(0, 16);
  const sw = `const CACHE=${JSON.stringify(cache)}, ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('fourth-forever-browser-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==location.origin)return;event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(event.request,copy)));}return response;}).catch(()=>caches.match(event.request)));});`;
  await fs.writeFile(path.join(target, 'sw.js'), sw);
  console.log('Built free-hosting browser edition:', target);
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildStatic(process.argv[2]);
