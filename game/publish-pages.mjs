// Publish the generated browser edition without changing the source checkout.
// GitHub Pages must use gh-pages / (root); no paid hosting or server is required.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildStatic } from './build-static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = await buildStatic();
const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
const gitDir = git(['rev-parse', '--absolute-git-dir']);
const remote = git(['ls-remote', '--heads', 'origin', 'gh-pages']);
const previous = remote.split(/\s/)[0] || null;
if (previous) git(['fetch', 'origin', 'gh-pages']);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-pages-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
  const args = [`--git-dir=${gitDir}`, `--work-tree=${site}`];
  git([...args, 'read-tree', '--empty'], { cwd: site, env });
  git([...args, 'add', '--all'], { cwd: site, env });
  const tree = git([...args, 'write-tree'], { cwd: site, env });
  const commit = git([
    '-c',
    'user.name=Codex',
    '-c',
    'user.email=codex@openai.com',
    'commit-tree',
    tree,
    ...(previous ? ['-p', previous] : []),
    '-m',
    'Publish Fourth & Forever browser demo',
  ]);
  // A concurrent remote update fails safely; there is deliberately no force push.
  git(['push', 'origin', `${commit}:refs/heads/gh-pages`]);
  git(['update-ref', 'refs/heads/gh-pages', commit]);
  console.log('Published static branch:', commit);
  console.log('Pages settings: https://github.com/tyler-wadekamper/ff-game/settings/pages');
  console.log('Expected site after Pages activation: https://tyler-wadekamper.github.io/ff-game/');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
