// Keep main/(root) directly playable as well as the dedicated gh-pages branch.
// GitHub Pages otherwise falls back to rendering the source repository README.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatic } from './build-static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function preparePagesRoot() {
  const site = await buildStatic();
  const entries = await fs.readdir(site, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) throw Error('Unexpected folder in the browser build.');
    await fs.copyFile(path.join(site, entry.name), path.join(root, entry.name));
  }
  console.log('Prepared runnable GitHub Pages entry in the source repository root.');
  return site;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await preparePagesRoot();
