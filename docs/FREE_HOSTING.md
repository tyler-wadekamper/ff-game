# Free browser-hosted playtest

The complete single-player game can be hosted on **GitHub Pages at no hosting charge** for an eligible repository. No Node server, database service, credit card or paid hosting tier is required for this browser edition. GitHub Pages is available for public repositories on GitHub Free, and for private repositories on eligible paid GitHub plans; this project does not change repository visibility or purchase a plan.

The browser edition shares the exact draft, bot, waiver, lineup and scoring engine with the Node application. It moves execution into a Web Worker and saves leagues in IndexedDB on the player's device. After the initial download, a service worker caches the complete game for offline play. A full recovery file transfers a franchise to another browser or device. Server-edition access-key-only recovery files cannot transfer a browser-edition save.

Browser owners can inspect the bundled football outcomes with developer tools. This edition is an account-free, single-player playtest, not a secure multiplayer or real-money platform. The Node application's private-world and server-save boundary remains unchanged.

## Publish

```sh
npm run build:static
npm run build:pages
npm run test:static
npm run publish:pages
```

`build:pages` copies the generated browser edition to the source repository root, including a real `index.html` and `.nojekyll`. Commit these generated root files with source updates so **main / (root)** opens the game directly rather than rendering the README. The publisher also refreshes those root files and uploads the same playable site to `gh-pages`, without force-pushing. Both publishing branches therefore support the same direct game URL. They contain the fictional catalog, twelve packaged worlds, game engine and interface; no local league saves or credentials are included. `_site/` is generated and ignored by Git.

For first-time GitHub Pages activation, a repository administrator may need to open:

https://github.com/tyler-wadekamper/ff-game/settings/pages

Choose **Deploy from a branch → main or gh-pages → /(root) → Save**. Both branches have a runnable entry page. GitHub's Pages deployment then serves:

https://tyler-wadekamper.github.io/ff-game/

The URL above is the expected address, **not proof of a completed deployment**. Verify the live page before announcing publication. GitHub's official setup instructions require choosing a publishing source: [Configure a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site). We do not change a private repository to public automatically.

The same `_site/` directory can be uploaded to other free static hosts. `reports/fourth-forever-web.zip` is a portable site bundle for a manual upload if repository Pages access is unavailable.

## Validation

The static browser test serves the actual build at `/ff-game/`, verifies relative assets and the PWA, drafts all 192 players, reloads offline, plays all 18 weeks without a server, and restores a full backup in another browser context. It checks JavaScript and HTTP errors. Evidence is retained in `reports/static_browser_checks.json`.
