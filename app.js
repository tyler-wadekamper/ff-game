const browserMode = globalThis.FF_MODE === 'browser';
const $ = (s) => document.querySelector(s);
let catalog,
  players,
  state,
  credentials,
  busy = false,
  route = 'draft',
  position = 'ALL',
  query = '',
  limit = 50,
  rosterTab = 'roster',
  reviewWeek = null,
  installPrompt = null;
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX'];
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const num = (v, d = 1) => Number(v ?? 0).toFixed(d),
  money = (v) => '$' + v;
const team = () => state.teams[state.human],
  p = (id) => players.get(id);
const posBadge = (pos) => `<span class="pos ${pos}">${pos}</span>`;
const initials = (name) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((x) => x[0])
    .join('');
const nameButton = (id) =>
  `<button class="player-name" data-profile="${id}">${esc(p(id).name)}</button>`;
const icon = (name) =>
  ({
    draft:
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    team: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
    waivers: '<path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/>',
    league:
      '<path d="M8 3h8v8a4 4 0 0 1-8 0zM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 3v6m-4 0h8"/>',
    settings:
      '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>',
  })[name] ?? '';
const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icon(name)}</svg>`;
function toast(message, error = false) {
  const e = $('#toast');
  e.textContent = message;
  e.className = error ? 'error' : '';
  e.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => {
      e.style.display = 'none';
    },
    error ? 7000 : 3500,
  );
}
function showDialog(title, body, actions = '') {
  const d = $('#dialog');
  d.style.width = '';
  d.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="close" data-close aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div>${actions ? `<div class="modal-actions">${actions}</div>` : ''}`;
  if (!d.open) d.showModal();
}
function closeDialog() {
  if ($('#dialog').open) $('#dialog').close();
}
async function request(url, options = {}) {
  const response = await (globalThis.FF_API ?? fetch)(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(credentials ? { Authorization: 'Bearer ' + credentials.token } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.state) state = data.state;
    throw new Error(data.error ?? 'The server could not complete that move.');
  }
  return data;
}
function saved() {
  try {
    return JSON.parse(localStorage.getItem('ff-leagues') ?? '[]');
  } catch {
    return [];
  }
}
function remember() {
  const list = saved().filter((x) => x.id !== credentials.id);
  list.unshift({ ...credentials, name: team().name, date: new Date().toISOString() });
  localStorage.setItem('ff-leagues', JSON.stringify(list.slice(0, 20)));
  localStorage.setItem('ff-current', JSON.stringify(credentials));
}
async function action(value) {
  if (busy) return false;
  busy = true;
  renderBusy();
  try {
    const before = state.phase;
    const data = await request(`/api/leagues/${credentials.id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ revision: state.revision, action: value }),
    });
    state = data.state;
    if (before === 'draft' && state.phase !== 'draft') {
      route = 'team';
      reviewWeek = null;
      toast('Draft complete. Your season starts here.');
    }
    render();
    return true;
  } catch (error) {
    toast(error.message, true);
    render();
    return false;
  } finally {
    busy = false;
    renderBusy();
  }
}
function renderBusy() {
  document
    .querySelectorAll(
      '[data-move], [data-advance], [data-submit-claim], [data-create], [data-lineup-slot]',
    )
    .forEach((b) => (b.disabled = busy));
  let bar = $('.busy-indicator');
  if (busy && !bar) {
    bar = document.createElement('div');
    bar.className = 'busy-indicator';
    document.body.appendChild(bar);
  }
  if (!busy && bar) bar.remove();
}
function setupForm() {
  return `<form id="setup-form"><label class="form-field">YOUR TEAM NAME<input name="name" id="team-name" placeholder="Your Franchise" value="The Sunday Club" maxlength="32" required autocomplete="off"></label><label class="form-field">DRAFT POSITION<select name="slot" id="draft-slot">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${i === 6 ? 'selected' : ''}>Pick ${i + 1} of 12${i === 6 ? ' · balanced start' : ''}</option>`).join('')}</select></label><button class="btn primary" data-create type="submit">Enter the draft room <span>↗</span></button></form>`;
}
function welcome() {
  $('#app').innerHTML =
    `<main class="welcome" id="main"><div class="welcome-top"><div class="brand-mark">F</div><div class="brand">FOURTH &<br>FOREVER</div></div><div class="welcome-grid"><div><p class="eyebrow">THE SINGLE-PLAYER FANTASY FOOTBALL SIM</p><h1>A whole season.<br><em>Your call.</em></h1><p class="lead">Build your team. Outsmart eleven managers. Turn a draft-day hunch into a championship, one Sunday at a time.</p><div class="pills"><span>12 teams · full PPR</span><span>972 fictional players</span><span>Play at your pace</span></div><p class="footnote">History gives you clues. The next season is yours to discover.</p></div><div class="card setup"><h2>Your franchise starts here.</h2>${setupForm()}<p class="footnote">No account or payment needed for this prototype. ${browserMode ? 'Your league saves on this device. Export a recovery file before clearing browser data.' : 'Your league saves automatically in this browser and on this server. An internet connection is required to play.'}</p>${saved().length ? '<button class="text-link" data-settings>Resume a saved league →</button>' : ''}</div></div></main>`;
}
async function create() {
  if (busy) return;
  busy = true;
  renderBusy();
  const form = $('#setup-form'),
    options = { name: form.elements.name.value, slot: Number(form.elements.slot.value) };
  try {
    const data = await request('/api/leagues', { method: 'POST', body: JSON.stringify(options) });
    credentials = { id: data.id, token: data.token };
    state = data.state;
    route = 'draft';
    position = 'ALL';
    query = '';
    remember();
    closeDialog();
    render();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    renderBusy();
  }
}
function shell(content) {
  const phase =
    state.phase === 'draft'
      ? 'Draft day'
      : state.phase === 'complete'
        ? 'Season complete'
        : `Week ${state.week} of 18`;
  $('#app').innerHTML =
    `<div class="app-layout"><aside class="sidebar"><div><div class="brand"><div class="brand-mark">F</div><span>FOURTH &<br>FOREVER</span></div><div class="edition">FANTASY, ON YOUR TERMS.</div></div><div class="league-mini"><p class="eyebrow">YOUR FRANCHISE</p><strong>${esc(team().name)}</strong><p class="muted" style="font-size:11px;margin-top:7px">${phase} · 12-team league</p></div><nav class="nav" aria-label="Game navigation">${[
      ['draft', 'Draft room'],
      ['team', 'My team'],
      ['waivers', 'Waivers'],
      ['league', 'League'],
    ]
      .map(
        ([key, label]) =>
          `<button data-route="${key}" class="${route === key ? 'active' : ''}" ${state.phase === 'draft' && key !== 'draft' && key !== 'league' ? 'aria-disabled="true"' : ''}>${svg(key)}<span>${label}</span></button>`,
      )
      .join(
        '',
      )}</nav><div class="sidebar-foot"><span class="saved-dot"></span>Progress saved automatically<br><button class="text-link" data-rules>League rules ↗</button><p style="margin-top:17px;color:#60717e">Made-up players.<br>Very real decisions.</p></div></aside><div><header class="topbar"><div><span class="brand-mobile">F&F</span> <span class="hide-small">/ &nbsp; ${esc(team().name)} &nbsp; / &nbsp;</span><strong>${phase}</strong></div><div class="top-actions"><span class="tag">SOLO LEAGUE</span><button class="text-link hide-small" data-install>Install app</button><button class="round-icon" data-settings aria-label="Settings and saved leagues">${svg('settings')}</button></div></header><main class="content" id="main" tabindex="-1">${content}</main></div></div>`;
}
function render() {
  if (!catalog) return;
  if (!state) {
    welcome();
    return;
  }
  if (route === 'draft') shell(draftPage());
  if (route === 'team') shell(teamPage());
  if (route === 'waivers') shell(waiverPage());
  if (route === 'league') shell(leaguePage());
  if (route === 'draft' || route === 'waivers') updateTable();
  renderBusy();
}
function filters() {
  return `<div class="filters"><div class="position-tabs" aria-label="Player position">${['ALL', 'QB', 'RB', 'WR', 'TE'].map((pos) => `<button data-position="${pos}" class="${position === pos ? 'active' : ''}">${pos === 'ALL' ? 'All players' : pos}</button>`).join('')}</div><input class="search" id="search" type="search" placeholder="Search players…" value="${esc(query)}" aria-label="Search players by name or ID"></div>`;
}
function tableFrame() {
  return `<div class="table-wrap"><table class="player-table"><thead><tr><th>${route === 'draft' ? '' : 'FA'}</th><th>Player</th><th class="num">ADP</th><th class="num hide-mobile">Age</th><th class="num hide-medium">Bye</th><th class="num">${route === 'draft' ? 'Last PPR' : 'Proj.'}</th><th></th></tr></thead><tbody id="player-rows"></tbody></table></div><button class="load-more" data-more id="more">Load more players</button>`;
}
function updateTable() {
  const target = $('#player-rows');
  if (!target) return;
  const owned = new Set(state.teams.flatMap((t) => t.roster));
  let pool = catalog.players.filter(
    (x) =>
      !owned.has(x.id) &&
      (position === 'ALL' || x.position === position) &&
      `${x.name} ${x.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (route === 'waivers')
    pool.sort(
      (a, b) =>
        (state.playerStatus[b.id] === 'ACTIVE' ? state.projections[b.id] : 0) -
          (state.playerStatus[a.id] === 'ACTIVE' ? state.projections[a.id] : 0) || a.adp - b.adp,
    );
  target.innerHTML =
    pool
      .slice(0, limit)
      .map((x) => {
        const last = x.history.at(-1),
          st = state.playerStatus[x.id],
          locked = (state.availableAt[x.id] ?? 1) > state.week;
        return `<tr><td>${route === 'draft' ? `<button class="star ${state.queue.includes(x.id) ? 'selected' : ''}" data-queue="${x.id}" aria-label="${state.queue.includes(x.id) ? 'Remove' : 'Queue'} ${esc(x.name)}" aria-pressed="${state.queue.includes(x.id)}">${state.queue.includes(x.id) ? '★' : '☆'}</button>` : posBadge(x.position)}</td><td>${nameButton(x.id)}<div class="subline">${route === 'draft' ? posBadge(x.position) : ''}<span>Club ${String(x.club).padStart(2, '0')}</span>${route === 'waivers' && st !== 'ACTIVE' ? `<span class="availability ${st === 'BYE' ? 'bye' : 'out'}">${st}</span>` : ''}${locked ? '<span class="availability out">Clears next week</span>' : ''}</div></td><td class="num muted">${num(x.adp)}</td><td class="num hide-mobile muted">${x.age}</td><td class="num hide-medium muted">${x.bye}</td><td class="num">${route === 'draft' ? num(last.ppr) : num(st === 'ACTIVE' ? state.projections[x.id] : 0)}</td><td>${route === 'draft' ? `<button class="draft-btn" data-draft="${x.id}" data-move>Draft</button>` : `<button class="draft-btn" data-acquire="${x.id}" ${locked || state.phase === 'complete' ? 'disabled' : ''}>${state.waiversProcessed || state.week === 1 ? 'Add' : 'Claim'}</button>`}</td></tr>`;
      })
      .join('') ||
    '<tr><td colspan="7" class="empty-state">No players match this search.</td></tr>';
  $('#more').style.display = pool.length > limit ? 'block' : 'none';
  $('#more').textContent = `Show more · ${Math.min(limit, pool.length)} of ${pool.length}`;
  const count = $('#pool-count');
  if (count) count.textContent = `${pool.length} available`;
}
function rosterMini() {
  const ids = rosterTab === 'roster' ? team().roster : state.queue;
  return `<div class="card draft-side"><div class="card-head"><div class="mini-tabs"><button data-roster-tab="roster" class="${rosterTab === 'roster' ? 'active' : ''}">Your roster <small>${team().roster.length}/16</small></button><button data-roster-tab="queue" class="${rosterTab === 'queue' ? 'active' : ''}">Queue <small>${state.queue.length}</small></button></div></div><div class="roster-progress"><span style="width:${(100 * team().roster.length) / 16}%"></span></div>${
    rosterTab === 'roster'
      ? `<div class="needs">${['QB', 'RB', 'WR', 'TE']
          .map((pos) => {
            const n = team().roster.filter((id) => p(id).position === pos).length;
            return `<span class="need ${n >= { QB: 1, RB: 2, WR: 2, TE: 1 }[pos] ? 'done' : ''}">${pos} ${n}</span>`;
          })
          .join('')}</div>`
      : ''
  }<div class="mini-roster">${ids.map((id, i) => `<div class="mini-player"><span class="index">${i + 1}</span>${posBadge(p(id).position)}<div>${nameButton(id)}</div><span class="adp">${num(p(id).adp, 0)}</span></div>`).join('')}${rosterTab === 'roster' ? Array.from({ length: 16 - ids.length }, (_, i) => `<div class="mini-player"><span class="index">${ids.length + i + 1}</span><span class="empty">Waiting for your pick</span></div>`).join('') : !ids.length ? '<div class="empty-state"><strong>Your shortlist, your call.</strong>Star a player to queue them. Auto-pick follows your queue in order.</div>' : ''}</div></div>`;
}
function draftPage() {
  if (state.phase !== 'draft')
    return `<div class="page-heading"><div><p class="eyebrow">192 PICKS. 12 FRANCHISES.</p><h1>The draft is in the books.</h1><p>Your roster is ready. Time to find out what it can do.</p></div><button class="btn primary" data-route="team">Go to my team →</button></div>${draftBoard()}<div class="card feed">${state.picks
      .slice(-5)
      .map(
        (x) =>
          `<p>Pick ${x.pick} · <strong>${esc(state.teams[x.team].name)}</strong> selected ${esc(p(x.player).name)} (${p(x.player).position})</p>`,
      )
      .join('')}</div>`;
  const round = Math.floor(state.pick / 12) + 1,
    current = state.pick + 1;
  const strip = Array.from({ length: 12 }, (_, i) => Math.max(0, state.pick - 3) + i)
    .filter((i) => i < 192)
    .map((i) => {
      const t = state.teams[Math.floor(i / 12) % 2 ? 11 - (i % 12) : i % 12],
        choice = state.picks[i];
      return `<div class="pick-card ${i === state.pick ? 'current' : ''} ${i < state.pick ? 'past' : ''}" ${i === state.pick ? 'id="current-pick"' : ''}><div class="pick-num"><span>${String(Math.floor(i / 12) + 1).padStart(2, '0')}.${String((i % 12) + 1).padStart(2, '0')}</span><span>${i + 1}</span></div><strong>${t.id === state.human ? 'You' : esc(t.name)}</strong>${choice ? `<span class="player-position ${p(choice.player).position}" style="color:var(--position-color)">${p(choice.player).position} · ${esc(p(choice.player).name.split(' ').at(-1))}</span>` : `<span class="muted">${i === state.pick ? 'On the clock' : 'Up next'}</span>`}</div>`;
    })
    .join('');
  return `<div class="page-heading"><div><h1>Draft room<span style="color:var(--lime)">.</span></h1><p>The board is moving. Trust your homework.</p></div><div class="heading-actions"><button class="btn ghost" data-board>Draft board</button><button class="btn ghost" data-finish>Finish with auto-draft</button></div></div><div class="pick-strip">${strip}</div><div class="on-clock"><div><strong>You’re on the clock <span class="muted">· Pick ${String(round).padStart(2, '0')}.${String((state.pick % 12) + 1).padStart(2, '0')}</span></strong><p>Round ${round} of 16 · ${current} of 192 · No timer. Make your pick.</p></div><button class="btn primary" data-move data-autopick>Auto-pick</button></div><div class="draft-layout"><div><div class="card"><div class="card-head"><h2>Available players</h2><small id="pool-count"></small></div>${filters()}${tableFrame()}</div><div class="card feed"><p class="eyebrow" style="margin-bottom:5px">LATEST PICKS</p>${
    state.picks
      .slice(-3)
      .reverse()
      .map(
        (x) =>
          `<p><strong>${esc(state.teams[x.team].name)}</strong> drafted ${esc(p(x.player).name)} <span class="muted">· ${p(x.player).position} · #${x.pick}</span></p>`,
      )
      .join('') || '<p>The room is ready for its first pick.</p>'
  }</div></div>${rosterMini()}</div>`;
}
function draftBoard() {
  return `<div class="card table-wrap"><div class="draft-board"><div></div>${state.teams.map((t) => `<div class="board-head">${t.id === state.human ? 'YOU · ' : ''}${esc(t.name)}</div>`).join('')}${Array.from(
    { length: 16 },
    (_, round) =>
      `<div class="board-round">${round + 1}</div>${state.teams
        .map((t) => {
          const choice = state.picks.find((x) => x.round === round + 1 && x.team === t.id);
          return choice
            ? `<button class="board-cell ${p(choice.player).position}" data-profile="${choice.player}"><span>${choice.pick} · ${p(choice.player).position}</span><strong>${esc(p(choice.player).name)}</strong><span>ADP ${num(p(choice.player).adp)}</span></button>`
            : '<div class="board-cell"></div>';
        })
        .join('')}`,
  ).join('')}</div></div>`;
}
function weekLabel(w) {
  return w <= 14
    ? 'Regular season'
    : w === 15
      ? 'Playoff quarterfinals'
      : w === 16
        ? 'Playoff semifinals'
        : w === 17
          ? 'Championship week'
          : 'Victory lap · exhibition';
}
function weeks() {
  return `<div class="week-strip" aria-label="Season weeks">${Array.from({ length: 18 }, (_, i) => {
    const w = i + 1;
    return `<button class="week-dot ${w === state.week ? 'current' : ''} ${w < state.week ? 'past' : ''} ${w >= 15 ? 'playoff' : ''} ${w === reviewWeek ? 'selected' : ''}" data-week="${w}" ${w > state.week ? 'disabled' : ''} aria-label="Week ${w}${w === state.week ? ', current' : ''}">${w}</button>`;
  }).join('')}</div>`;
}
function myGame(w) {
  return (
    state.results.find((g) => g.week === w && (g.a === state.human || g.b === state.human)) ??
    (w === state.week
      ? state.matchups.find((g) => g.a === state.human || g.b === state.human)
      : null)
  );
}
function liveProjection(t) {
  return t.lineup.reduce(
    (sum, id) => sum + (id && state.playerStatus[id] === 'ACTIVE' ? state.projections[id] : 0),
    0,
  );
}
function matchupHero(game, w) {
  if (!game)
    return `<div class="notice success">You earned a first-round playoff bye. Your next championship matchup is Week 16. You can still manage your roster and play out this week.</div>`;
  const other = state.teams[game.a === state.human ? game.b : game.a],
    done = w < state.week;
  const us = done ? (game.a === state.human ? game.sa : game.sb) / 100 : liveProjection(team());
  const them = done ? (game.a === state.human ? game.sb : game.sa) / 100 : liveProjection(other);
  return `<div class="matchup-hero"><div class="team-tile"><div class="avatar">${esc(initials(team().name))}</div><div><h2>${esc(team().name)}</h2><p>${team().wins}–${team().losses}${team().ties ? '–' + team().ties : ''} · YOUR TEAM</p><div class="hero-score">${num(us)}</div></div></div><div class="versus"><p class="eyebrow">${done ? 'FINAL' : 'PROJECTED'}</p><strong>VS</strong><p class="eyebrow">WEEK ${w}</p></div><div class="team-tile right"><div class="avatar rival">${esc(initials(other.name))}</div><div><h2>${esc(other.name)}</h2><p>${esc(other.profile?.style ?? 'Your franchise')}</p><div class="hero-score">${num(them)}</div></div></div></div>`;
}
function teamPage() {
  const done = state.phase === 'complete',
    w = reviewWeek ?? Math.min(state.week, 18),
    historical = w < state.week;
  const game = myGame(w),
    ourLineup =
      historical && game
        ? game.a === state.human
          ? game.aLineup
          : game.bLineup
        : historical
          ? (state.lineupHistory?.[w - 1]?.[state.human] ?? team().lineup)
          : team().lineup;
  const starting = new Set(team().lineup.filter(Boolean)),
    bench = team().roster.filter((id) => !starting.has(id));
  const issues = team().lineup.filter((id) => !id || state.playerStatus[id] !== 'ACTIVE').length;
  const rank = state.standings.indexOf(state.human) + 1;
  return `<div class="page-heading"><div><p class="eyebrow" style="margin-bottom:7px">${weekLabel(w)}</p><h1>${done ? 'What a season.' : historical ? `Week ${w} recap` : 'Your next move.'}</h1><p>${historical ? 'The scores and lineups below are locked to that week.' : 'Set your starters. Check the wire. Let Sunday happen.'}</p></div><div class="heading-actions">${historical && !done ? '<button class="btn" data-live>Back to this week</button>' : ''}${!historical && !done ? `<button class="btn ghost" data-optimize data-move>Set best lineup</button><button class="btn primary" data-advance data-move>Play Week ${state.week} →</button>` : ''}${done ? '<button class="btn primary" data-new>Start another season ↗</button>' : ''}</div></div>${state.champion !== null ? championBanner() : ''}${weeks()}${!historical && issues ? `<div class="notice">${issues} starting slot${issues === 1 ? ' needs' : 's need'} attention: a player is out, on bye, or the slot is empty. Set your lineup or find cover on waivers.</div>` : ''}${state.week === 18 && !done ? '<div class="notice success">The championship is settled. Week 18 is a victory-lap exhibition: it will not change the champion or regular-season standings.</div>' : ''}${matchupHero(game, w)}<div class="two-column"><div class="card"><div class="card-head"><h2>${historical ? 'Your locked starters' : 'Starting lineup'}</h2><small>${historical ? 'Actual PPR' : 'Projected PPR'}</small></div><div class="lineup-list">${SLOTS.map(
    (slot, i) => {
      const id = ourLineup[i],
        x = id ? p(id) : null,
        st = id ? state.playerStatus[id] : '';
      return `<div class="lineup-row"><span class="slot-tag">${slot}</span><div>${
        historical
          ? id
            ? nameButton(id)
            : '<span class="muted">Empty slot</span>'
          : `<select data-lineup-slot="${i}" aria-label="${slot} starter ${i + 1}"><option value="">Empty slot</option>${team()
              .roster.filter((pid) =>
                slot === 'FLEX' ? p(pid).position !== 'QB' : p(pid).position === slot,
              )
              .map(
                (pid) =>
                  `<option value="${pid}" ${pid === id ? 'selected' : ''}>${esc(p(pid).name)}</option>`,
              )
              .join('')}</select>`
      }${x ? `<div class="subline">${posBadge(x.position)}<button class="text-link" data-profile="${id}">Player card ↗</button></div>` : ''}</div><span class="availability ${st === 'OUT' ? 'out' : st === 'BYE' ? 'bye' : ''}">${historical ? '' : st === 'ACTIVE' ? 'Ready' : st === 'BYE' ? 'BYE WEEK' : st === 'OUT' ? 'OUT · week ' + w : ''}</span><span class="projection">${historical ? num(id ? (state.pastPoints[id][w - 1] ?? 0) / 100 : 0) : num(id && st === 'ACTIVE' ? state.projections[id] : 0)}</span></div>`;
    },
  ).join(
    '',
  )}</div><div style="padding:15px 18px;font-size:10px" class="muted">${historical ? 'Past lineup changes cannot alter these scores.' : 'Projections use visible history and completed weeks. OUT is current-week availability, not a medical diagnosis.'}</div></div><div><div class="card"><div class="card-head"><h2>Your bench</h2><small>${bench.length} players</small></div><div class="bench">${bench.map((id) => `<div class="bench-row">${posBadge(p(id).position)}<div class="grow">${nameButton(id)}<div class="subline">${state.playerStatus[id] === 'ACTIVE' ? 'Ready' : state.playerStatus[id]} · Bye ${p(id).bye}</div></div><span class="num muted">${num(state.projections[id])}</span>${!done && !historical ? `<button class="btn small ghost" data-start="${id}">Start</button>` : ''}</div>`).join('')}</div></div><div class="card feed"><p class="eyebrow">FRANCHISE CHECK-IN</p><p><strong>${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'}</strong> in the standings · <strong>${money(team().faab)}</strong> FAAB remaining</p><p>${state.waiversProcessed ? 'This week’s waivers have processed. Unclaimed players are free agents.' : 'Waivers process before kickoff. You can submit claims before playing the week.'}</p><button class="text-link" data-route="waivers">Go to the waiver wire →</button></div></div></div>`;
}
function waiverPage() {
  const free = state.waiversProcessed || state.week === 1;
  return `<div class="page-heading"><div><h1>The waiver wire<span style="color:var(--lime)">.</span></h1><p>Find the next difference-maker before everyone else does.</p></div>${!state.waiversProcessed && state.phase === 'season' ? '<button class="btn primary" data-waivers data-move>Process waivers →</button>' : ''}</div><div class="stat-cards"><div class="stat-card"><p class="eyebrow">YOUR FAAB</p><strong>${money(team().faab)}<span class="muted" style="font-size:14px"> / $100</span></strong><p>Spend only when a claim wins</p></div><div class="stat-card"><p class="eyebrow">CLAIM WINDOW</p><strong style="font-size:22px">${state.phase === 'complete' ? 'Closed' : free ? 'Free agents' : 'Bids open'}</strong><p>${free ? 'Unclaimed players cost $0' : 'Sealed bids · highest offer wins'}</p></div><div class="stat-card"><p class="eyebrow">YOUR CLAIMS</p><strong>${state.claims.length}</strong><p>Higher bids process first</p></div></div>${!free ? '<div class="notice success">Submit an add/drop and a whole-dollar bid. All 11 managers can bid too. Ties go to the lower-ranked team; only winning bids cost FAAB. Waivers also run automatically when you play this week.</div>' : ''}${state.claims.length ? `<div class="card" style="margin-bottom:22px"><div class="card-head"><h2>Pending claims</h2><small>Your bids are sealed</small></div>${state.claims.map((c) => `<div class="claim-row"><span class="bid">${money(c.bid)}</span><div class="grow"><strong>${esc(p(c.add).name)}</strong><p>Drop ${esc(p(c.drop).name)}</p></div><button class="btn small ghost" data-cancel="${c.add}" data-move>Cancel</button></div>`).join('')}</div>` : ''}<div class="draft-layout"><div class="card"><div class="card-head"><h2>Available players</h2><small id="pool-count"></small></div>${filters()}${tableFrame()}</div><div><div class="card"><div class="card-head"><h2>Recent transactions</h2></div>${
    state.transactions
      .slice(-10)
      .reverse()
      .map(
        (t) =>
          `<div class="claim-row"><div><strong>${esc(state.teams[t.team].name)}</strong><p><span style="color:var(--lime)">+ ${esc(p(t.add).name)}</span><br>− ${esc(p(t.drop).name)}<br>Week ${t.week} · ${t.source} · ${money(t.bid)}</p></div></div>`,
      )
      .join('') || '<div class="empty-state">The wire is quiet. You can change that.</div>'
  }</div></div></div>`;
}
function championBanner() {
  return `<div class="champion"><span class="trophy" aria-hidden="true">♜</span><div><p class="eyebrow">FOURTH & FOREVER CHAMPION</p><h2>${esc(state.teams[state.champion].name)}</h2><p>${state.champion === state.human ? 'You made the calls. You brought it home.' : 'A season earned, one decision at a time.'} Championship settled in Week 17.</p></div></div>`;
}
function bracket() {
  if (!state.playoffs)
    return '<div class="empty-state">The top six qualify after Week 14. Seeds 1 and 2 earn a first-round bye.</div>';
  return `<div class="bracket">${[
    [15, 'Quarterfinals'],
    [16, 'Semifinals'],
    [17, 'Championship'],
  ]
    .map(([w, label]) => {
      let games = state.results.filter(
        (g) => g.week === w && ['Quarterfinal', 'Semifinal', 'Championship'].includes(g.kind),
      );
      if (w === state.week)
        games = state.matchups.filter((g) =>
          ['Quarterfinal', 'Semifinal', 'Championship'].includes(g.kind),
        );
      return `<div class="bracket-round"><h3>Week ${w} · ${label}</h3>${games.length ? games.map((g) => `<div class="bracket-game">${[g.a, g.b].map((id, i) => `<p class="${g.winner === id ? 'winner' : ''}"><span>${state.playoffs.seeds.indexOf(id) + 1}. ${esc(state.teams[id].name)}</span><strong>${g.sa !== undefined ? num((i === 0 ? g.sa : g.sb) / 100) : '—'}</strong></p>`).join('')}</div>`).join('') : '<div class="bracket-game muted">Matchup to be decided</div>'}${
        w === 15
          ? `<p class="muted" style="font-size:10px">Byes: ${state.playoffs.seeds
              .slice(0, 2)
              .map((id) => esc(state.teams[id].name))
              .join(' & ')}</p>`
          : ''
      }</div>`;
    })
    .join('')}</div>`;
}
function leaguePage() {
  return `<div class="page-heading"><div><h1>The league<span style="color:var(--lime)">.</span></h1><p>Eleven personalities. One trophy. Make your season count.</p></div><button class="btn ghost" data-rules>League rules</button></div>${state.champion !== null ? championBanner() : ''}<div class="two-column"><div class="card"><div class="card-head"><h2>Standings</h2><small>${state.week > 14 ? 'Final regular season' : 'Regular season'}</small></div><div class="table-wrap"><table class="standings"><thead><tr><th>#</th><th>Team</th><th>W–L–T</th><th>PF</th><th class="hide-mobile">FAAB</th></tr></thead><tbody>${state.standings
    .map((id, i) => {
      const t = state.teams[id];
      return `<tr class="${id === state.human ? 'you' : ''}"><td class="seed">${i + 1}${i < 6 ? ' ·' : ''}</td><td><button class="team-button" data-team="${id}">${esc(t.name)}${id === state.human ? ' <span style="color:var(--lime);font-size:9px">YOU</span>' : ''}</button></td><td>${t.wins}–${t.losses}–${t.ties}</td><td class="number">${num(t.pf / 100)}</td><td class="hide-mobile">${money(t.faab)}</td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div></div><div class="card"><div class="card-head"><h2>Your season</h2><small>${state.results.filter((g) => g.a === state.human || g.b === state.human).length} games played</small></div>${
    state.results
      .filter((g) => g.a === state.human || g.b === state.human)
      .map((g) => {
        const won = g.winner === state.human,
          tie = g.winner === null,
          other = g.a === state.human ? g.b : g.a;
        return `<button class="schedule-row" style="width:100%;text-align:left" data-recap="${g.week}"><span class="${tie ? 'result-t' : won ? 'result-w' : 'result-l'}">${tie ? 'T' : won ? 'W' : 'L'}</span><span>${esc(state.teams[other].name)}<br><small>Week ${g.week} · ${g.kind}</small></span><strong class="number">${num((g.a === state.human ? g.sa : g.sb) / 100)} – ${num((g.a === state.human ? g.sb : g.sa) / 100)}</strong></button>`;
      })
      .join('') || '<div class="empty-state">Your story starts with the draft.</div>'
  }</div></div><div class="card" style="margin-top:22px"><div class="card-head"><h2>The championship chase</h2><small>6 teams · Weeks 15–17</small></div>${bracket()}</div><h2 class="section-label">Meet the managers</h2><div class="bot-grid">${state.teams
    .filter((t) => t.id !== state.human)
    .map(
      (t) =>
        `<div class="bot-card"><h3>${esc(t.name)}</h3><span class="style">${esc(t.profile.style)} · ${t.profile.skill >= 0.8 ? 'Disciplined' : t.profile.skill >= 0.5 ? 'Competitive' : 'Unpredictable'}</span><p>${esc(t.profile.note)}</p></div>`,
    )
    .join('')}</div>`;
}
async function profile(id) {
  const x = p(id),
    h = x.history,
    last = h.at(-1),
    owned = state.teams.find((t) => t.roster.includes(id));
  showDialog(
    x.name,
    `${posBadge(x.position)} <span class="muted" style="font-size:12px">Age ${x.age} · Club ${x.club} · ${owned ? esc(owned.name) : 'Free agent'}</span><div class="profile-stats" style="margin-top:23px"><div><small>MARKET ADP</small><strong>${num(x.adp)}</strong></div><div><small>LAST SEASON</small><strong>${num(last.ppr)}</strong></div><div><small>WEEKLY EST.</small><strong>${num(state.projections[id])}</strong></div><div><small>BYE WEEK</small><strong>${x.bye}</strong></div></div><h3>Career history · PPR points</h3><div class="history-bars">${h.map((row) => `<div class="history-bar" style="height:${Math.max(3, (100 * row.ppr) / Math.max(...h.map((z) => z.ppr), 1))}%" title="Age ${row.age}: ${num(row.ppr)} PPR"><span>${row.age}</span></div>`).join('')}</div><div class="table-wrap" style="margin-top:34px"><table class="profile-table"><thead><tr><th>Age</th><th>Games</th><th>PPR</th><th>Pass yd</th><th>Rush yd</th><th>Rec yd</th><th>Rec</th></tr></thead><tbody>${h.map((row) => `<tr><td>${row.age}</td><td>${row.games}</td><td>${num(row.ppr)}</td><td>${row.passing_yards}</td><td>${row.rushing_yards}</td><td>${row.receiving_yards}</td><td>${row.receptions}</td></tr>`).join('')}</tbody></table></div><h3 style="margin-top:23px">This season</h3><div id="player-weeks" class="muted" style="font-size:12px;margin-top:12px">Loading completed games…</div><p class="footnote muted" style="font-size:10px;margin-top:18px">Fictional identity. Histories and seasons come from the empirical player generator. Scouting estimates are uncertain, and never use future results.</p>`,
  );
  try {
    const data = await request(`/api/leagues/${credentials.id}/players/${id}`);
    const e = $('#player-weeks');
    if (!e) return;
    e.innerHTML = data.weeks.length
      ? `<div class="table-wrap"><table class="profile-table"><thead><tr><th>Week</th><th>Status</th><th>PPR</th><th>Pass yd</th><th>Rush yd</th><th>Rec yd</th><th>TD</th></tr></thead><tbody>${data.weeks.map((row, i) => `<tr><td>${i + 1}</td><td>${i + 1 === x.bye ? 'BYE' : row.at(-1) ? 'Played' : 'Out'}</td><td>${num(row[0] / 100)}</td><td>${row[3]}</td><td>${row[7]}</td><td>${row[11]}</td><td>${row[4] + row[8] + row[12]}</td></tr>`).join('')}</tbody></table></div>`
      : 'The season hasn’t started. Future results stay under wraps.';
  } catch (e) {
    const el = $('#player-weeks');
    if (el) el.textContent = e.message;
  }
}
function legalDrop(add, drop) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of team()
    .roster.filter((x) => x !== drop)
    .concat(add))
    counts[p(id).position]++;
  return (
    counts.QB >= 1 &&
    counts.QB <= 3 &&
    counts.RB >= 2 &&
    counts.WR >= 2 &&
    counts.TE >= 1 &&
    counts.RB + counts.WR + counts.TE >= 7
  );
}
function acquire(id) {
  const free = state.waiversProcessed || state.week === 1,
    x = p(id),
    dropOptions = [...team().roster]
      .filter((drop) => legalDrop(id, drop))
      .sort((a, b) => state.projections[a] - state.projections[b]);
  showDialog(
    free ? 'Make a roster move' : 'Submit a waiver claim',
    `<p><strong style="color:var(--text)">${esc(x.name)}</strong> · ${x.position} · ${num(state.projections[id])} projected PPR</p><form id="claim-form" data-add="${id}" data-free="${free}"><label class="form-field">DROP A PLAYER<select name="drop" id="drop-player">${dropOptions.map((pid) => `<option value="${pid}">${esc(p(pid).name)} · ${p(pid).position} · ${num(state.projections[pid])} est.${team().lineup.includes(pid) ? ' · STARTER' : ''}</option>`).join('')}</select></label>${free ? '<div class="notice success">Free-agent pickup · $0. The dropped player becomes available next week.</div>' : `<label class="form-field">SEALED BID · ${money(team().faab)} AVAILABLE<input type="number" name="bid" id="waiver-bid" min="0" max="${team().faab}" step="1" value="${Math.min(5, team().faab)}" required></label><p class="muted" style="font-size:11px;margin-bottom:20px">Highest bid wins. Losing claims cost nothing. Multiple bids can share a drop as alternatives; higher bids process first.</p>`}<button class="btn primary" data-submit-claim type="submit">${free ? 'Add player · $0' : 'Submit sealed claim'}</button></form>`,
  );
}
function showRules() {
  showDialog(
    'Your league, explained.',
    `<p>A season you can play on your own schedule.</p><ul class="rule-list"><li>12 teams. One human manager and eleven distinct bot managers.</li><li>16-round snake draft. 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX (RB/WR/TE), plus 8 bench players.</li><li>Full PPR: catches 1; passing yards .04; rushing/receiving yards .1; passing TD 4; rushing/receiving TD 6; interceptions/lost offensive fumbles −2. No kickers, defenses, return or two-point bonuses.</li><li>18 NFL calendar weeks; each schedule club has one bye. Current-week OUT/BYE availability is known before kickoff.</li><li>Regular season: Weeks 1–14. Top six advance; top two get a Week 15 playoff bye. Semifinals Week 16, title Week 17. Week 18 is an exhibition victory lap.</li><li>Regular-season ties count as ties. Standings break ties by points for, then draft slot. Playoff ties advance the higher regular-season seed.</li><li>$100 FAAB. Sealed whole-dollar bids process highest first. Ties go to worse standings, then inverse draft order. Only winners pay. Dropped players clear next week.</li><li>Week 1 and post-waiver free agents cost $0. Waivers run once per week, manually or automatically before kickoff.</li><li>Lineups lock when you play the week. You can leave a slot empty or start an unavailable player, but they score zero. Past results cannot change.</li><li>${browserMode ? 'Saves stay on this device. Export a full recovery file to move to another browser or device.' : 'Autosaves belong to this server and browser. Export a recovery file to resume in another browser on this server.'} This prototype has no billing.</li></ul>`,
  );
}
function settings() {
  showDialog(
    'Commissioner’s desk',
    `<p>Your league saves after every move. ${browserMode ? 'Browser-edition recovery files contain your full save and can move it to another device.' : 'Recovery files contain a private access key; keep yours to yourself.'}</p><div class="actions" style="margin-bottom:24px">${state ? '<button class="btn" data-backup>Export recovery file</button>' : ''}<label class="btn" for="recovery-file">Import recovery file</label><input id="recovery-file" type="file" accept="application/json" hidden><button class="btn primary" data-new>Start another season</button></div><h3>Saved franchises</h3><div class="save-list">${
      saved()
        .map(
          (s) =>
            `<button data-resume="${s.id}">${esc(s.name)}<small>${new Date(s.date).toLocaleDateString()}${credentials?.id === s.id ? ' · Current franchise' : ''}</small></button>`,
        )
        .join('') || '<p class="muted">No saved leagues yet.</p>'
    }</div><button class="text-link" data-rules>Scoring, waivers and playoff rules ↗</button>`,
  );
}
async function resume(creds) {
  try {
    credentials = creds;
    const data = await request(`/api/leagues/${creds.id}`);
    state = data.state;
    route = state.phase === 'draft' ? 'draft' : 'team';
    position = 'ALL';
    query = '';
    reviewWeek = null;
    remember();
    closeDialog();
    render();
  } catch (e) {
    credentials = null;
    toast(e.message, true);
  }
}
async function playWeek() {
  const w = state.week,
    ok = await action({ type: 'advance' });
  if (!ok) return;
  reviewWeek = null;
  render();
  const game = state.results.find(
    (g) => g.week === w && (g.a === state.human || g.b === state.human),
  );
  const won = game?.winner === state.human;
  showDialog(
    game
      ? won
        ? 'That’s a win.'
        : game.winner === null
          ? 'All square.'
          : 'On to the next.'
      : 'A well-earned bye.',
    `<p>Week ${w} is in the books. Every lineup and score is now locked.</p>${game ? matchupHero(game, w) : '<div class="notice success">You advance to the semifinals. Use the extra week to prepare your roster.</div>'}${game?.tiebreak ? `<p>${game.tiebreak} wins the playoff tie.</p>` : ''}${state.champion !== null ? championBanner() : ''}<p>${state.phase === 'complete' ? 'Your season is complete. Review your results or start a fresh franchise.' : `Week ${state.week} is ready. Check byes and availability before the next kickoff.`}</p>`,
    '<button class="btn primary" data-close>Back to my team →</button>',
  );
}
document.addEventListener('submit', async (event) => {
  if (event.target.id === 'setup-form') {
    event.preventDefault();
    await create();
  }
  if (event.target.id === 'claim-form') {
    event.preventDefault();
    const f = event.target;
    const ok = await action({
      type: f.dataset.free === 'true' ? 'add' : 'claim',
      add: f.dataset.add,
      drop: f.elements.drop.value,
      bid: Number(f.elements.bid?.value ?? 0),
    });
    if (ok) {
      closeDialog();
      toast(
        f.dataset.free === 'true'
          ? 'Player added. Check your lineup.'
          : 'Claim submitted. Your bid is sealed.',
      );
    }
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'search') {
    query = event.target.value;
    limit = 50;
    updateTable();
  }
});
document.addEventListener('change', async (event) => {
  if (event.target.matches('[data-lineup-slot]')) {
    const i = Number(event.target.dataset.lineupSlot),
      id = event.target.value || null,
      lineup = [...team().lineup],
      old = lineup[i],
      previous = id ? lineup.indexOf(id) : -1;
    if (previous >= 0 && previous !== i)
      lineup[previous] =
        old &&
        (SLOTS[previous] === 'FLEX'
          ? p(old).position !== 'QB'
          : p(old).position === SLOTS[previous])
          ? old
          : null;
    lineup[i] = id;
    await action({ type: 'lineup', lineup });
  }
  if (event.target.id === 'recovery-file')
    try {
      const value = JSON.parse(await event.target.files[0].text());
      if (typeof value.id !== 'string' || typeof value.token !== 'string')
        throw new Error('Choose a Fourth & Forever recovery file.');
      if (browserMode) await globalThis.FF_IMPORT(value);
      await resume({ id: value.id, token: value.token });
    } catch (e) {
      toast(e.message, true);
    }
});
document.addEventListener('click', async (event) => {
  const el = event.target.closest('button,[data-close]');
  if (!el) return;
  const d = el.dataset;
  if ('close' in d) {
    closeDialog();
    return;
  }
  if ('settings' in d) {
    settings();
    return;
  }
  if ('rules' in d) {
    showRules();
    return;
  }
  if ('new' in d) {
    showDialog(
      'A fresh start.',
      `${setupForm()}<p class="muted" style="font-size:11px;margin-top:18px">Your previous franchise stays in saved leagues.</p>`,
    );
    return;
  }
  if ('resume' in d) {
    const s = saved().find((s) => s.id === d.resume);
    if (s) await resume(s);
    return;
  }
  if ('backup' in d) {
    const blob = new Blob(
        [
          JSON.stringify(
            browserMode ? await globalThis.FF_EXPORT(credentials) : credentials,
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
      a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fourth-forever-recovery.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  if ('install' in d) {
    if (installPrompt) {
      await installPrompt.prompt();
      installPrompt = null;
    } else
      showDialog(
        'Take your franchise with you.',
        `<p>On iPhone or iPad, open this game in Safari, tap Share, then “Add to Home Screen.” On supported desktop and Android browsers, use the address-bar install button.</p><p>${browserMode ? 'After the first full download, this edition works offline and saves on this device. Export a recovery file to move your franchise elsewhere.' : 'The app needs this server and an internet connection for game moves. Installing keeps the same saved franchise on this browser.'}</p>`,
      );
    return;
  }
  if (!state) return;
  if ('route' in d) {
    if (state.phase === 'draft' && ['team', 'waivers'].includes(d.route)) {
      toast('Finish the draft to open your lineup and waivers.');
      return;
    }
    route = d.route;
    query = '';
    position = 'ALL';
    limit = 50;
    reviewWeek = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if ('position' in d) {
    position = d.position;
    limit = 50;
    document
      .querySelectorAll('[data-position]')
      .forEach((b) => b.classList.toggle('active', b.dataset.position === position));
    updateTable();
    return;
  }
  if ('more' in d) {
    limit += 50;
    updateTable();
    return;
  }
  if ('profile' in d) {
    await profile(d.profile);
    return;
  }
  if ('rosterTab' in d) {
    rosterTab = d.rosterTab;
    render();
    return;
  }
  if ('queue' in d) {
    await action({ type: 'queue', player: d.queue });
    return;
  }
  if ('draft' in d) {
    await action({ type: 'draft', player: d.draft });
    return;
  }
  if ('autopick' in d) {
    await action({ type: 'autopick' });
    return;
  }
  if ('finish' in d) {
    showDialog(
      'Let your shortlist finish the job?',
      `<p>Auto-draft will fill the rest of your roster, following queued players first, then selecting available value and filling positional needs. You’ll manage every lineup and waiver decision once the season begins.</p>`,
      '<button class="btn ghost" data-close>Keep drafting</button><button class="btn primary" data-finish-confirm data-move>Finish the draft →</button>',
    );
    return;
  }
  if ('finishConfirm' in d) {
    if (await action({ type: 'finishDraft' })) closeDialog();
    return;
  }
  if ('board' in d) {
    showDialog('The draft board', draftBoard());
    $('#dialog').style.width = 'min(1500px,calc(100vw - 28px))';
    return;
  }
  if ('optimize' in d) {
    if (await action({ type: 'optimize' }))
      toast('Lineup set using current projections and availability.');
    return;
  }
  if ('start' in d) {
    const id = d.start,
      eligible = SLOTS.map((slot, i) => ({ slot, i })).filter((x) =>
        x.slot === 'FLEX' ? p(id).position !== 'QB' : p(id).position === x.slot,
      );
    eligible.sort((a, b) => {
      const value = (x) => {
        const pid = team().lineup[x.i];
        return pid && state.playerStatus[pid] === 'ACTIVE' ? state.projections[pid] : -1;
      };
      return value(a) - value(b);
    });
    const lineup = [...team().lineup];
    lineup[eligible[0].i] = id;
    await action({ type: 'lineup', lineup });
    return;
  }
  if ('advance' in d) {
    const issues = team().lineup.filter((id) => !id || state.playerStatus[id] !== 'ACTIVE').length;
    if (issues) {
      showDialog(
        'A lineup check before kickoff.',
        `<p>${issues} starter${issues === 1 ? ' is' : 's are'} out, on bye, or missing. You can fix your lineup, or play the week with those slots scoring zero.</p>`,
        '<button class="btn ghost" data-close>Review my lineup</button><button class="btn primary" data-play-confirm data-move>Play anyway →</button>',
      );
    } else await playWeek();
    return;
  }
  if ('playConfirm' in d) {
    closeDialog();
    await playWeek();
    return;
  }
  if ('acquire' in d) {
    acquire(d.acquire);
    return;
  }
  if ('cancel' in d) {
    await action({ type: 'cancelClaim', add: d.cancel });
    return;
  }
  if ('waivers' in d) {
    if (await action({ type: 'waivers' })) {
      const outcomes = state.lastWaivers.results.filter((r) => r.team === state.human);
      toast(
        outcomes.length
          ? `${outcomes.filter((r) => r.won).length} of ${outcomes.length} claims won. Free agents are open.`
          : 'Waivers processed. Free agents are open.',
      );
    }
    return;
  }
  if ('week' in d) {
    const w = Number(d.week);
    if (w <= Math.min(state.week, 18)) {
      reviewWeek = w === state.week ? null : w;
      render();
    }
    return;
  }
  if ('recap' in d) {
    route = 'team';
    reviewWeek = Number(d.recap);
    render();
    return;
  }
  if ('live' in d) {
    reviewWeek = null;
    render();
    return;
  }
  if ('team' in d) {
    const t = state.teams[Number(d.team)];
    showDialog(
      t.name,
      `<p>${esc(t.profile?.note ?? 'Your franchise. Your decisions.')} · FAAB ${money(t.faab)}</p><table class="simple-table">${t.roster.map((id) => `<tr><td>${posBadge(p(id).position)}</td><td>${nameButton(id)}</td><td class="muted">${t.lineup.includes(id) ? 'Starter' : 'Bench'}</td><td>${num(state.projections[id])}</td></tr>`).join('')}</table>`,
    );
    return;
  }
});
$('#dialog').addEventListener('close', () => {
  $('#dialog').style.width = '';
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('offline', () => {
  const bar = document.createElement('div');
  bar.className = 'offline';
  bar.textContent = browserMode
    ? 'Offline mode. Your downloaded game and local saves still work.'
    : 'You’re offline. Reconnect to save moves and play your next week.';
  document.body.appendChild(bar);
});
window.addEventListener('online', () => {
  $('.offline')?.remove();
  toast('Back online. Your franchise is ready.');
});
async function init() {
  try {
    catalog = await request('/api/catalog');
    players = new Map(catalog.players.map((x) => [x.id, x]));
    let last;
    try {
      last = JSON.parse(localStorage.getItem('ff-current'));
    } catch {}
    if (last) await resume(last);
    render();
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register(browserMode ? './sw.js' : '/sw.js').catch(() => {});
  } catch (e) {
    $('#app').innerHTML =
      '<div class="boot"><div class="brand-mark">F</div><h1>The locker room is offline.</h1><p>Reconnect to this server, then reload the page.</p><button class="btn primary" id="retry">Try again</button></div>';
    $('#retry').onclick = () => location.reload();
  }
}
init();
