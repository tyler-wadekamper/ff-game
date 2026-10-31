import { NFL_CLUBS, ROSTER_SIZE, DRAFT_PICKS, DRAFT_ROUNDS, clubInfo } from './config.mjs';
import {
  playerProfile,
  historicalRanks,
  rankLabel,
  statValue,
  statTone,
  depthCharts,
} from './player-insights.mjs';
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
  installPrompt = null,
  selectedClub = 'DET',
  recapCache = new Map();
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
  `<button class="player-name" data-profile="${id}">${esc(p(id)?.name ?? 'Former player')}</button>`;
function useCatalog(value) {
  if (!value) return;
  catalog = value;
  players = new Map(catalog.players.map((x) => [x.id, x]));
  recapCache.clear();
}
function finishTag(id) {
  const x = p(id),
    current = state.positionRanks?.[id],
    past = historicalRanks(catalog)[0]?.[id];
  return `<span class="finish-tag" title="${state.week > 1 ? 'Season PPR rank through Week ' + Math.min(18, state.week - 1) : 'Previous season PPR finish'}">${state.week > 1 ? rankLabel(x.position, current) : rankLabel(x.position, past)}${state.week > 1 ? ' so far' : ' last year'}</span>`;
}
function healthLine(id) {
  const h = state.injuryReports?.[id];
  return h
    ? `${esc(h.designation)}${h.returnWindow ? ' · ' + esc(h.returnWindow) : ''}`
    : esc(state.playerStatus[id]);
}

const icon = (name) =>
  ({
    depth: '<path d="M4 4h16v16H4zM4 10h16M10 4v16"/>',
    recaps: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>',
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
  list.unshift({
    ...credentials,
    name: team().name,
    universe: state.universe?.label,
    year: state.seasonYear,
    date: new Date().toISOString(),
  });
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
function setupForm(mode = 'new') {
  const continuing = mode === 'continue';
  return `<form id="setup-form" data-mode="${mode}"><div class="notice ${continuing ? 'success' : ''}"><strong>${continuing ? 'Continue this universe' : 'Create a new universe'}</strong><br>${continuing ? 'Keep player identities, carry this season into their history, age the league and meet a new rookie class. A fresh draft begins.' : 'Real NFL players with randomized career ages, adapted histories, history-based draft prices and fresh season outcomes. Saved universes remain available.'}</div><label class="form-field">YOUR FRANCHISE CITY<select name="city" id="team-city" ${continuing ? 'disabled' : ''}>${NFL_CLUBS.map((c) => `<option value="${c.abbreviation}" ${c.abbreviation === (continuing ? team().abbreviation : 'DET') ? 'selected' : ''}>${esc(c.city)} · ${c.abbreviation}</option>`).join('')}</select></label><label class="form-field">DRAFT POSITION<select name="slot" id="draft-slot">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${i === 6 ? 'selected' : ''}>Pick ${i + 1} of 12</option>`).join('')}</select></label><button class="btn primary" data-create type="submit">${continuing ? 'Continue to next season' : 'Enter a new universe'} <span>↗</span></button></form>`;
}
function welcome() {
  $('#app').innerHTML =
    `<main class="welcome" id="main"><div class="welcome-top"><div class="brand-mark">F</div><div class="brand">FOURTH &<br>FOREVER</div></div><div class="welcome-grid"><div><p class="eyebrow">THE SINGLE-PLAYER FANTASY FOOTBALL SIM</p><h1>A whole season.<br><em>Your call.</em></h1><p class="lead">Build your team. Outsmart eleven managers. Turn a draft-day hunch into a championship, one Sunday at a time.</p><div class="actions" style="margin-top:24px"><button class="btn primary" type="button" data-quick-start data-create>Start a new universe →</button><span class="muted" style="font-size:11px">Jump straight into the draft</span></div><div class="pills"><span>12 teams · full PPR</span><span>Real NFL players · random ages</span><span>Play at your pace</span></div><p class="footnote">History gives you clues. The next season is yours to discover.</p></div><div class="card setup"><h2>Your franchise starts here.</h2>${setupForm()}<p class="footnote">No account or payment needed for this prototype. ${browserMode ? 'Your league saves on this device. Export a recovery file before clearing browser data.' : 'Your league saves automatically in this browser and on this server. An internet connection is required to play.'}</p>${saved().length ? '<button class="text-link" data-settings>Resume a saved league →</button>' : ''}</div></div></main>`;
}
async function create() {
  if (busy) return;
  busy = true;
  renderBusy();
  const form = $('#setup-form'),
    options = {
      city: form.elements.city.value,
      slot: Number(form.elements.slot.value),
      mode: form.dataset.mode ?? 'new',
      ...(form.dataset.mode === 'continue' ? { source: credentials } : {}),
    };
  try {
    const data = await request('/api/leagues', { method: 'POST', body: JSON.stringify(options) });
    credentials = { id: data.id, token: data.token };
    state = data.state;
    useCatalog(data.catalog);
    route = 'draft';
    reviewWeek = null;
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
      ['depth', 'Depth charts'],
      ['recaps', 'The recap'],
    ]
      .map(
        ([key, label]) =>
          `<button data-route="${key}" class="${route === key ? 'active' : ''}" ${state.phase === 'draft' && key !== 'draft' && key !== 'league' ? 'aria-disabled="true"' : ''}>${svg(key)}<span>${label}</span></button>`,
      )
      .join(
        '',
      )}</nav><div class="sidebar-foot"><span class="saved-dot"></span>Progress saved automatically<br><span class="muted">${esc(state.universe?.label ?? 'Original universe')} · ${state.seasonYear ?? 2026}</span><br><button class="text-link" data-rules>League rules ↗</button><p style="margin-top:17px;color:#60717e">${catalog.identityMode === 'real' ? 'Real NFL players.<br>Your alternate season.' : 'Fictional players.<br>Your own season.'}</p></div></aside><div><header class="topbar"><div><span class="brand-mobile">F&F</span> <span class="hide-small">/ &nbsp; ${esc(team().name)} &nbsp; / &nbsp;</span><strong>${phase}</strong></div><div class="top-actions"><span class="tag">${catalog.identityMode === 'real' ? 'REAL PLAYERS' : 'SOLO LEAGUE'}</span><button class="text-link hide-small" data-install>Install app</button><button class="round-icon" data-settings aria-label="Settings and saved leagues">${svg('settings')}</button></div></header><main class="content" id="main" tabindex="-1">${catalog.identityMode !== 'real' ? '<div class="notice">Real-player universes are available. This saved universe keeps its original players. <button class="text-link" data-new>Start a real-player universe →</button></div>' : ''}${content}</main></div></div>`;
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
  if (route === 'depth') shell(depthPage());
  if (route === 'recaps') shell(recapsPage());
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
  const owned = new Set(state.teams.flatMap((t) => [...t.roster, ...(t.ir ?? [])]));
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
        return `<tr><td>${route === 'draft' ? `<button class="star ${state.queue.includes(x.id) ? 'selected' : ''}" data-queue="${x.id}" aria-label="${state.queue.includes(x.id) ? 'Remove' : 'Queue'} ${esc(x.name)}" aria-pressed="${state.queue.includes(x.id)}">${state.queue.includes(x.id) ? '★' : '☆'}</button>` : posBadge(x.position)}</td><td>${nameButton(x.id)}<div class="subline">${route === 'draft' ? posBadge(x.position) : ''}<span>${clubInfo(x.club).abbreviation}</span>${finishTag(x.id)}${route === 'waivers' && st !== 'ACTIVE' ? `<span class="availability ${st === 'BYE' ? 'bye' : 'out'}">${st}</span>` : ''}${locked ? '<span class="availability out">Clears next week</span>' : ''}</div></td><td class="num muted">${num(x.adp)}</td><td class="num hide-mobile muted">${x.age}</td><td class="num hide-medium muted">${x.bye}</td><td class="num">${route === 'draft' ? (last ? num(last.ppr) : 'Rookie') : num(st === 'ACTIVE' ? state.projections[x.id] : 0)}</td><td>${route === 'draft' ? `<button class="draft-btn" data-draft="${x.id}" data-move>Draft</button>` : `<button class="draft-btn" data-acquire="${x.id}" ${locked || state.phase === 'complete' ? 'disabled' : ''}>${state.waiversProcessed || state.week === 1 ? 'Add' : 'Claim'}</button>`}</td></tr>`;
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
  return `<div class="card draft-side"><div class="card-head"><div class="mini-tabs"><button data-roster-tab="roster" class="${rosterTab === 'roster' ? 'active' : ''}">Your roster <small>${team().roster.length}/${ROSTER_SIZE}</small></button><button data-roster-tab="queue" class="${rosterTab === 'queue' ? 'active' : ''}">Queue <small>${state.queue.length}</small></button></div></div><div class="roster-progress"><span style="width:${(100 * team().roster.length) / ROSTER_SIZE}%"></span></div>${
    rosterTab === 'roster'
      ? `<div class="needs">${['QB', 'RB', 'WR', 'TE']
          .map((pos) => {
            const n = team().roster.filter((id) => p(id).position === pos).length;
            return `<span class="need ${n >= { QB: 1, RB: 2, WR: 2, TE: 1 }[pos] ? 'done' : ''}">${pos} ${n}</span>`;
          })
          .join('')}</div>`
      : ''
  }<div class="mini-roster">${ids.map((id, i) => `<div class="mini-player"><span class="index">${i + 1}</span>${posBadge(p(id).position)}<div>${nameButton(id)}</div><span class="adp">${num(p(id).adp, 0)}</span></div>`).join('')}${rosterTab === 'roster' ? Array.from({ length: Math.max(0, ROSTER_SIZE - ids.length) }, (_, i) => `<div class="mini-player"><span class="index">${ids.length + i + 1}</span><span class="empty">Waiting for your pick</span></div>`).join('') : !ids.length ? '<div class="empty-state"><strong>Your shortlist, your call.</strong>Star a player to queue them. Auto-pick follows your queue in order.</div>' : ''}</div></div>`;
}
function draftPage() {
  if (state.phase !== 'draft')
    return `<div class="page-heading"><div><p class="eyebrow">${DRAFT_PICKS} PICKS. 12 FRANCHISES.</p><h1>The draft is in the books.</h1><p>Your roster is ready. Time to find out what it can do.</p></div><button class="btn primary" data-route="team">Go to my team →</button></div>${draftBoard()}<div class="card feed">${state.picks
      .slice(-5)
      .map(
        (x) =>
          `<p>Pick ${x.pick} · <strong>${esc(state.teams[x.team].name)}</strong> selected ${esc(p(x.player).name)} (${p(x.player).position})</p>`,
      )
      .join('')}</div>`;
  const round = Math.floor(state.pick / 12) + 1,
    current = state.pick + 1;
  const strip = Array.from({ length: 12 }, (_, i) => Math.max(0, state.pick - 3) + i)
    .filter((i) => i < DRAFT_PICKS)
    .map((i) => {
      const t = state.teams[Math.floor(i / 12) % 2 ? 11 - (i % 12) : i % 12],
        choice = state.picks[i];
      return `<div class="pick-card ${i === state.pick ? 'current' : ''} ${i < state.pick ? 'past' : ''}" ${i === state.pick ? 'id="current-pick"' : ''}><div class="pick-num"><span>${String(Math.floor(i / 12) + 1).padStart(2, '0')}.${String((i % 12) + 1).padStart(2, '0')}</span><span>${i + 1}</span></div><strong>${t.id === state.human ? 'You' : esc(t.name)}</strong>${choice ? `<span class="player-position ${p(choice.player).position}" style="color:var(--position-color)">${p(choice.player).position} · ${esc(p(choice.player).name.split(' ').at(-1))}</span>` : `<span class="muted">${i === state.pick ? 'On the clock' : 'Up next'}</span>`}</div>`;
    })
    .join('');
  return `<div class="page-heading"><div><h1>Draft room<span style="color:var(--lime)">.</span></h1><p>The board is moving. Trust your homework.</p></div><div class="heading-actions"><button class="btn ghost" data-board>Draft board</button><button class="btn ghost" data-finish>Finish with auto-draft</button></div></div><div class="pick-strip">${strip}</div><div class="on-clock"><div><strong>You’re on the clock <span class="muted">· Pick ${String(round).padStart(2, '0')}.${String((state.pick % 12) + 1).padStart(2, '0')}</span></strong><p>Round ${round} of ${DRAFT_ROUNDS} · ${current} of ${DRAFT_PICKS} · No timer. Make your pick.</p></div><button class="btn primary" data-move data-autopick>Auto-pick</button></div><div class="draft-layout"><div><div class="card"><div class="card-head"><h2>Available players</h2><small id="pool-count"></small></div>${filters()}${tableFrame()}</div><div class="card feed"><p class="eyebrow" style="margin-bottom:5px">LATEST PICKS</p>${
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
    { length: DRAFT_ROUNDS },
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
  return `<div class="page-heading"><div><p class="eyebrow" style="margin-bottom:7px">${weekLabel(w)}</p><h1>${done ? 'What a season.' : historical ? `Week ${w} recap` : 'Your next move.'}</h1><p>${historical ? 'The scores and lineups below are locked to that week.' : 'Set your starters. Check the wire. Let Sunday happen.'}</p></div><div class="heading-actions">${historical && !done ? '<button class="btn" data-live>Back to this week</button>' : ''}${!historical && !done ? `<button class="btn ghost" data-optimize data-move>Set best lineup</button><button class="btn primary" data-advance data-move>Play Week ${state.week} →</button>` : ''}${done ? '<button class="btn primary" data-continue>Next season · same universe →</button><button class="btn ghost" data-new>New universe</button>' : ''}</div></div>${state.champion !== null ? championBanner() : ''}${weeks()}${!historical && issues ? `<div class="notice">${issues} starting slot${issues === 1 ? ' needs' : 's need'} attention: a player is out, on bye, or the slot is empty. Set your lineup or find cover on waivers.</div>` : ''}${state.week === 18 && !done ? '<div class="notice success">The championship is settled. Week 18 is a victory-lap exhibition: it will not change the champion or regular-season standings.</div>' : ''}${rosterWarnings()}${historical ? `<button class="btn" data-show-recap="${w}">Read Week ${w} report card →</button>` : ''}${matchupHero(game, w)}<div class="two-column"><div class="card"><div class="card-head"><h2>${historical ? 'Your locked starters' : 'Starting lineup'}</h2><small>${historical ? 'Actual PPR' : 'Projected PPR'}</small></div><div class="lineup-list">${SLOTS.map(
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
  )}</div><div style="padding:15px 18px;font-size:10px" class="muted">${historical ? 'Past lineup changes cannot alter these scores.' : 'Projections use visible history and completed weeks. Medical return ranges are uncertain; check player cards for details.'}</div></div><div><div class="card"><div class="card-head"><h2>${historical ? 'Current bench' : 'Your bench'}</h2><small>${bench.length} / 6 bench · ${team().roster.length}/${ROSTER_SIZE} active</small></div><div class="bench">${bench.map((id) => `<div class="bench-row">${posBadge(p(id).position)}<div class="grow">${nameButton(id)}<div class="subline">${healthLine(id)} · ${clubInfo(p(id).club).abbreviation} · ${finishTag(id)}</div></div><span class="num muted">${num(state.projections[id])}</span>${!done && !historical ? `<button class="btn small ghost" data-start="${id}">Start</button>${state.injuryReports[id]?.irEligible ? `<button class="btn small" data-reserve="${id}">IR</button>` : ''}<button class="text-link" data-release="${id}">Drop</button>` : ''}</div>`).join('')}</div></div>${!historical ? irPanel() : ''}<div class="card feed"><p class="eyebrow">FRANCHISE CHECK-IN</p><p><strong>${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'}</strong> in the standings · <strong>${money(team().faab)}</strong> FAAB remaining</p><p>${state.waiversProcessed ? 'This week’s waivers have processed. Unclaimed players are free agents.' : 'Waivers process before kickoff. You can submit claims before playing the week.'}</p><button class="text-link" data-route="waivers">Go to the waiver wire →</button></div></div></div>`;
}
function waiverPage() {
  const free = state.waiversProcessed || state.week === 1;
  return `<div class="page-heading"><div><h1>The waiver wire<span style="color:var(--lime)">.</span></h1><p>Find the next difference-maker before everyone else does.</p></div>${!state.waiversProcessed && state.phase === 'season' ? '<button class="btn primary" data-waivers data-move>Process waivers →</button>' : ''}</div><div class="stat-cards"><div class="stat-card"><p class="eyebrow">YOUR FAAB</p><strong>${money(team().faab)}<span class="muted" style="font-size:14px"> / $100</span></strong><p>Spend only when a claim wins</p></div><div class="stat-card"><p class="eyebrow">CLAIM WINDOW</p><strong style="font-size:22px">${state.phase === 'complete' ? 'Closed' : free ? 'Free agents' : 'Bids open'}</strong><p>${free ? 'Unclaimed players cost $0' : 'Sealed bids · highest offer wins'}</p></div><div class="stat-card"><p class="eyebrow">YOUR CLAIMS</p><strong>${state.claims.length}</strong><p>Higher bids process first</p></div></div>${!free ? '<div class="notice success">Submit an add/drop and a whole-dollar bid. All 11 managers can bid too. Ties go to the lower-ranked team; only winning bids cost FAAB. Waivers also run automatically when you play this week.</div>' : ''}${state.claims.length ? `<div class="card" style="margin-bottom:22px"><div class="card-head"><h2>Pending claims</h2><small>Your bids are sealed</small></div>${state.claims.map((c) => `<div class="claim-row"><span class="bid">${money(c.bid)}</span><div class="grow"><strong>${esc(p(c.add).name)}</strong><p>${c.drop ? 'Drop ' + esc(p(c.drop).name) : 'Use open roster spot'}</p></div><button class="btn small ghost" data-cancel="${c.add}" data-move>Cancel</button></div>`).join('')}</div>` : ''}<div class="draft-layout"><div class="card"><div class="card-head"><h2>Available players</h2><small id="pool-count"></small></div>${filters()}${tableFrame()}</div><div><div class="card"><div class="card-head"><h2>Recent transactions</h2></div>${
    state.transactions
      .slice(-10)
      .reverse()
      .map(
        (t) =>
          `<div class="claim-row"><div><strong>${esc(state.teams[t.team].name)}</strong><p>${t.add ? `<span style="color:var(--lime)">+ ${esc(p(t.add).name)}</span><br>` : ''}${t.drop ? '− ' + esc(p(t.drop).name) : 'Open roster spot'}<br>Week ${t.week} · ${t.source} · ${money(t.bid)}</p></div></div>`,
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
function awardCard(kicker, title, body, extra = '') {
  return `<article class="award-card"><p class="eyebrow">${esc(kicker)}</p><h3>${title}</h3><p>${body}</p>${extra}</article>`;
}
function weeklyReport(r) {
  if (!r)
    return '<div class="notice">Detailed scorecards begin with weeks played after this update. Earlier saved scores and starters remain in your schedule.</div>';
  const steal = r.steal,
    reach = r.biggestReach,
    bad = r.leagueBadBeat;
  return `<section class="report" data-weekly-report="${r.week}"><div class="report-intro"><p class="eyebrow">THE SUNDAY PAPER · WEEK ${r.week}</p><h2>${esc(r.headline)}</h2><p>${esc(r.message)}</p></div><div class="stat-cards"><div class="stat-card"><p class="eyebrow">PREGAME LINEUP GRADE</p><strong>${r.lineupGrade}</strong><p>${num(r.decisionEfficiency * 100, 0)}% of the best public estimate</p></div><div class="stat-card"><p class="eyebrow">HINDSIGHT POINTS CAPTURED</p><strong>${num(r.pointsCaptured * 100, 0)}%</strong><p>${num(r.pointsOnBench)} points below the best possible lineup</p></div><div class="stat-card"><p class="eyebrow">ALL-PLAY RECORD</p><strong>${r.allPlayWins}–${r.allPlayLosses}${r.allPlayTies ? '–' + r.allPlayTies : ''}</strong><p>Your score against all 11 rivals · rank #${r.scoreRank}</p></div></div><p class="report-note">${esc(r.processNote)}</p><div class="award-grid">${awardCard('YOUR DIFFERENCE-MAKER', r.mvp ? nameButton(r.mvp.id) : 'A quiet week', r.mvp ? `${num(r.mvp.points)} PPR from your top starter.${r.cold && r.cold.id !== r.mvp.id ? ` At the other end, ${esc(p(r.cold.id).name)} delivered ${num(r.cold.points)}.` : ''}` : 'No starters recorded.')}${awardCard('THE BENCH WHAT-IF', r.bench ? nameButton(r.bench.id) : 'Nothing left behind', r.bench ? `${num(r.bench.points)} PPR on the bench. The best legal lineup would have added ${num(r.pointsOnBench)} total points. This is hindsight, not a forecast you missed.` : 'Your starters captured the best legal score available this week.')}${awardCard('DRAFT STEAL · SEASON TO DATE', steal ? nameButton(steal.player) : 'Still taking shape', steal ? `Drafted ${steal.position}${steal.positionCost} at pick ${steal.pick}; currently ${steal.position}${steal.finish} with ${num(steal.points)} PPR. ${esc(state.teams[steal.team].name)} found production past its draft price.` : 'No drafted player has beaten their positional draft slot yet.')}${awardCard('BIGGEST MARKET REACH', reach ? nameButton(reach.player) : 'A patient room', reach ? `${esc(state.teams[reach.team].name)} took pick ${reach.pick} against ADP ${num(reach.adp)} (${num(reach.reach, 0)} picks early). A price premium, not automatically a mistake.` : 'The room has stayed close to market prices.')}${awardCard('THE WAIVER RECEIPT', r.waiverWin ? nameButton(r.waiverWin.id) : 'The wire is waiting', r.waiverWin ? `${esc(state.teams[r.waiverWin.team].name)} got ${num(r.waiverWin.points)} starting PPR from a $${r.waiverWin.bid} pickup.${r.yourWaiverWin ? ` Your best wire starter: ${esc(p(r.yourWaiverWin.id).name)}, ${num(r.yourWaiverWin.points)} PPR.` : ''}` : 'No waiver or free-agent pickup reached a starting lineup this week.')}${awardCard('ROUGH MEDICAL BREAKS', r.worstInjury.impact > 0 ? esc(state.teams[r.worstInjury.team].name) : 'A healthier week', r.worstInjury.impact > 0 ? `${r.worstInjury.count} medical absences reduced the best public lineup estimate by ${num(r.worstInjury.impact)} points. Your estimated loss: ${num(r.injuryImpact)}. Byes and nonmedical inactivity are excluded.` : 'No medical absence lowered a team’s best estimated lineup.')}${awardCard('THE BAD-BEAT FILE', bad ? esc(state.teams[bad.team].name) : 'No standout hard-luck loss', bad ? `Scored ${num(bad.score)}, #${bad.rank} in the league, and lost by ${num(bad.margin, 2)}. Sometimes the opponent is the whole story.` : 'No top-three scoring loss or margin within three points this week.')}${awardCard('LEAGUE FIREWORKS', r.topPlayers[0] ? nameButton(r.topPlayers[0].id) : 'No games', r.topPlayers.map((z) => `${esc(p(z.id).name)}: ${num(z.points)} PPR`).join('<br>'))}</div><p class="footnote">${esc(r.sampleNote)}</p></section>`;
}
function seasonReport(r) {
  if (!r) return '';
  const pickText = (x) =>
    x
      ? `Pick ${x.pick}, drafted ${x.position}${x.positionCost}, finished ${x.finish ? rankLabel(x.position, x.finish) : 'unranked'} · ${num(x.points)} PPR.`
      : 'No qualifying award this season.';
  return `<section class="report season-report" data-season-report>${r.coverageNote ? `<div class="notice">${esc(r.coverageNote)}</div>` : ''}<div class="report-intro"><p class="eyebrow">THE YEARBOOK · ${r.year}</p><h2>A season worth remembering.</h2><p>${r.regularRecord.wins}–${r.regularRecord.losses}–${r.regularRecord.ties} in the regular season. ${r.champion === state.human ? 'The trophy is yours.' : 'The trophy went to ' + esc(state.teams[r.champion].name) + '.'}</p></div><div class="stat-cards"><div class="stat-card"><p class="eyebrow">DRAFT · PRESEASON ESTIMATES</p><strong>#${r.processDraftRank}<small> / 12</small></strong><p>Best starter group from visible history at the draft</p></div><div class="stat-card"><p class="eyebrow">DRAFT · REALIZED PRODUCTION</p><strong>#${r.outcomeDraftRank}<small> / 12</small></strong><p>Best starter group by full-season points, in hindsight</p></div><div class="stat-card"><p class="eyebrow">SEASON LINEUP GRADE</p><strong>${r.lineupGrade ?? '—'}</strong><p>${r.lineupGrade ? num(r.lineupDecisionEfficiency * 100, 0) + '% pregame estimate efficiency' : 'No recorded coaching snapshots'}</p></div></div><div class="award-grid">${awardCard('YOUR BEST DRAFT RETURN', r.yourHit ? nameButton(r.yourHit.player) : 'A difficult draft class', pickText(r.yourHit))}${awardCard('YOUR EARLY-ROUND DISAPPOINTMENT', r.yourMiss ? nameButton(r.yourMiss.player) : 'No qualifying early-round miss', pickText(r.yourMiss))}${awardCard('LEAGUE STEAL OF THE YEAR', r.steal ? nameButton(r.steal.player) : 'No clear steal', pickText(r.steal))}${awardCard('BIGGEST MARKET REACH', r.biggestReach ? nameButton(r.biggestReach.player) : 'No market premium', r.biggestReach ? `${esc(state.teams[r.biggestReach.team].name)} selected pick ${r.biggestReach.pick} at ADP ${num(r.biggestReach.adp)}. Finished ${rankLabel(r.biggestReach.position, r.biggestReach.finish)}. Paying up and being wrong are separate questions.` : 'The draft tracked market prices.')}${awardCard('YOUR WAIVER MVP', r.bestPickup ? nameButton(r.bestPickup.add) : 'No wire starter this year', r.bestPickup ? `Added for $${r.bestPickup.bid}; supplied ${num(r.bestPickup.lineupPoints)} points in your starting lineups while on that roster stint.` : 'A new season brings another chance to find a difference-maker.')}${awardCard('WORST INJURY LUCK', r.worstInjury?.injuryImpact > 0 ? esc(state.teams[r.worstInjury.id].name) : r.worstInjury ? 'A healthy league' : 'No medical snapshots', r.worstInjury ? `Medical absences cost that roster an estimated ${num(r.worstInjury.injuryImpact)} lineup points across recorded weeks. Your total: ${num(r.injuryImpact)}. This measures lost pregame options, not certain points.` : 'Medical impact was not recorded in this older save.')}${awardCard('YOUR TOUGHEST BAD BEAT', r.badBeat ? `Week ${r.badBeat.week}` : 'No standout bad beat', r.badBeat ? `You scored ${num(r.badBeat.score)}, #${r.badBeat.scoreRank} that week, and lost by ${num(r.badBeat.margin, 2)}. ${r.badBeat.allPlayWins} of 11 other matchups would have been wins.` : 'No top-three scoring loss or margin within three points was recorded.')}${awardCard('THE COACHING REVIEW', r.pointsOnBench == null ? 'No coaching snapshots' : `${num(r.pointsOnBench)} hindsight points`, 'Total points below the best legal lineup each week. Use the pregame grade to judge decisions; this total also includes unpredictable breakout games.')}${awardCard('THE LEAGUE BAD-BEAT TROPHY', r.leagueBadBeat ? esc(state.teams[r.leagueBadBeat.team].name) : 'No standout loss', r.leagueBadBeat ? `Week ${r.leagueBadBeat.week}: ${num(r.leagueBadBeat.score)} points, #${r.leagueBadBeat.rank} that week, yet a ${num(r.leagueBadBeat.margin, 2)}-point loss.` : 'No top-three scoring loss or margin within three points was recorded.')}${awardCard('THE POSITION CROWNS', 'Four ways to carry a team', (r.leaders ?? []).map((x) => `${x.position}1 · ${esc(p(x.id).name)} · ${num(x.points)} PPR`).join('<br>'))}</div><p class="report-note">${esc(r.note)}</p><div class="actions"><button class="btn primary" data-continue>Next season · same universe →</button><button class="btn" data-new>New universe · fresh ages</button></div></section>`;
}
function recapsPage() {
  return `<div class="page-heading"><div><p class="eyebrow">YOUR FRANCHISE REPORT CARD</p><h1>The recap<span style="color:var(--lime)">.</span></h1><p>Good calls, wild Sundays, and receipts from the wire.</p></div></div>${state.seasonRecap ? seasonReport(state.seasonRecap) : ''}${state.latestRecap ? weeklyReport(state.latestRecap) : '<div class="notice">Play a week to open the Sunday paper. Every completed week gets its own report card.</div>'}<h2 class="section-label">The season archive</h2><div class="recap-archive">${(state.recapWeeks ?? []).map((w) => `<button class="btn" data-show-recap="${w}">Week ${w} →</button>`).join('')}</div>`;
}
async function showWeeklyRecap(week) {
  try {
    if (!recapCache.has(week))
      recapCache.set(week, (await request(`/api/leagues/${credentials.id}/recaps/${week}`)).recap);
    showDialog(`Week ${week} · the Sunday paper`, weeklyReport(recapCache.get(week)));
    $('#dialog').style.width = 'min(1050px,calc(100vw - 24px))';
  } catch (e) {
    toast(e.message, true);
  }
}
function depthPage() {
  const club = clubInfo(selectedClub),
    charts = depthCharts(catalog, state)[club.id];
  return `<div class="page-heading"><div><p class="eyebrow">THE FOOTBALL UNIVERSE</p><h1>Depth charts<span style="color:var(--lime)">.</span></h1><p>Estimated order from previous production and recent opportunities. Roles can change.</p></div><label class="form-field">NFL CITY<select id="depth-club">${NFL_CLUBS.map((c) => `<option value="${c.abbreviation}" ${c.id === club.id ? 'selected' : ''}>${esc(c.city)} · ${c.abbreviation}</option>`).join('')}</select></label></div><div class="depth-heading"><h2>${esc(club.city)} <span class="muted">${club.abbreviation}</span></h2><span class="tag">BYE ${catalog.players.find((p) => p.club === club.id)?.bye}</span></div><div class="depth-grid">${[
    'QB',
    'RB',
    'WR',
    'TE',
  ]
    .map(
      (pos) =>
        `<div class="card"><div class="card-head"><h2>${posBadge(pos)} ${pos === 'QB' ? 'Quarterbacks' : pos === 'RB' ? 'Running backs' : pos === 'WR' ? 'Wide receivers' : 'Tight ends'}</h2></div>${(
          charts?.[pos] ?? []
        )
          .map((x, i) => {
            const owner = state.teams.find((t) => [...t.roster, ...(t.ir ?? [])].includes(x.id));
            return `<div class="depth-row"><span class="depth-number">${i + 1}</span><div>${nameButton(x.id)}<div class="subline">${finishTag(x.id)} · ${healthLine(x.id)}</div><small class="muted">${owner ? esc(owner.name) : 'Free agent'} · age ${x.age}</small></div></div>`;
          })
          .join('')}</div>`,
    )
    .join('')}</div>`;
}

function careerTable(title, rows, columns, x) {
  if (!rows.length)
    return `<section class="career-section"><h3>${title}</h3><p class="muted">No previous NFL seasons · rookie history begins here.</p></section>`;
  return `<section class="career-section"><h3>${title}</h3><div class="table-wrap"><table class="career-table"><thead><tr><th>YEAR</th>${columns.map(([key, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><th>${r.year}${r.current ? `<small>THRU W${Math.min(18, state.week - 1)}</small>` : ''}</th>${columns
          .map(([key, label, digits = 0]) => {
            const v = key === 'rank' ? r.rank : statValue(r, key);
            return `<td class="stat-${statTone(r, key, x.position, catalog, state)}" title="${esc(label)} · ${r.current ? 'current totals' : 'season finish'}">${v == null ? '—' : key === 'rank' ? rankLabel(x.position, v) : num(v, digits)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}
async function profile(id) {
  const x = p(id),
    insight = playerProfile(state, catalog, id, state.injuryReports?.[id]),
    owned = state.teams.find((t) => [...t.roster, ...(t.ir ?? [])].includes(id)),
    h = insight.health;
  const core = [
    ['age', 'AGE'],
    ['games', 'GM'],
    ['ppr', 'PPR', 2],
    ['rank', 'POS FINISH'],
    ['ppg', 'PPR / G', 1],
  ];
  const pass = [
    ['attempts', 'ATT'],
    ['completions', 'CMP'],
    ['passing_yards', 'YD'],
    ['completion_pct', 'CMP%', 1],
    ['passing_ypa', 'YPA', 2],
    ['passing_tds', 'TD'],
    ['passing_interceptions', 'INT'],
  ];
  const rush = [
    ['carries', 'ATT'],
    ['rushing_yards', 'YD'],
    ['rushing_ypc', 'YPC', 2],
    ['rushing_tds', 'TD'],
  ];
  const rec = [
    ['targets', 'TAR'],
    ['receptions', 'REC'],
    ['receiving_yards', 'YD'],
    ['receiving_ypt', 'YPT', 2],
    ['receiving_ypr', 'YPR', 2],
    ['receiving_tds', 'TD'],
  ];
  showDialog(
    x.name,
    `${posBadge(x.position)} <span class="muted">Age ${x.age}${x.ageRandomized ? ' (randomized)' : ''} · ${insight.club.city} (${insight.club.abbreviation}) · ${owned ? esc(owned.name) : 'Free agent'}</span><div class="profile-stats"><div><small>${state.week > 1 ? 'POSITION · SO FAR' : 'LAST POSITION FINISH'}</small><strong>${rankLabel(x.position, state.week > 1 ? insight.rank : insight.lastRank)}</strong></div><div><small>MARKET ADP</small><strong>${num(x.adp)}</strong></div><div><small>DEPTH ESTIMATE</small><strong>${x.position}${insight.depth}</strong></div><div><small>BYE</small><strong>${x.bye}</strong></div></div><div class="notice ${h?.kind === 'injury' ? 'injury-notice' : ''}"><strong>${healthLine(id)}</strong> · ${esc(h?.label)}${h?.note ? `<p>${esc(h.note)}</p>` : ''}${owned?.id === state.human && state.phase === 'season' ? `<div class="actions">${team().roster.includes(id) && h.irEligible ? `<button class="btn small" data-reserve="${id}">Move to IR</button>` : ''}${team().ir?.includes(id) ? `<button class="btn small" data-activate-ir="${id}">Activate</button>` : ''}<button class="text-link" data-release="${id}">Drop player</button></div>` : ''}</div><article class="outlook"><p class="eyebrow">THE SCOUTING DESK</p><h3>${esc(insight.outlook.headline)}</h3><p>${esc(insight.outlook.body)}</p><div class="pills">${insight.outlook.signals.map((v) => `<span>${esc(v)}</span>`).join('')}</div><small>${esc(insight.outlook.basis)}</small></article>${careerTable(x.realPlayerId ? 'Simulated career · fantasy' : 'Career · fantasy', insight.rows, core, x)}${x.position === 'QB' ? careerTable('Passing', insight.rows, pass, x) : ''}${['QB', 'RB'].includes(x.position) || insight.rows.some((r) => r.carries > 0) ? careerTable('Rushing', insight.rows, rush, x) : ''}${x.position !== 'QB' || insight.rows.some((r) => r.targets > 0) ? careerTable('Receiving', insight.rows, rec, x) : ''}${x.realPlayerId ? '<p class="footnote"><strong>Alternate NFL career.</strong> This is a real player’s identity with a randomized age and simulated club, history and future. Past lines adapt that player’s recorded career to a 17-game schedule; these are not actual NFL calendar-year totals.</p>' : x.generatedProspect ? '<p class="footnote">Generated future prospect: this universe has used the available historical identities at this position.</p>' : ''}<p class="footnote">Positional rank uses total PPR against this universe’s position pool. Current rows stop after completed games. Green / yellow / red compares the same position and season; rate stats need a minimum sample. Zero-opportunity seasons have no finish.</p><h3>Completed weekly games</h3><div id="player-weeks" data-player="${id}">Loading…</div>`,
  );
  $('#dialog').style.width = 'min(1100px,calc(100vw - 24px))';
  try {
    const data = await request(`/api/leagues/${credentials.id}/players/${id}`),
      el = $('#player-weeks');
    if (!el || el.dataset.player !== id) return;
    el.innerHTML = data.weeks.length
      ? `<div class="weekly-bars">${data.weeks.map((r, i) => `<div><strong>${num(r[0] / 100)}</strong><span style="height:${Math.max(2, Math.max(0, r[0] / 100) * 2)}px"></span><small>W${i + 1}${i + 1 === x.bye ? ' BYE' : !r.at(-1) ? ' DNP' : ''}</small></div>`).join('')}</div>`
      : 'No games completed yet.';
  } catch (e) {
    const el = $('#player-weeks');
    if (el) el.textContent = e.message;
  }
}
function legalDrop(add, drop) {
  const ids = team()
      .roster.filter((x) => x !== drop)
      .concat(add ? [add] : []),
    counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of ids) counts[p(id).position]++;
  const needed =
    Math.max(0, 1 - counts.QB) +
    Math.max(0, 2 - counts.RB) +
    Math.max(0, 2 - counts.WR) +
    Math.max(0, 1 - counts.TE);
  return (
    counts.QB <= 3 &&
    counts.TE <= 4 &&
    ids.length <= ROSTER_SIZE &&
    needed <= ROSTER_SIZE - ids.length &&
    Math.max(0, 7 - counts.RB - counts.WR - counts.TE) <=
      ROSTER_SIZE - ids.length - Math.max(0, 1 - counts.QB)
  );
}
function acquire(id, activate = false) {
  const free = activate || state.waiversProcessed || state.week === 1,
    x = p(id),
    options = [...(team().roster.length < ROSTER_SIZE ? [null] : []), ...team().roster].filter(
      (drop) => legalDrop(id, drop),
    );
  options.sort((a, b) =>
    a === null ? -1 : b === null ? 1 : state.projections[a] - state.projections[b],
  );
  showDialog(
    activate
      ? 'Activate from injured reserve'
      : free
        ? 'Make a roster move'
        : 'Submit a waiver claim',
    `<p><strong>${esc(x.name)}</strong> · ${x.position} · ${num(state.projections[id])} projected PPR</p><form id="claim-form" data-add="${id}" data-activate="${activate}" data-free="${free}"><label class="form-field">ROSTER SPACE<select name="drop" id="drop-player">${options.map((pid) => `<option value="${pid ?? ''}">${pid ? `${esc(p(pid).name)} · ${p(pid).position} · ${num(state.projections[pid])} est.${team().lineup.includes(pid) ? ' · STARTER' : ''}` : 'Use open active-roster spot'}</option>`).join('')}</select></label>${free ? '<p class="footnote">$0 move. Dropped players clear next week.</p>' : `<label class="form-field">SEALED BID · ${money(team().faab)} AVAILABLE<input type="number" name="bid" id="waiver-bid" min="0" max="${team().faab}" step="1" value="${Math.min(5, team().faab)}" required></label>`}<button class="btn primary" data-submit-claim type="submit" ${!options.length ? 'disabled' : ''}>${activate ? 'Activate player' : free ? 'Add player · $0' : 'Submit sealed claim'}</button></form>`,
  );
}
function rosterWarnings() {
  const recovered = (team().ir ?? []).filter((id) => !state.injuryReports[id]?.irEligible);
  return `${state.phase === 'season' && team().roster.length > ROSTER_SIZE ? `<div class="notice">This older save has ${team().roster.length - ROSTER_SIZE} extra active players. Move eligible players to IR or drop players to reach 14 before kickoff.</div>` : ''}${state.phase === 'season' && recovered.length ? `<div class="notice">IR attention: ${recovered.map((id) => esc(p(id).name)).join(', ')} no longer qualify. Activate or drop them before making pickups or playing the week.</div>` : ''}`;
}
function irPanel() {
  return `<div class="card ir-panel"><div class="card-head"><h2>Injured reserve</h2><small>${team().ir?.length ?? 0} / 2 spots</small></div>${Array.from(
    { length: 2 },
    (_, i) => {
      const id = team().ir?.[i];
      return id
        ? `<div class="bench-row">${posBadge(p(id).position)}<div class="grow">${nameButton(id)}<div class="subline">${healthLine(id)}</div></div>${state.phase === 'season' ? `<button class="btn small" data-activate-ir="${id}">Activate</button><button class="text-link" data-release="${id}">Drop</button>` : ''}</div>`
        : '<div class="bench-row muted">Open IR slot · medically OUT / IR eligible</div>';
    },
  ).join('')}</div>`;
}
function showRules() {
  showDialog(
    'Your league, explained.',
    `<p>A season you can play on your own schedule.</p><ul class="rule-list"><li>12 teams. One human manager and eleven distinct bot managers.</li><li>14-round snake draft. 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX (RB/WR/TE), plus 6 bench players and 2 injured-reserve spots. Medical OUT/IR players qualify; byes and nonmedical inactivity do not. Activate or release recovered IR players before pickups or kickoff.</li><li>Full PPR: catches 1; passing yards .04; rushing/receiving yards .1; passing TD 4; rushing/receiving TD 6; interceptions/lost offensive fumbles −2. No kickers, defenses, return or two-point bonuses.</li><li>18 NFL calendar weeks; each schedule club has one bye. Current-week OUT/BYE availability is known before kickoff.</li><li>Regular season: Weeks 1–14. Top six advance; top two get a Week 15 playoff bye. Semifinals Week 16, title Week 17. Week 18 is an exhibition victory lap.</li><li>Regular-season ties count as ties. Standings break ties by points for, then draft slot. Playoff ties advance the higher regular-season seed.</li><li>$100 FAAB. Sealed whole-dollar bids process highest first. Ties go to worse standings, then inverse draft order. Only winners pay. Dropped players clear next week.</li><li>Week 1 and post-waiver free agents cost $0. Waivers run once per week, manually or automatically before kickoff.</li><li>Lineups lock when you play the week. You can leave a slot empty or start an unavailable player, but they score zero. Past results cannot change.</li><li>${browserMode ? 'Saves stay on this device. Export a full recovery file to move to another browser or device.' : 'Autosaves belong to this server and browser. Export a recovery file to resume in another browser on this server.'} This prototype has no billing.</li></ul>`,
  );
}
function settings() {
  showDialog(
    'Commissioner’s desk',
    `<p>Your league saves after every move. ${browserMode ? 'Browser-edition recovery files contain your full save and can move it to another device.' : 'Recovery files contain a private access key; keep yours to yourself.'}</p><div class="actions" style="margin-bottom:24px">${state ? '<button class="btn" data-backup>Export recovery file</button>' : ''}<label class="btn" for="recovery-file">Import recovery file</label><input id="recovery-file" type="file" accept="application/json" hidden><button class="btn" data-new>New universe · fresh ages</button>${state?.phase === 'complete' ? '<button class="btn primary" data-continue>Next season · same universe</button>' : ''}</div><h3>Saved franchises</h3><div class="save-list">${
      saved()
        .map(
          (s) =>
            `<button data-resume="${s.id}">${esc(s.name)}<small>${esc(s.universe ?? 'Original universe')} · ${s.year ?? 2026} · ${new Date(s.date).toLocaleDateString()}${credentials?.id === s.id ? ' · Current franchise' : ''}</small></button>`,
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
    useCatalog(data.catalog);
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
  recapCache.set(w, state.latestRecap);
  showDialog(
    state.latestRecap?.headline ?? `Week ${w} complete`,
    `${game ? matchupHero(game, w) : ''}${weeklyReport(state.latestRecap)}${state.phase === 'complete' ? seasonReport(state.seasonRecap) : ''}`,
    '<button class="btn primary" data-close>Back to my team →</button>',
  );
  $('#dialog').style.width = 'min(1050px,calc(100vw - 24px))';
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
      type:
        f.dataset.activate === 'true' ? 'activate' : f.dataset.free === 'true' ? 'add' : 'claim',
      player: f.dataset.add,
      add: f.dataset.add,
      drop: f.elements.drop.value || null,
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
  if (event.target.id === 'depth-club') {
    selectedClub = event.target.value;
    render();
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
  if ('quickStart' in d) {
    await create();
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
  if ('continue' in d) {
    showDialog('Another year in this universe.', setupForm('continue'));
    return;
  }
  if ('new' in d) {
    showDialog(
      'A new football universe.',
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
      ((installPrompt = null), (selectedClub = 'DET'), (recapCache = new Map()));
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
  if ('reserve' in d) {
    if (await action({ type: 'reserve', player: d.reserve })) closeDialog();
    return;
  }
  if ('activateIr' in d) {
    acquire(d.activateIr, true);
    return;
  }
  if ('release' in d) {
    showDialog(
      'Release this player?',
      `<p>${esc(p(d.release).name)} will clear to waivers next week. This frees a roster spot.</p>`,
      `<button class="btn ghost" data-close>Keep player</button><button class="btn" data-release-confirm="${d.release}">Drop player</button>`,
    );
    return;
  }
  if ('releaseConfirm' in d) {
    if (await action({ type: 'release', player: d.releaseConfirm })) closeDialog();
    return;
  }
  if ('showRecap' in d) {
    await showWeeklyRecap(Number(d.showRecap));
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
    useCatalog(await request('/api/catalog'));
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
