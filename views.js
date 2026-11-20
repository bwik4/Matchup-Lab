/*
 * Matchup Lab - Explore layouts, Player / Team profiles, Tale Of The Tape, NBA Shot Zones, Bet Slip, Search
 * ========================================================================================================
 * Loaded after tools.js and uses the same helpers (h, $, badge, show, mean, ordinal, tUni, tDv, tProject ...).
 * Pages (all sports unless noted):
 *   #edges                    Top Edges: the clearest player-vs-defense spots on the next slate
 *   #tboard                   NBA / CBB totals board (projected total vs the line)
 *   #player/<sport>/<id>      player profile: averages, next matchup, defense vs his position, game log, shot zones (NBA)
 *   #team/<sport>/<team>      team profile: record, defense vs position, offense, roster, schedule, shot zones (NBA)
 *   #tape/<sport>/<away>/<home>  tale of the tape for one game
 *   #shots                    NBA shot zones: where defenses give up makes, who shoots from where
 * Every player name and team on these pages opens that player's or team's profile.
 * Bet slip (☰ button, bottom right) is saved in this browser: localStorage "ml-slip".
 */
'use strict';
const VX = {};
const V_SP = ['nfl', 'nba', 'cfb', 'cbb'];
const V_PAGES = ['edges', 'tboard', 'player', 'team', 'tape', 'shots'];
NEW_VIEWS.push(...V_PAGES);
['nba', 'cfb', 'cbb'].forEach((sp) => SPORT_VIEWS[sp].push('edges', 'player', 'team', 'tape'));
SPORT_VIEWS.nba.push('shots', 'tboard');
SPORT_VIEWS.cbb.push('tboard');
SWITCH_VIEWS.push('edges', 'shots');
S.vArgs = S.vArgs || [];

// ---------------------------------------------------------------- small helpers
const vRoot = () => document.querySelector(`section[data-view="${S.view}"] .vx-root`);
const vTitle = (t) => { const el = document.querySelector(`section[data-view="${S.view}"] .vx-title`); if (el) el.textContent = t; };
const vPlayerLink = (sp, pid, name, cls) => h('a', { class: `vx-link${cls ? ` ${cls}` : ''}`, href: `#player/${sp}/${encodeURIComponent(pid)}`, onclick: (e) => e.stopPropagation() }, name);
const vTeamLink = (sp, t, txt) => h('a', { class: 'vx-link', href: `#team/${sp}/${encodeURIComponent(t)}`, onclick: (e) => e.stopPropagation() }, txt || t);
const vBadge = (sp, t, size) => h('a', { class: 'vx-blink', href: `#team/${sp}/${encodeURIComponent(t)}`, title: `${TI(t).name || t}: team page`, onclick: (e) => e.stopPropagation() }, badge(t, size));
const vStatLbl = (sp, k) => {
  const own = { rush_rec_yds: 'Rush + Rec Yds', pass_rush_yds: 'Pass + Rush Yds', fp_ppr: 'Fantasy Pts', fg3m: '3PM', pra: 'PRA', pts: 'Pts', reb: 'Reb', ast: 'Ast',
    passing_yards: 'Pass Yds', passing_tds: 'Pass TDs', rushing_yards: 'Rush Yds', rushing_tds: 'Rush TDs', receiving_yards: 'Rec Yds', receiving_tds: 'Rec TDs', receptions: 'Rec', carries: 'Carries', targets: 'Targets', completions: 'Comp', attempts: 'Att', passing_interceptions: 'INT' };
  return own[k] || tTitle(tStatLabel(sp, k));
};
// rank color: 1st (toughest) red -> middle yellow -> last (easiest) green
function vRkColor(rank, n) {
  if (rank == null || !n) return 'var(--muted)';
  const t = Math.max(0, Math.min(1, (rank - 1) / Math.max(1, n - 1)));
  const [a, b, u] = t < 0.5 ? [[239, 107, 107], [232, 194, 90], t / 0.5] : [[232, 194, 90], [79, 209, 139], (t - 0.5) / 0.5];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * u)).join(',')})`;
}
const vRk = (rank, n, txt) => h('span', { class: 'vx-rk', style: `color:${vRkColor(rank, n)}`, title: rank != null ? `${ordinal(rank)} of ${n} (1st = toughest)` : null }, txt != null ? txt : ordinal(rank));
// offense: 1st = best, so color it green
const vRkOff = (rank, n) => h('span', { class: 'vx-rk', style: `color:${vRkColor(n + 1 - rank, n)}`, title: `${ordinal(rank)} of ${n}` }, ordinal(rank));
const vRkPill = (rank, n) => h('span', { class: 'vx-rkp', style: `--c:${vRkColor(rank, n)}` }, ordinal(rank));
const vCard = (title, ...kids) => h('div', { class: 'card vx-card' }, title ? h('h2', null, title) : null, ...kids);
const vSeg = (opts, cur, on, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label || null }, ...opts.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(cur === k), onclick: () => on(k) }, l)));
const vFant = (k) => !String(k).startsWith('fp') || S.fantasy;
const vGames = (sp) => (sp === 'nfl' ? DATA.games : SPX[sp]().games) || [];
const vGameRoute = (sp, g) => (sp === 'nfl' ? `game/${g.game_id}/odds` : `xgame/${sp}/${g.game_id}/odds`);
const vFinal = (sp, g) => g.status === 'final' && g.away_score != null && g.home_score != null;
const vWhen = (sp, g) => { const d = kickDate(g); return sp === 'nfl' || sp === 'cfb' ? `${dayTxt(d)} ${tmTxt(d)}` : tmTxt(d); };
const vNum = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : (Math.round(v * 10 ** d) / 10 ** d).toFixed(d));
// positions + the stats shown for each on team / tape pages
function vPosStats(sp, pos) {
  if (isBB(sp)) return ['pts', 'reb', 'ast', 'fg3m', 'pra'];
  const fb = { QB: ['passing_yards', 'passing_tds', 'rushing_yards', 'fp_ppr'], RB: ['rushing_yards', 'receptions', 'receiving_yards', 'rush_rec_yds', 'fp_ppr'],
    WR: ['receptions', 'receiving_yards', 'receiving_tds', 'fp_ppr'], TE: ['receptions', 'receiving_yards', 'receiving_tds', 'fp_ppr'] }[pos] || [];
  return fb.filter((k) => vFant(k) && (sp === 'nfl' || k !== 'fp_ppr'));
}
// next slate of games for a sport
function vSlate(sp) {
  if (sp === 'nfl') {
    const open = DATA.games.filter((g) => g.status !== 'final');
    const wk = open.some((g) => g.week === S.upWeek) ? S.upWeek : Math.min(...open.map((g) => g.week));
    return open.filter((g) => g.week === wk).map((g) => ({ g, d: kickDate(g) })).sort((a, b) => (a.d || 0) - (b.d || 0));
  }
  const X = SPX[sp]();
  if (sp === 'cfb') {
    const open = X.games.filter((g) => g.status !== 'final');
    if (!open.length) return [];
    const wk = Math.min(...open.map((g) => g.week));
    return open.filter((g) => g.week === wk).map((g) => ({ g, d: kickDate(g) })).sort((a, b) => (a.d || 0) - (b.d || 0));
  }
  return nbaSlate(X);
}
const vSlateLabel = (sp, sl) => (!sl.length ? '' : sp === 'nfl' || sp === 'cfb' ? `Week ${sl[0].g.week}` : dayLabel(sl[0].g.gameday));
function vTeams(sp) {
  if (sp === 'nfl') return DATA.teams.map((t) => t.team).sort();
  return SPX[sp]().teams.map((t) => t.team).sort();
}
// record + points for / against from finished games (this season)
const V_PTS = {};
function vTeamPts(sp) {
  const src = vGames(sp);
  if (V_PTS[sp] && V_PTS[sp].src === src) return V_PTS[sp].m;
  const season = sp === 'nfl' ? S.season : SPX[sp]().season;
  const m = new Map();
  src.forEach((g) => {
    if (!vFinal(sp, g) || (sp === 'nfl' && g.game_id && !String(g.game_id).startsWith(String(season)))) return;
    [[g.away_team, g.away_score, g.home_score], [g.home_team, g.home_score, g.away_score]].forEach(([t, pf, pa]) => {
      if (!m.has(t)) m.set(t, { n: 0, w: 0, l: 0, pf: 0, pa: 0 });
      const o = m.get(t); o.n++; o.pf += pf; o.pa += pa; if (pf > pa) o.w++; else if (pf < pa) o.l++;
    });
  });
  m.forEach((o) => { o.pfg = o.pf / o.n; o.pag = o.pa / o.n; });
  const arr = [...m.values()];
  arr.slice().sort((a, b) => b.pfg - a.pfg).forEach((o, i) => { o.pfRank = i + 1; });
  arr.slice().sort((a, b) => a.pag - b.pag).forEach((o, i) => { o.paRank = i + 1; });
  V_PTS[sp] = { src, m };
  return m;
}
function vRecord(sp, t) {
  if (sp === 'nfl') { const r = IDX.team.get(t); if (r && r.su) return r.su; }
  const gs = vGames(sp).filter((g) => (g.away_team === t || g.home_team === t) && vFinal(sp, g));
  const last = gs[gs.length - 1];
  if (last) { const rec = last.away_team === t ? last.away_record : last.home_record; if (rec) return rec; }
  const o = vTeamPts(sp).get(t); return o ? `${o.w}-${o.l}` : '';
}
// team offense per game from player logs (this season), ranked (1st = most)
const V_OFF = {};
const V_OFF_STATS = { bb: ['pts', 'reb', 'ast', 'fg3m'], fb: ['passing_yards', 'passing_tds', 'rushing_yards', 'rushing_tds', 'receptions'] };
function vTeamOff(sp) {
  const U = tUni(sp);
  if (V_OFF[sp] && V_OFF[sp].U === U) return V_OFF[sp].m;
  const keys = V_OFF_STATS[isBB(sp) ? 'bb' : 'fb'], tot = new Map();
  U.players.forEach((p) => p.logs.forEach((r) => {
    const k = `${r.team}|${p.key(r)}`;
    if (!tot.has(k)) tot.set(k, { team: r.team });
    const o = tot.get(k); keys.forEach((s) => { o[s] = (o[s] || 0) + (Number(r[s]) || 0); });
  }));
  const by = new Map();
  tot.forEach((o) => { if (!by.has(o.team)) by.set(o.team, []); by.get(o.team).push(o); });
  const m = new Map();
  by.forEach((a, t) => { const o = { n: a.length }; keys.forEach((s) => { o[s] = { pg: mean(a.map((x) => x[s])) }; }); m.set(t, o); });
  keys.forEach((s) => [...m.values()].sort((a, b) => b[s].pg - a[s].pg).forEach((o, i) => { o[s].rank = i + 1; }));
  V_OFF[sp] = { U, m, keys };
  return m;
}
// hit rate over a line in the last n games
const vHits = (vals, line, n) => { const a = vals.slice(-n); return { h: a.filter((v) => v > line).length, n: a.length }; };
const vLine = (vals) => tHalf(median(vals.slice(-10)));

// ---------------------------------------------------------------- bet slip
const vSlip = () => tStore.get('ml-slip', []);
function vSlipAdd(item) {
  const s = vSlip();
  if (!s.some((x) => x.id === item.id)) s.push({ ...item, odds: item.odds ?? -110 });
  tStore.set('ml-slip', s); vSlipBtn(); vToast(`Added to bet slip: ${item.label}`);
}
const vInSlip = (id) => vSlip().some((x) => x.id === id);
const vAddBtn = (item) => h('button', { type: 'button', class: `vx-add${vInSlip(item.id) ? ' on' : ''}`, onclick: (e) => { e.stopPropagation(); if (!vInSlip(item.id)) vSlipAdd(item); else { vSlipOpen(); } render(); } }, vInSlip(item.id) ? '✓ In Slip' : '+ Add');
function vToast(msg) {
  let t = $('.vx-toast'); if (!t) { t = h('div', { class: 'vx-toast' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1800);
}
const vDec = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
function vSlipBtn() {
  let b = $('.vx-slip-btn');
  if (!b) { b = h('button', { type: 'button', class: 'vx-slip-btn', title: 'Bet slip', onclick: vSlipOpen }); document.body.append(b); }
  const n = vSlip().length;
  b.replaceChildren(...['Bet Slip', n ? h('span', null, n) : null].filter(Boolean));
}
function vSlipOpen() {
  let d = $('.vx-slip');
  if (!d) {
    d = h('dialog', { class: 'vx-slip plog', 'aria-label': 'Bet slip' }, h('div', { class: 'plog-in vx-slip-in' }));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
  }
  vSlipDraw(); if (!d.open) d.showModal();
}
function vSlipDraw() {
  const box = $('.vx-slip-in'); if (!box) return;
  const s = vSlip();
  const save = (x) => { tStore.set('ml-slip', x); vSlipDraw(); vSlipBtn(); };
  const legs = s.map((x, i) => h('div', { class: 'vx-leg' },
    h('div', { class: 'vx-leg-tx' }, h('b', null, x.label), h('small', null, x.sub || ''),
      x.href ? h('a', { class: 'vx-link', href: x.href, onclick: () => $('.vx-slip').close() }, 'Open →') : null),
    h('input', { type: 'number', step: '5', value: x.odds, 'aria-label': 'Odds', title: 'American odds (from your book)', onchange: (e) => { const v = Number(e.target.value); if (v && Math.abs(v) >= 100) { s[i].odds = v; save(s); } } }),
    h('button', { type: 'button', class: 'vx-x', title: 'Remove', onclick: () => { s.splice(i, 1); save(s); } }, '✕')));
  const dec = s.reduce((a, x) => a * vDec(Number(x.odds) || -110), 1);
  const am = dec >= 2 ? `+${Math.round((dec - 1) * 100)}` : `${Math.round(-100 / (dec - 1))}`;
  tRC(box, h('div', { class: 'vx-slip-hd' }, h('h2', null, 'Bet Slip'), h('button', { type: 'button', class: 'vx-x', onclick: () => $('.vx-slip').close() }, '✕')),
    s.length ? [legs, h('div', { class: 'vx-slip-sum' },
      h('span', null, s.length > 1 ? `${s.length}-Leg Parlay` : 'Single'), h('b', null, am),
      h('small', null, `$10 pays $${(10 * dec).toFixed(2)}`)),
    h('p', { class: 'note' }, 'Edit each price to match your book.'),
    h('button', { type: 'button', class: 'vx-clear', onclick: () => save([]) }, 'Clear Slip')]
      : h('p', { class: 'empty' }, 'Tap + Add on any player, prop or total to build a slip.'));
}

// ---------------------------------------------------------------- global search (players + teams, current sport)
function vSearchInit() {
  const bar = $('header.bar'); if (!bar || $('.vx-search')) return;
  const wrap = h('div', { class: 'vx-search' });
  const res = h('div', { class: 'vx-sres', hidden: true });
  const inp = h('input', { type: 'search', placeholder: 'Search players, teams…', 'aria-label': 'Search players and teams',
    onfocus: () => tEnsure(S.sport), oninput: () => draw(), onkeydown: (e) => { if (e.key === 'Enter') { const a = res.querySelector('a'); if (a) { a.click(); } } if (e.key === 'Escape') { inp.value = ''; draw(); } } });
  function draw() {
    const q = inp.value.trim().toLowerCase(), sp = S.sport;
    if (q.length < 2 || !tReady(sp)) { res.hidden = true; return; }
    const U = tUni(sp);
    const ps = U.players.filter((p) => p.name.toLowerCase().includes(q)).sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || b.logs.length - a.logs.length).slice(0, 7);
    const ts = vTeams(sp).filter((t) => `${t} ${TI(t).name || ''}`.toLowerCase().includes(q)).slice(0, 4);
    const pick = () => { inp.value = ''; res.hidden = true; inp.blur(); };
    tRC(res, ...ts.map((t) => h('a', { href: `#team/${sp}/${encodeURIComponent(t)}`, onclick: pick }, badge(t, 'sm'), h('span', null, h('b', null, TI(t).name || t), h('small', null, 'Team')))),
      ...ps.map((p) => h('a', { href: `#player/${sp}/${encodeURIComponent(p.pid)}`, onclick: pick }, badge(p.team, 'sm'), h('span', null, h('b', null, p.name), h('small', null, `${p.pos} · ${p.team}`)))),
      !ts.length && !ps.length ? h('p', { class: 'empty' }, 'No matches') : null);
    res.hidden = false;
  }
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) res.hidden = true; });
  wrap.append(inp, res);
  bar.insertBefore(wrap, $('.sport-sw'));
}

// ================================================================= TOP EDGES / NBA TOTALS BOARD
VX.edges = function () {
  const sp = S.sport, root = vRoot(); if (!root) return;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  vEdges(sp, root);
};
VX.tboard = function () {
  const sp = S.sport === 'cbb' ? 'cbb' : 'nba', root = vRoot(); if (!root) return;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  vTotals(sp, root);
};

// green / red tags for one game: positions with an easy (top quarter) or tough (bottom quarter) matchup, main stat
function vMatchChips(sp, g) {
  const pos = T_POS[sp];
  const chips = (team, opp) => pos.map((p) => {
    const d = tDv(sp, opp, p, T_MAIN[p]); if (!d) return null;
    const q = (d.rank - 1) / Math.max(1, d.n - 1), easy = q >= 0.75;
    if (!easy && q > 0.25) return null;
    return h('a', { class: `vx-chip ${easy ? 'g' : 'r'}`, href: `#team/${sp}/${encodeURIComponent(opp)}`, title: `${opp} D is ${ordinal(d.rank)} of ${d.n} vs ${p} (${vStatLbl(sp, T_MAIN[p])}): ${easy ? 'easy' : 'tough'}`, onclick: (e) => e.stopPropagation() }, `${team} ${p} ${easy ? '▲' : '▼'}`);
  }).filter(Boolean);
  return [...chips(g.away_team, g.home_team), ...chips(g.home_team, g.away_team)];
}

// ---------- D: edge cards ----------
S.vEdgeI = S.vEdgeI || 0;
function vEdgeList(sp) {
  const U = tUni(sp), byPos = new Map();
  U.players.forEach((p) => {
    const stat = T_MAIN[p.pos]; if (!stat || !U.next.has(p.team) || p.missed) return;
    const pr = tProject(sp, p, stat); if (!pr || !pr.d) return;
    if (!byPos.has(p.pos)) byPos.set(p.pos, []); byPos.get(p.pos).push({ p, pr, stat });
  });
  const out = [];
  byPos.forEach((a) => {
    a.sort((x, y) => y.pr.base - x.pr.base);
    a.slice(0, Math.max(6, Math.round(a.length * (isBB(sp) ? 0.25 : 0.35)))).forEach((x) => out.push(x));
  });
  out.forEach((x) => { x.line = vLine(x.pr.vals); x.hit = vHits(x.pr.vals, x.line, 5); x.side = x.pr.f >= 1 ? 'over' : 'under'; x.score = Math.abs(x.pr.f - 1); });
  // best edges first (biggest boost from the matchup), down to the toughest spots last: green to red
  const ranked = out.filter((x) => Math.abs(x.pr.f - 1) >= 0.02).sort((a, b) => b.pr.f - a.pr.f);
  const pos = ranked.filter((x) => x.pr.f >= 1), neg = ranked.filter((x) => x.pr.f < 1);
  return [...pos.slice(0, 30), ...neg.slice(-12)];
}
function vEdges(sp, root) {
  const list = vEdgeList(sp);
  if (!list.length) { tRC(root, h('p', { class: 'empty' }, 'No upcoming games yet.')); return; }
  const i = Math.min(S.vEdgeI, list.length - 1), x = list[i], p = x.p, nx = x.pr.nx, easy = x.pr.f >= 1;
  const statL = vStatLbl(sp, x.stat);
  const item = { id: `${sp}|${p.pid}|${x.stat}|${x.side}`, sp, label: `${p.name} ${x.side === 'over' ? 'Over' : 'Under'} ${show(x.line)} ${statL}`, sub: `${p.team} ${nx.home ? 'vs' : '@'} ${nx.opp} · ${nx.label}`, href: `#player/${sp}/${p.pid}` };
  const card = h('div', { class: `vx-edge ${easy ? 'g' : 'r'}` },
    h('div', { class: 'vx-edge-top' }, h('span', { class: `vx-pill ${easy ? 'g' : 'r'}` }, easy ? 'Easy Matchup' : 'Tough Matchup'), h('small', { class: 'muted' }, `${i + 1} of ${list.length}`)),
    h('small', { class: 'muted' }, `${p.pos} vs `, vTeamLink(sp, nx.opp)),
    h('div', { class: 'vx-edge-nm' }, vPlayerLink(sp, p.pid, p.name)),
    h('small', { class: 'muted' }, vTeamLink(sp, p.team), ` · ${nx.label} ${nx.home ? 'vs' : '@'} ${nx.opp}`),
    h('div', { class: 'vx-tiles' },
      h('div', null, h('small', null, `${nx.opp} vs ${p.pos}`), h('b', { style: `color:${vRkColor(x.pr.d.rank, x.pr.d.n)}` }, ordinal(x.pr.d.rank))),
      h('div', null, h('small', null, `${statL} L5`), h('b', null, show(x.pr.l5))),
      h('div', null, h('small', null, 'Est. Line'), h('b', null, show(x.line))),
      h('div', null, h('small', null, `${x.side === 'over' ? 'Over' : 'Under'} L5`), h('b', null, `${x.side === 'over' ? x.hit.h : x.hit.n - x.hit.h}/${x.hit.n}`)),
      h('div', null, h('small', null, 'Proj'), h('b', null, show(x.pr.proj))),
      h('div', null, h('small', null, 'Season'), h('b', null, show(x.pr.seas)))),
    h('p', { class: 'muted vx-edge-why' }, `${nx.opp} allows ${show(x.pr.d.pg)} ${statL} per game to ${p.pos}s (${ordinal(x.pr.d.rank)} of ${x.pr.d.n}).`),
    h('div', { class: 'vx-edge-btns' },
      h('button', { type: 'button', onclick: () => { S.vEdgeI = (i - 1 + list.length) % list.length; render(); } }, '← Prev'),
      h('button', { type: 'button', onclick: () => { S.vEdgeI = (i + 1) % list.length; render(); } }, 'Skip →'),
      h('button', { type: 'button', class: 'pri', onclick: () => { vSlipAdd(item); S.vEdgeI = (i + 1) % list.length; render(); } }, vInSlip(item.id) ? '✓ In Slip' : '+ Bet Slip')));
  const pctTxt = (y) => { const v = Math.round((y.pr.f - 1) * 100); return `${v > 0 ? '+' : ''}${v}%`; };
  const strip = h('div', { class: 'vx-edge-strip' }, ...list.map((y, j) => h('button', { type: 'button', class: j === i ? 'on' : '', style: `--c:${vRkColor(y.pr.d.rank, y.pr.d.n)}`, onclick: () => { S.vEdgeI = j; render(); } },
    h('span', { class: 'vx-es-top' }, h('b', null, y.p.name), h('em', null, pctTxt(y))),
    h('small', null, `${y.p.pos} vs ${y.pr.nx.opp} · ${ordinal(y.pr.d.rank)} · ${vStatLbl(sp, y.stat)}`))));
  tRC(root, h('div', { class: 'vx-edge-wrap' }, card, strip), h('p', { class: 'note' }, 'Lines are estimates (his L10 median). Check your book.'));
}

// ---------- E: totals board (NBA / CBB) ----------
function vTotals(sp, root) {
  const sl = vSlate(sp), P = vTeamPts(sp);
  const rows = sl.map(({ g }) => {
    let proj = g.proj_total;
    if (proj == null) { const a = P.get(g.away_team), b = P.get(g.home_team); if (a && b) proj = (a.pfg + b.pag) / 2 + (b.pfg + a.pag) / 2; }
    const diff = proj != null && g.total_line != null ? proj - g.total_line : null;
    return { g, proj, diff };
  }).sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
  if (!rows.length) { tRC(root, h('p', { class: 'empty' }, 'No upcoming games yet.')); return; }
  const cards = rows.map(({ g, proj, diff }) => {
    const lean = diff == null ? null : diff > 2 ? 'Over' : diff < -2 ? 'Under' : null;
    const col = lean === 'Over' ? 'var(--ok)' : lean === 'Under' ? 'var(--bad)' : 'var(--muted)';
    const pct = 50 + Math.max(-45, Math.min(45, (diff || 0) * 6));
    const tabR = sp === 'cbb' ? `xgame/${sp}/${g.game_id}/totals` : vGameRoute(sp, g);
    return h('div', { class: 'card vx-tot', ...pressable(() => { S.fromHome = true; go(tabR); }) },
      h('div', { class: 'vx-tot-top' }, h('div', { class: 'vx-qt' }, vBadge(sp, g.away_team, 'sm'), vTeamLink(sp, g.away_team), h('span', { class: 'muted' }, '@'), vBadge(sp, g.home_team, 'sm'), vTeamLink(sp, g.home_team)),
        h('span', { class: 'vx-pill', style: `--c:${col}` }, lean || 'No Lean')),
      h('div', { class: 'vx-tot-nums' }, h('span', null, 'Line ', h('b', null, show(g.total_line))), h('span', null, 'Proj ', h('b', null, show(proj))),
        g.proj_tempo != null ? h('span', null, 'Pace ', h('b', null, show(g.proj_tempo))) : h('span', null, tmTxt(kickDate(g))),
        h('span', null, 'Diff ', h('b', { style: `color:${col}` }, diff == null ? '—' : `${diff > 0 ? '+' : ''}${show(diff)}`))),
      h('div', { class: 'vx-slider' }, h('i', { style: `left:${pct}%;background:${col}` })),
      (() => { if (sp === 'nba' && !VEFF.ready) { vEffLoad().then((ok) => { if (ok && S.view === 'tboard') render(); }); return null; } const c = vTotCheck(sp, g); return c ? h('div', { class: 'vx-tot-sig' }, c.call ? h('span', { class: `vx-pill ${c.call === 'Over' ? 'g' : 'r'}` }, `${c.call} Rule ✓`) : null, h('small', { class: 'muted' }, `Over rule ${c.ov}/3 · Under ${c.un}/3`)) : null; })(),
      lean && g.total_line != null ? vAddBtn({ id: `${sp}|tot|${g.game_id}|${lean}`, sp, label: `${g.away_team} @ ${g.home_team} ${lean} ${show(g.total_line)}`, sub: `Proj ${show(proj)}`, odds: lean === 'Over' ? g.over_odds ?? -110 : g.under_odds ?? -110, href: `#${tabR}` }) : null);
  });
  tRC(root, h('p', { class: 'note' }, `${vSlateLabel(sp, sl)} · ${sp === 'cbb' ? 'Projection = tempo + efficiency model' : 'Projection = each team\'s points scored and allowed per game'}. Biggest gaps first.`), h('div', { class: 'vx-totgrid' }, cards));
}

// ================================================================= PLAYER PROFILE
VX.player = function () {
  const [sp0, pid] = S.vArgs, sp = V_SP.includes(sp0) ? sp0 : S.sport;
  const root = vRoot(); if (!root) return;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  const U = tUni(sp);
  let p = U.byPid.get(String(pid));
  if (!p) {
    // not on a roster this season: build from his logs
    const logs = sp === 'nfl' ? (IDX.logs.get(pid) || []) : (SPX[sp]().byPid.get(String(pid)) || SPX[sp]().byPid.get(Number(pid)) || []);
    if (!logs.length) { vTitle('Player'); tRC(root, h('p', { class: 'empty' }, 'Player not found.')); return; }
    const last = logs[logs.length - 1];
    p = { sp, pid: String(pid), name: String(last.player).trim(), team: last.team, pos: last.position, logs, key: (r) => (sp === 'nfl' ? r.week : String(r.game_id)), missed: 0, old: true };
  }
  vTitle(p.name);
  const stats = tStats(sp, p.pos).map((x) => x[0]).filter(vFant).slice(0, 8);
  const main = T_MAIN[p.pos] || stats[0];
  const nx = U.next.get(p.team);
  const prMain = tProject(sp, p, main);
  const opp = nx && nx.opp;
  // header
  const hd = h('div', { class: 'card vx-hero vx-hero-b', style: `--tc:${TI(p.team).color}` },
    h('div', { class: 'vx-hb-l' },
      h('div', { class: 'vx-hb-id' }, vBadge(sp, p.team), h('div', null, h('h2', { class: 'vx-hero-nm' }, p.name),
        h('div', { class: 'muted' }, `${p.pos} · `, vTeamLink(sp, p.team, TI(p.team).name || p.team), p.old ? ' · not active this season' : ''),
        p.missed ? h('div', { class: 'vx-warn' }, `Missed his team's last ${p.missed} game${p.missed > 1 ? 's' : ''}`) : null)),
      h('div', { class: 'vx-actions' }, tStar(sp, p.pid),
        h('button', { type: 'button', onclick: () => tOpenPlayer(sp, p.pid, main) }, sp === 'nfl' ? 'Prop Card' : 'Game Log'),
        h('button', { type: 'button', onclick: () => { tCmpAdd(sp, p.pid); go('compare'); } }, 'Compare'))),
    nx ? h('div', { class: 'vx-nextbox' }, h('small', null, `Next Game · ${nx.label}`),
      h('div', { class: 'vx-nextopp' }, vBadge(sp, nx.opp, 'sm'), h('b', null, nx.home ? 'vs ' : '@ ', vTeamLink(sp, nx.opp, TI(nx.opp).name || nx.opp))),
      nx.g ? h('a', { class: 'vx-link', href: `#${vGameRoute(sp, nx.g)}` }, 'Game Page →') : null)
      : h('div', { class: 'vx-nextbox' }, h('small', null, 'No game scheduled')));
  // averages table: season / L10 / L5 / L3 / vs opp / proj / opp rank
  const cards = [hd];
  const avgRows = stats.map((k) => {
    const pr = tProject(sp, p, k); if (!pr) return null;
    const vsOpp = opp ? p.logs.filter((r) => r.opp === opp).map((r) => tVal(r, k)) : [];
    const line = vLine(pr.vals), hit = vHits(pr.vals, line, 10);
    return h('tr', null, h('td', { class: 'l' }, vStatLbl(sp, k)), h('td', null, show(pr.seas)), h('td', null, show(mean(pr.vals.slice(-10)))), h('td', null, show(pr.l3)),
      h('td', null, vsOpp.length ? `${show(mean(vsOpp))} (${vsOpp.length})` : '—'),
      h('td', null, h('b', null, nx ? show(pr.proj) : '—')),
      h('td', null, pr.d ? vRkPill(pr.d.rank, pr.d.n) : '—'),
      h('td', null, `${show(line)} · ${hit.h}/${hit.n}`),
      h('td', null, nx ? vAddBtn({ id: `${sp}|${p.pid}|${k}|over`, sp, label: `${p.name} Over ${show(line)} ${vStatLbl(sp, k)}`, sub: `${p.team} ${nx.home ? 'vs' : '@'} ${nx.opp}`, href: `#player/${sp}/${p.pid}` }) : null));
  }).filter(Boolean);
  // next defense vs his position, with his edges against it underneath
  if (opp) {
    const all = (isBB(sp) ? ['pts', 'reb', 'ast', 'fg3m', 'pra', 'pr', 'pa', 'ra', 'sb'] : vPosStats(sp, p.pos));
    const sim = tVsSimilar(sp, p, main, opp);
    if (sp === 'nba' && !VSH.ready && !VSH.error) vShotsLoad().then((ok) => { if (ok && S.view === 'player') render(); });
    const es = vPlayerEdges(sp, p, opp);
    const dvCard = vCard(`${opp} Defense vs ${p.pos}`,
      h('div', { class: 'vx-dvgrid' }, ...all.map((k) => { const d = tDv(sp, opp, p.pos, k); return d ? h('a', { class: 'vx-dv', href: `#team/${sp}/${encodeURIComponent(opp)}`, style: `--c:${vRkColor(d.rank, d.n)}` }, h('small', null, vStatLbl(sp, k)), h('b', null, show(d.pg)), h('span', null, ordinal(d.rank))) : null; })),
      sim ? h('p', { class: 'note' }, `Vs the ${sim.n} defenses most like ${opp}: ${show(sim.avg)} ${vStatLbl(sp, main)} (`, ...sim.opps.flatMap((o, i) => [i ? ', ' : '', vTeamLink(sp, o)]), ').') : null,
      es.length ? h('div', { class: 'vx-edges vx-edges-in' }, h('h3', null, `His Edges vs ${opp}`), ...es.map(vEdgeRow)) : null);
    dvCard.classList.add('vx-dvcard');
    cards.push(dvCard);
  }
  const avgCard = vCard('Averages & Matchup', h('div', { class: 'tblwrap' }, h('table', { class: 'dvp' },
    h('thead', null, h('tr', null, ...['Stat', 'Season', 'L10', 'L3', opp ? `Vs ${opp}` : 'Vs Opp', 'Proj', 'Opp Rank', 'Line · L10 Over', ''].map((x, i) => h('th', { class: i ? '' : 'l' }, x)))),
    h('tbody', null, avgRows))),
  h('p', { class: 'note' }, 'Opp Rank = next defense vs his position for that stat (1st = toughest). Line = his L10 median (estimate).'));
  avgCard.classList.add('vx-avg');
  cards.push(avgCard);
  // NBA / CFB / CBB: the NFL Player Stats layout (stat picker, line, seasons, games without, chart, game log, history, position vs defense)
  let ps = null;
  if (sp !== 'nfl') {
    ps = vPlayerStats(sp, p, U, nx);
    cards.push(ps.block);
    tRC(root, h('div', { class: 'vx-stack' }, cards));
    ps.mount();
    if (sp === 'nba') vShotsLoad().then((ok) => { if (ok && S.view === 'player') { const c = vShotPlayerCard(p, opp), a = root.querySelector('.vx-avg'); if (c && a && !root.querySelector('.vx-shotp')) { c.classList.add('vx-shotp'); a.after(c); } } });
    return;
  }
  if (!p.old) { const wc = vWoCard(sp, p); wc.classList.add('vx-wocard'); cards.push(wc); }
  // game log
  const last10 = p.logs.slice(-12).reverse();
  const glCols = stats.slice(0, 7);
  cards.push(vCard('Game Log', h('div', { class: 'tblwrap' }, h('table', { class: 'dvp' },
    h('thead', null, h('tr', null, h('th', { class: 'l' }, isBB(sp) ? 'Date' : 'Wk'), h('th', null, 'Opp'), h('th', null, 'Opp Rank'), ...glCols.map((k) => h('th', null, vStatLbl(sp, k))))),
    h('tbody', null, last10.map((r) => { const d = tDv(sp, r.opp, p.pos, main); return h('tr', null, h('td', { class: 'l' }, isBB(sp) ? String(r.date || '').slice(5) : `${r.season !== U.season ? `${r.season} ` : ''}${r.week}`),
      h('td', null, r.home === 0 ? '@ ' : r.home === 1 ? 'vs ' : '', vTeamLink(sp, r.opp)), h('td', null, d ? vRk(d.rank, d.n) : '—'), ...glCols.map((k) => h('td', null, show(tVal(r, k))))); })))),
  h('button', { type: 'button', class: 'tr-more', onclick: () => openLog(sp === 'nfl' ? 'nfl' : sp, p.pid) }, 'Full Game Log')));
  cards[cards.length - 1].classList.add('vx-logcard');
  if (sp === 'nfl') cards[cards.length - 1].lastChild.remove(); // NFL log lives on the prop card
  cards.push(cards.splice(cards.indexOf(avgCard), 1)[0]); // averages last: header, defense, games without + game log, averages
  tRC(root, h('div', { class: 'vx-stack' }, cards));
  if (sp === 'nba') vShotsLoad().then((ok) => { if (ok && S.view === 'player') { const c = vShotPlayerCard(p, opp), a = root.querySelector('.vx-avg'); if (c && a && !root.querySelector('.vx-shotp')) { c.classList.add('vx-shotp'); a.after(c); } } });
  void prMain;
};

// ================================================================= TEAM PROFILE
S.vTeamPos = S.vTeamPos || null;
VX.team = function () {
  const [sp0, t0] = S.vArgs, sp = V_SP.includes(sp0) ? sp0 : S.sport, t = t0;
  const root = vRoot(); if (!root) return;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  const U = tUni(sp), info = TI(t), P = vTeamPts(sp).get(t), O = vTeamOff(sp), nTeams = vTeamPts(sp).size;
  vTitle(info.name || t);
  const nx = U.next.get(t);
  const hd = h('div', { class: 'card vx-hero', style: `--tc:${info.color}` },
    h('div', { class: 'vx-hero-l' }, badge(t), h('div', null, h('h2', { class: 'vx-hero-nm' }, info.name || t), h('div', { class: 'muted' }, vRecord(sp, t) || '—'))),
    h('div', { class: 'vx-hero-r' },
      nx ? h('div', { class: 'vx-next' }, h('small', null, 'Next'), h('b', null, nx.home ? 'vs ' : '@ ', vTeamLink(sp, nx.opp)), h('small', null, nx.label),
        h('span', { class: 'vx-actions' }, nx.g ? h('a', { class: 'vx-link', href: `#${vGameRoute(sp, nx.g)}` }, 'Game Page') : null,
          h('a', { class: 'vx-link', href: `#tape/${sp}/${encodeURIComponent(nx.home ? nx.opp : t)}/${encodeURIComponent(nx.home ? t : nx.opp)}` }, 'Tale Of The Tape'))) : h('small', { class: 'muted' }, 'No game scheduled')));
  const cards = [hd];
  // quick numbers
  if (P) cards.push(h('div', { class: 'vx-tiles wide' },
    h('div', null, h('small', null, 'Pts / G'), h('b', null, show(P.pfg)), vRkOff(P.pfRank, nTeams)),
    h('div', null, h('small', null, 'Opp Pts / G'), h('b', null, show(P.pag)), vRk(P.paRank, nTeams)),
    ...(O.get(t) ? V_OFF[sp].keys.filter((k) => k !== 'pts').slice(0, 4).map((k) => h('div', null, h('small', null, `${vStatLbl(sp, k)} / G`), h('b', null, show(O.get(t)[k].pg)), vRkOff(O.get(t)[k].rank, O.size))) : [])));
  // defense vs position grid
  const pos = T_POS[sp];
  const dvTbl = h('table', { class: 'dvp' }, h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Vs'), h('th', { class: 'l' }, 'Stat'), h('th', null, 'Allowed / G'), h('th', null, 'Rank'))),
    h('tbody', null, pos.flatMap((p) => vPosStats(sp, p).map((k, i) => { const d = tDv(sp, t, p, k); return d ? h('tr', null, h('td', { class: 'l' }, i ? '' : h('b', null, p)), h('td', { class: 'l' }, vStatLbl(sp, k)), h('td', null, show(d.pg)), h('td', null, vRkPill(d.rank, d.n))) : null; }))));
  cards.push(vCard('Defense vs Position', h('div', { class: 'tblwrap' }, dvTbl), h('p', { class: 'note' }, '1st = allows the least (toughest).')));
  // roster
  const roster = U.players.filter((p) => p.team === t).map((p) => {
    const k = T_MAIN[p.pos], vals = p.logs.map((r) => tVal(r, k)).filter((v) => v != null);
    return { p, k, seas: mean(vals), l5: mean(vals.slice(-5)), g: p.logs.filter((r) => r.team === t).length };
  }).sort((a, b) => pos.indexOf(a.p.pos) - pos.indexOf(b.p.pos) || (b.seas || 0) - (a.seas || 0));
  const top = roster.filter((r) => r.g >= 1 && (r.seas > 0 || r.g >= 4)).slice(0, isBB(sp) ? 14 : 40);
  cards.push(vCard('Players', h('div', { class: 'tblwrap' }, h('table', { class: 'dvp' },
    h('thead', null, h('tr', null, ...['Player', 'Pos', 'G', 'Stat', 'Season', 'L5', 'Next Opp Rank'].map((x, i) => h('th', { class: i < 1 ? 'l' : '' }, x)))),
    h('tbody', null, top.map((r) => { const d = nx ? tDv(sp, nx.opp, r.p.pos, r.k) : null; return h('tr', { class: 'click', onclick: () => go(`player/${sp}/${r.p.pid}`) },
      h('td', { class: 'l' }, vPlayerLink(sp, r.p.pid, r.p.name), r.p.missed ? h('small', { class: 'vx-warn' }, ` out L${r.p.missed}`) : null), h('td', null, r.p.pos), h('td', null, r.g),
      h('td', null, vStatLbl(sp, r.k)), h('td', null, show(r.seas)), h('td', null, show(r.l5)), h('td', null, d ? vRkPill(d.rank, d.n) : '—')); }))))));
  // schedule
  const gs = vGames(sp).filter((g) => g.away_team === t || g.home_team === t);
  const done = gs.filter((g) => vFinal(sp, g)).slice(-6).reverse(), up = gs.filter((g) => g.status !== 'final').slice(0, 3);
  const gRow = (g) => { const home = g.home_team === t, o = home ? g.away_team : g.home_team, fin = vFinal(sp, g);
    const pf = home ? g.home_score : g.away_score, pa = home ? g.away_score : g.home_score;
    return h('a', { class: 'vx-grow', href: `#${vGameRoute(sp, g)}` }, h('small', { class: 'muted' }, sp === 'nfl' || sp === 'cfb' ? `Wk ${g.week}` : String(g.gameday).slice(5)),
      h('span', null, home ? 'vs ' : '@ ', vTeamLink(sp, o)), fin ? h('b', { class: pf > pa ? 'g' : 'r' }, `${pf > pa ? 'W' : 'L'} ${pf}-${pa}`) : h('small', { class: 'muted' }, vWhen(sp, g))); };
  cards.push(vCard('Schedule', h('div', { class: 'vx-sched' }, h('div', null, h('h3', { class: 't-h' }, 'Upcoming'), up.length ? up.map(gRow) : h('p', { class: 'empty' }, 'None')), h('div', null, h('h3', { class: 't-h' }, 'Recent'), done.length ? done.map(gRow) : h('p', { class: 'empty' }, 'None')))));
  tRC(root, h('div', { class: 'vx-stack' }, cards));
  if (sp === 'nba') vShotsLoad().then((ok) => { if (ok && S.view === 'team') { const c = vShotTeamCard(t); if (c) root.firstChild.insertBefore(c, root.firstChild.children[3] || null); } });
};

// ================================================================= C: TALE OF THE TAPE
S.vTapeTab = S.vTapeTab || 'defense';
VX.tape = function () {
  const [sp0, a, b] = S.vArgs, sp = V_SP.includes(sp0) ? sp0 : S.sport;
  const root = vRoot(); if (!root) return;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  vTitle(`${a} @ ${b}`);
  const g = vGames(sp).find((x) => x.away_team === a && x.home_team === b && x.status !== 'final') || vGames(sp).slice().reverse().find((x) => x.away_team === a && x.home_team === b);
  const P = vTeamPts(sp), O = vTeamOff(sp), n = P.size;
  const fav = g && g.spread_line != null ? (g.spread_line === 0 ? 'PK' : `${g.spread_line > 0 ? b : a} ${spreadTxt(-Math.abs(g.spread_line))}`) : '';
  const side = (t) => h('a', { class: 'vx-tape-t', href: `#team/${sp}/${encodeURIComponent(t)}` }, badge(t), h('b', null, TI(t).nick || t), h('small', null, vRecord(sp, t)));
  const hero = h('div', { class: 'card vx-tape-hero', style: `--ca:${TI(a).color};--cb:${TI(b).color}` }, side(a),
    h('div', { class: 'vx-tape-mid' }, g ? h('small', null, vWhen(sp, g)) : null, h('b', null, fav || 'vs'), g && g.total_line != null ? h('small', null, `O/U ${show(g.total_line)}`) : null,
      g ? h('a', { class: 'vx-link', href: `#${vGameRoute(sp, g)}` }, 'Game Page →') : null), side(b));
  // a row of mirrored bars; longer bar = easier matchup for the other side (rank closer to last)
  const bar = (label, va, ra, vb, rb, nn) => h('div', { class: 'vx-bar' },
    h('div', { class: 'vx-bar-hd' }, h('span', null, h('b', null, va), ' ', vRk(ra, nn)), h('small', null, label), h('span', null, vRk(rb, nn), ' ', h('b', null, vb))),
    h('div', { class: 'vx-bar-tr' }, h('div', { class: 'l' }, h('i', { style: `width:${ra ? (ra / nn) * 100 : 0}%;background:${vRkColor(ra, nn)}` })), h('div', { class: 'r' }, h('i', { style: `width:${rb ? (rb / nn) * 100 : 0}%;background:${vRkColor(rb, nn)}` }))));
  const tabs = [['defense', 'Defense'], ['offense', 'Offense'], ['players', 'Players'], ['results', 'Results']];
  const body = [];
  if (S.vTapeTab === 'defense') {
    const pa = P.get(a), pb = P.get(b);
    if (pa && pb) body.push(bar('Pts Allowed', show(pa.pag), pa.paRank, show(pb.pag), pb.paRank, n));
    T_POS[sp].forEach((p) => vPosStats(sp, p).slice(0, isBB(sp) ? 4 : 2).forEach((k) => { const da = tDv(sp, a, p, k), db = tDv(sp, b, p, k); if (da && db) body.push(bar(`${p} ${vStatLbl(sp, k)} Allowed`, show(da.pg), da.rank, show(db.pg), db.rank, da.n)); }));
    body.push(h('p', { class: 'note' }, 'Rank 1st = toughest defense. Longer, greener bar = easier for the other offense.'));
  } else if (S.vTapeTab === 'offense') {
    const pa = P.get(a), pb = P.get(b), oa = O.get(a), ob = O.get(b);
    if (pa && pb) body.push(bar('Pts Scored', show(pa.pfg), n + 1 - pa.pfRank, show(pb.pfg), n + 1 - pb.pfRank, n));
    if (oa && ob) V_OFF[sp].keys.forEach((k) => body.push(bar(`${vStatLbl(sp, k)} / G`, show(oa[k].pg), O.size + 1 - oa[k].rank, show(ob[k].pg), O.size + 1 - ob[k].rank, O.size)));
    body.push(h('p', { class: 'note' }, 'Offense: longer, greener bar = better offense (rank shown is from the bottom).'));
  } else if (S.vTapeTab === 'players') {
    const U = tUni(sp);
    const col = (t, o) => h('div', null, h('h3', { class: 't-h' }, t), ...U.players.filter((p) => p.team === t && !p.missed).map((p) => ({ p, v: mean(p.logs.map((r) => tVal(r, T_MAIN[p.pos])).filter((x) => x != null)) }))
      .sort((x, y) => T_POS[sp].indexOf(x.p.pos) - T_POS[sp].indexOf(y.p.pos) || y.v - x.v).filter((x, i, arr) => arr.filter((z) => z.p.pos === x.p.pos).indexOf(x) < (isBB(sp) ? 3 : x.p.pos === 'QB' ? 1 : 3))
      .map(({ p, v }) => { const d = tDv(sp, o, p.pos, T_MAIN[p.pos]); return h('a', { class: 'vx-grow', href: `#player/${sp}/${p.pid}` }, h('small', { class: 'muted' }, p.pos), h('span', null, p.name), h('span', null, show(v), ' ', d ? vRk(d.rank, d.n) : '')); }));
    body.push(h('div', { class: 'vx-sched' }, col(a, b), col(b, a)), h('p', { class: 'note' }, 'Season average at his main stat · rank = opponent defense vs his position.'));
  } else {
    const res = (t) => { const gs = vGames(sp).filter((x) => (x.away_team === t || x.home_team === t) && vFinal(sp, x)).slice(-5).reverse();
      return h('div', null, h('h3', { class: 't-h' }, t), gs.map((x) => { const home = x.home_team === t, pf = home ? x.home_score : x.away_score, pa = home ? x.away_score : x.home_score;
        return h('a', { class: 'vx-grow', href: `#${vGameRoute(sp, x)}` }, h('span', null, home ? 'vs ' : '@ ', vTeamLink(sp, home ? x.away_team : x.home_team)), h('b', { class: pf > pa ? 'g' : 'r' }, `${pf > pa ? 'W' : 'L'} ${pf}-${pa}`)); })); };
    body.push(h('div', { class: 'vx-sched' }, res(a), res(b)));
  }
  tRC(root, h('div', { class: 'vx-stack vx-tape' }, hero, h('div', { class: 'card' }, h('div', { class: 't-controls' }, vSeg(tabs, S.vTapeTab, (k) => { S.vTapeTab = k; render(); }, 'Section')), ...body)));
};

// ================================================================= NBA SHOT ZONES
const VSH = { ready: false, loading: null, error: false };
const ZN = [['ra', 'Restricted Area'], ['paint', 'Paint (Non-RA)'], ['mid', 'Mid-Range'], ['c3', 'Corner 3'], ['ab3', 'Above The Break 3']];
const ZS = { ra: 'RA', paint: 'Paint', mid: 'Mid', c3: 'Corner 3', ab3: 'Above Break 3' };
function vShotsLoad() {
  if (VSH.loading) return VSH.loading;
  const b = `?v=${Date.now()}`;
  VSH.loading = Promise.all([
    d3.csv(`data/nba/shot_team.csv${b}`).then((r) => { VSH.team = r.map(clean); }),
    d3.csv(`data/nba/shot_player.csv${b}`).then((r) => { VSH.player = r.map(clean); }),
    fetch(`data/nba/shots_meta.txt${b}`).then((r) => r.text()).then((t) => { VSH.meta = Object.fromEntries(t.trim().split('\n').map((l) => l.split('='))); }).catch(() => { VSH.meta = {}; }),
  ]).then(() => {
    VSH.t = new Map(VSH.team.map((r) => [`${r.side}|${r.team}|${r.position}|${r.zone}`, r]));
    VSH.p = new Map(); VSH.player.forEach((r) => { const k = String(r.player_id); if (!VSH.p.has(k)) VSH.p.set(k, {}); VSH.p.get(k)[r.zone] = r; });
    VSH.nT = new Set(VSH.team.map((r) => r.team)).size;
    // league FG% by zone (offense, all players)
    VSH.lg = {}; ZN.forEach(([z]) => { const a = VSH.team.filter((r) => r.side === 'off' && r.position === 'ALL' && r.zone === z); const fga = a.reduce((s, r) => s + r.fga_pg * r.games, 0), fgm = a.reduce((s, r) => s + r.fgm_pg * r.games, 0); VSH.lg[z] = fga ? (fgm / fga) * 100 : null; });
    VSH.ready = true; return true;
  }).catch((e) => { VSH.error = true; console.error(e); return false; });
  return VSH.loading;
}
// half court with the 5 zones; vals[z] = { fill, big, small }
function vCourt(vals, title) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-1 -1 52 37'); svg.setAttribute('class', 'vx-court'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title || 'Shot zones');
  const add = (tag, at, txt) => { const e = document.createElementNS(ns, tag); Object.entries(at).forEach(([k, v]) => e.setAttribute(k, v)); if (txt != null) e.textContent = txt; svg.append(e); return e; };
  const HX = 25, HY = 5.25, R3 = 23.75;
  const arc = `M3 0 L3 14 A${R3} ${R3} 0 0 0 47 14 L47 0 Z`;
  const z = (k) => (vals[k] || {}).fill || 'var(--item)';
  add('rect', { x: 0, y: 0, width: 50, height: 35, fill: z('ab3') });
  add('path', { d: arc, fill: z('mid') });
  add('rect', { x: 0, y: 0, width: 3, height: 14, fill: z('c3') }); add('rect', { x: 47, y: 0, width: 3, height: 14, fill: z('c3') });
  add('rect', { x: 17, y: 0, width: 16, height: 19, fill: z('paint') });
  add('path', { d: `M${HX - 4} 0 L${HX - 4} ${HY} A4 4 0 0 0 ${HX + 4} ${HY} L${HX + 4} 0 Z`, fill: z('ra') });
  const ln = { fill: 'none', stroke: 'var(--bg)', 'stroke-width': 0.35 };
  add('path', { d: arc, ...ln }); add('rect', { x: 17, y: 0, width: 16, height: 19, ...ln }); add('rect', { x: 0, y: 0, width: 50, height: 35, ...ln });
  add('path', { d: `M${HX - 4} 0 L${HX - 4} ${HY} A4 4 0 0 0 ${HX + 4} ${HY} L${HX + 4} 0`, ...ln });
  add('circle', { cx: HX, cy: HY, r: 0.75, fill: 'none', stroke: 'var(--bg)', 'stroke-width': 0.3 });
  const lab = (k, x, y, rot, dy = 2.2) => { const v = vals[k]; if (!v) return; const g = add('g', { transform: `translate(${x} ${y})${rot ? ` rotate(${rot})` : ''}` });
    const t1 = document.createElementNS(ns, 'text'); t1.setAttribute('class', 'vx-cb'); t1.setAttribute('text-anchor', 'middle'); t1.textContent = v.big; g.append(t1);
    if (v.small) { const t2 = document.createElementNS(ns, 'text'); t2.setAttribute('class', 'vx-cs'); t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('y', dy); t2.textContent = v.small; g.append(t2); } };
  lab('ra', 25, 3.2, 0, 5.3); lab('paint', 25, 14); lab('mid', 9.5, 9); lab('mid', 40.5, 9); lab('ab3', 25, 31.2); lab('c3', 1.6, 7, -90); lab('c3', 48.4, 7, 90);
  return svg;
}
const vShotCell = (r, n, key) => (r ? h('span', { class: 'vx-zc', style: `--c:${vRkColor(r[`rank_${key}`], n)}`, title: `${ordinal(r[`rank_${key}`])} of ${n}` }, key === 'pct' ? `${vNum(r.fg_pct)}%` : key === 'fga' ? vNum(r.fga_pg) : vNum(r.fgm_pg)) : '—');
S.vShot = S.vShot || { pos: 'ALL', key: 'fgm', zone: 'ab3', q: '', more: false, side: 'def' };
VX.shots = function () {
  vTitle('Shot Zones');
  const root = vRoot(); if (!root) return;
  if (!tEnsure('nba')) { tLoading(root, 'nba'); return; }
  if (!VSH.ready) { tRC(root, h('p', { class: 'empty' }, VSH.error ? 'Shot data isn\'t built yet. It appears after the next daily update.' : 'Loading shot zones…')); if (!VSH.error) vShotsLoad().then(render); return; }
  const Z = S.vShot, n = VSH.nT, def = Z.side === 'def';
  // 1. defenses / offenses by zone
  const teams = [...new Set(VSH.team.map((r) => r.team))];
  const cols = [{ k: 'team', label: 'Team', l: true, fmt: (r) => h('span', { class: 'vx-pcell' }, vBadge('nba', r.team, 'sm'), vTeamLink('nba', r.team)) },
    ...ZN.map(([z]) => ({ k: z, label: ZS[z], sv: (r) => (r[z] ? (Z.key === 'pct' ? r[z].fg_pct : Z.key === 'fga' ? r[z].fga_pg : r[z].fgm_pg) : null), fmt: (r) => vShotCell(r[z], n, Z.key) }))];
  const rows = teams.map((t) => { const o = { team: t }; ZN.forEach(([z]) => { o[z] = VSH.t.get(`${Z.side}|${t}|${Z.pos}|${z}`); }); return o; });
  const tt = tTable(`vshots-${Z.side}`, cols, rows, { sort: { k: 'ab3', dir: 'desc' } });
  const c1 = vCard(def ? 'Where Defenses Give Up Shots' : 'Where Offenses Shoot From',
    h('div', { class: 't-controls' }, vSeg([['def', 'Defense'], ['off', 'Offense']], Z.side, (k) => { Z.side = k; render(); }, 'Side'),
      vSeg([['ALL', 'All'], ['G', 'Guards'], ['F', 'Forwards'], ['C', 'Centers']], Z.pos, (k) => { Z.pos = k; render(); }, 'Shooter position'),
      vSeg([['fgm', 'Makes / G'], ['fga', 'Attempts / G'], ['pct', 'FG%']], Z.key, (k) => { Z.key = k; render(); }, 'Measure')),
    h('p', { class: 'note' }, def ? `What each defense allows${Z.pos === 'ALL' ? '' : ` to ${{ G: 'guards', F: 'forwards', C: 'centers' }[Z.pos]}`}. Red = allows the least (tough) · Green = the most (easy). Tap a column to sort.` : `Per game by zone${Z.pos === 'ALL' ? '' : `, ${{ G: 'guards', F: 'forwards', C: 'centers' }[Z.pos]} only`}. Green = most.`),
    h('div', { class: 'tblwrap' }, tt.el));
  // 2. best spots on the next slate
  const sl = nbaSlate(NBA), oppOf = new Map(); sl.forEach(({ g }) => { oppOf.set(g.away_team, g.home_team); oppOf.set(g.home_team, g.away_team); });
  const U = tUni('nba'), spots = [];
  VSH.p.forEach((zs, pid) => {
    const p = U.byPid.get(pid); if (!p || p.missed || !oppOf.has(p.team)) return;
    const opp = oppOf.get(p.team);
    ZN.forEach(([z]) => { const r = zs[z]; if (!r || r.games < 3 || r.fgm_pg < 1) return; const d = VSH.t.get(`def|${opp}|${p.pos}|${z}`); if (!d || d.rank_fgm < n - 7) return;
      spots.push({ p, z, r, d, opp, s: r.fgm_pg * (d.rank_fgm / n) }); });
  });
  spots.sort((a, b) => b.s - a.s);
  const c2 = vCard(`Best Spots · ${sl.length ? dayLabel(sl[0].g.gameday) : 'Next Slate'}`,
    spots.length ? h('div', { class: 'vx-spots' }, spots.slice(0, 12).map((x) => h('a', { class: 'vx-spot', href: `#player/nba/${x.p.pid}` }, badge(x.p.team, 'sm'),
      h('span', null, h('b', null, x.p.name), h('small', null, `${ZS[x.z]} · ${vNum(x.r.fgm_pg)} makes/g · ${vNum(x.r.fg_pct)}%`)),
      h('span', { class: 'vx-spot-r' }, h('small', null, `${x.opp} allows ${vNum(x.d.fgm_pg)} to ${x.p.pos}s`), vRkPill(x.d.rank_fgm, n))))) : h('p', { class: 'empty' }, 'No standout spots on the next slate.'),
    h('p', { class: 'note' }, 'Players who make 1+ per game from a zone where tonight\'s opponent allows the most makes to his position.'));
  // 3. who shoots from where
  const pl = []; VSH.p.forEach((zs, pid) => { const r = zs[Z.zone]; if (!r || r.games < 3 || (Z.q && !String(r.player).toLowerCase().includes(Z.q))) return; pl.push({ ...r, pid, nx: U.next.get(r.team) }); });
  const pcols = [
    { k: 'player', label: 'Player', l: true, fmt: (r) => h('span', { class: 'vx-pcell' }, vBadge('nba', r.team, 'sm'), vPlayerLink('nba', r.pid, r.player)) },
    { k: 'position', label: 'Pos' }, { k: 'fgm_pg', label: 'Makes / G', fmt: (r) => h('b', null, vNum(r.fgm_pg)) }, { k: 'fga_pg', label: 'Att / G', fmt: (r) => vNum(r.fga_pg) },
    { k: 'fg_pct', label: 'FG%', fmt: (r) => h('span', { style: `color:${r.fg_pct >= (VSH.lg[Z.zone] || 0) ? 'var(--ok)' : 'var(--muted)'}` }, `${vNum(r.fg_pct)}%`) },
    { k: 'share', label: 'Share', title: 'Share of his shots from this zone', fmt: (r) => `${Math.round(r.share)}%` },
    { k: 'ast_pct', label: 'Ast\'d %', title: 'Share of his makes here that were assisted (catch-and-shoot / open-look stand-in)', fmt: (r) => (r.ast_pct == null ? '—' : `${Math.round(r.ast_pct)}%`) },
    { k: 'rank_fgm', label: 'Rank', asc: true, fmt: (r) => (r.rank_fgm ? ordinal(r.rank_fgm) : '—') },
    { k: 'next', label: 'Next Opp Allows', sv: (r) => { const d = r.nx && VSH.t.get(`def|${r.nx.opp}|${r.position}|${Z.zone}`); return d ? d.rank_fgm : null; },
      fmt: (r) => { const d = r.nx && VSH.t.get(`def|${r.nx.opp}|${r.position}|${Z.zone}`); return d ? h('span', null, `${r.nx.opp} `, vRkPill(d.rank_fgm, n)) : '—'; } },
  ];
  const pt = tTable(`vshots-pl-${Z.zone}`, pcols, pl, { sort: { k: 'fgm_pg', dir: 'desc' }, limit: Z.more ? 500 : 25 });
  const c3 = vCard('Who Shoots From Where',
    h('div', { class: 't-controls' }, vSeg(ZN.map(([z]) => [z, ZS[z]]), Z.zone, (k) => { Z.zone = k; render(); }, 'Zone'),
      h('input', { type: 'search', class: 't-search', placeholder: 'Player…', value: Z.q, 'aria-label': 'Filter players', oninput: (e) => { Z.q = e.target.value.trim().toLowerCase(); const ps = e.target.selectionStart; render(); const el = $('section[data-view="shots"] .t-search'); if (el) { el.focus(); el.setSelectionRange(ps, ps); } } })),
    h('div', { class: 'tblwrap' }, pt.el),
    pt.total > pt.shown || Z.more ? h('button', { type: 'button', class: 'tr-more', onclick: () => { Z.more = !Z.more; render(); } }, Z.more ? 'Show Less' : `Show All ${pt.total}`) : null,
    h('p', { class: 'note' }, `League FG% here: ${vNum(VSH.lg[Z.zone])}%. Rank = league rank in makes per game from this zone. Free data has no defender-distance tracking, so Ast'd % stands in for open looks.`));
  tRC(root, h('div', { class: 'vx-stack' }, c2, c1, c3, VSH.meta && VSH.meta.through_date ? h('p', { class: 'note' }, `Through ${VSH.meta.through_date} · ${VSH.meta.games} games · ${Number(VSH.meta.shots).toLocaleString()} shots (ESPN play-by-play)`) : null));
};
S.vTeamShotPos = S.vTeamShotPos || 'ALL';
function vShotTeamCard(t) {
  if (!VSH.ready || !VSH.t.has(`def|${t}|ALL|ra`)) return null;
  const n = VSH.nT, pos = S.vTeamShotPos;
  const dv = {}, ov = {};
  ZN.forEach(([z]) => {
    const d = VSH.t.get(`def|${t}|${pos}|${z}`), o = VSH.t.get(`off|${t}|ALL|${z}`);
    if (d) dv[z] = { fill: vRkColor(d.rank_fgm, n), big: vNum(d.fgm_pg), small: `${vNum(d.fg_pct, 0)}% · ${ordinal(d.rank_fgm)}` };
    if (o) ov[z] = { fill: `color-mix(in srgb, ${vRkColor(n + 1 - o.rank_fgm, n)} 85%, var(--bg))`, big: vNum(o.fgm_pg), small: `${vNum(o.fg_pct, 0)}% · ${Math.round(o.share)}%` };
  });
  const shooters = []; VSH.p.forEach((zs, pid) => ZN.forEach(([z]) => { const r = zs[z]; if (r && r.team === t && r.games >= 3 && r.fgm_pg >= 0.8) shooters.push({ pid, z, r }); }));
  shooters.sort((a, b) => b.r.fgm_pg - a.r.fgm_pg);
  const card = vCard('Shot Zones',
    h('div', { class: 't-controls' }, h('span', { class: 'lbl' }, 'Defense vs'), vSeg([['ALL', 'All'], ['G', 'G'], ['F', 'F'], ['C', 'C']], pos, (k) => { S.vTeamShotPos = k; const old = $('.vx-shotcard'); const nw = vShotTeamCard(t); if (old && nw) old.replaceWith(nw); })),
    h('div', { class: 'vx-courts' },
      h('figure', null, vCourt(dv, 'Defense allows'), h('figcaption', null, `Defense allows (makes / G${pos === 'ALL' ? '' : ` to ${pos}`}) · red = tough`)),
      h('figure', null, vCourt(ov, 'Offense'), h('figcaption', null, 'Offense makes / G · FG% · share'))),
    shooters.length ? h('div', null, h('h3', { class: 't-h' }, 'Top Shooters By Zone'), h('div', { class: 'vx-spots' }, shooters.slice(0, 8).map((x) => h('a', { class: 'vx-spot', href: `#player/nba/${x.pid}` },
      h('span', null, h('b', null, x.r.player), h('small', null, `${ZS[x.z]} · ${x.r.position}`)), h('span', { class: 'vx-spot-r' }, h('b', null, vNum(x.r.fgm_pg)), h('small', null, ` makes/g · ${vNum(x.r.fg_pct)}%`)))))) : null,
    h('a', { class: 'vx-link', href: '#shots' }, 'All Shot Zones →'));
  card.classList.add('vx-shotcard');
  return card;
}
function vShotPlayerCard(p, opp) {
  const zs = VSH.p.get(String(p.pid)); if (!zs) return null;
  const n = VSH.nT, lg = VSH.lg;
  const cv = {}; ZN.forEach(([z]) => { const r = zs[z]; if (r) { const d = (r.fg_pct || 0) - (lg[z] || 0); cv[z] = { fill: d >= 5 ? 'rgba(79,209,139,.75)' : d >= 0 ? 'rgba(79,209,139,.4)' : d >= -5 ? 'rgba(232,194,90,.4)' : 'rgba(239,107,107,.55)', big: vNum(r.fgm_pg), small: `${vNum(r.fg_pct, 0)}% · ${Math.round(r.share)}%` }; } });
  const rows = ZN.map(([z, nm]) => { const r = zs[z], d = opp ? VSH.t.get(`def|${opp}|${p.pos}|${z}`) : null;
    return h('tr', null, h('td', { class: 'l' }, nm), h('td', null, r ? vNum(r.fga_pg) : '—'), h('td', null, h('b', null, r ? vNum(r.fgm_pg) : '—')),
      h('td', null, r ? h('span', { style: `color:${r.fg_pct >= (lg[z] || 0) ? 'var(--ok)' : 'var(--muted)'}` }, `${vNum(r.fg_pct)}%`) : '—'), h('td', null, r ? `${Math.round(r.share)}%` : '—'),
      h('td', null, r && r.ast_pct != null ? `${Math.round(r.ast_pct)}%` : '—'), h('td', null, r && r.rank_fgm ? ordinal(r.rank_fgm) : '—'),
      opp ? h('td', null, d ? h('span', null, `${vNum(d.fgm_pg)} `, vRkPill(d.rank_fgm, n)) : '—') : null); });
  return vCard('Shot Zones',
    h('div', { class: 'vx-courts one' }, h('figure', null, vCourt(cv, 'His shot zones'), h('figcaption', null, 'Makes / G · FG% · share of his shots · green = above league FG%'))),
    h('div', { class: 'tblwrap' }, h('table', { class: 'dvp' }, h('thead', null, h('tr', null, ...['Zone', 'Att / G', 'Makes / G', 'FG%', 'Share', 'Ast\'d %', 'Lg Rank', ...(opp ? [`${opp} Allows To ${p.pos}`] : [])].map((x, i) => h('th', { class: i ? '' : 'l' }, x)))), h('tbody', null, rows))),
    h('p', { class: 'note' }, `Lg Rank = his rank in makes per game from that zone. ${opp ? `${opp} column = makes per game allowed to ${p.pos}s there (green = easy).` : ''}`));
}

// ---------------------------------------------------------------- start-up
// a direct link (or refresh) to one of these pages ran the router before this file added them: route again
if (V_PAGES.includes(location.hash.slice(1).split('/')[0])) applyRoute();
vSearchInit();
vSlipBtn();
window.addEventListener('storage', (e) => { if (e.key === 'ml-slip') vSlipBtn(); });
if (DATA.teams) render();

// ================================================================= MATCHUP EDGES
// For one player vs one defense: the few spots where a strong part of HIS game meets a weak part of THEIR defense.
// Nothing is shown when nothing lines up. Used on player profiles and on every game page (Matchup tab).
const V_EDGE_SKIP = /tds?$|_tds|interceptions|long_|^fp|pra|^pr$|^pa$|^ra$|^sb$|rush_rec|pass_rush/;
const V_PCT = {};
// where his season average ranks among regulars at his position (0..1, 1 = best)
function vPctOf(sp, p, stat, v) {
  const U = tUni(sp), key = `${p.pos}|${stat}`;
  if (!V_PCT[sp] || V_PCT[sp].U !== U) V_PCT[sp] = { U, m: new Map() };
  const M = V_PCT[sp].m;
  if (!M.has(key)) M.set(key, U.players.filter((x) => x.pos === p.pos && x.logs.length >= 3).map((x) => mean(x.logs.map((r) => tVal(r, stat)).filter((y) => y != null))).filter((y) => y != null && !Number.isNaN(y)).sort((a, b) => a - b));
  const arr = M.get(key); if (arr.length < 8) return null;
  let i = 0; while (i < arr.length && arr[i] < v) i++;
  return i / arr.length;
}
function vPlayerEdges(sp, p, opp) {
  if (!opp || !p || p.logs.length < 3) return [];
  const out = [], posL = { G: 'guards', F: 'forwards', C: 'centers' }[p.pos] || `${p.pos}s`;
  tStats(sp, p.pos).map((x) => x[0]).filter((k) => !V_EDGE_SKIP.test(k)).forEach((k) => {
    const vals = p.logs.map((r) => tVal(r, k)).filter((v) => v != null);
    if (vals.length < 3) return;
    const seas = mean(vals), l5 = mean(vals.slice(-5)), d = tDv(sp, opp, p.pos, k);
    if (!d || !seas) return;
    const ease = (d.rank - 1) / Math.max(1, d.n - 1), pct = vPctOf(sp, p, k, seas);
    if (ease < 0.72 || pct == null || pct < 0.6 || l5 < seas * 0.85) return;
    const most = d.n + 1 - d.rank, top = Math.max(1, Math.round((1 - pct) * 100));
    out.push({ k, score: ease * pct * Math.min(1.3, l5 / seas), label: vStatLbl(sp, k),
      txt: `${opp} gives ${posL} the ${most === 1 ? 'most' : `${ordinal(most)}-most`} (${show(d.pg)}/g). He averages ${show(seas)}${vals.length >= 5 ? `, L5 ${show(l5)}` : ''} (top ${top}% of ${posL}).` });
  });
  // vs the defenses most like this one
  const main = T_MAIN[p.pos];
  if (main) {
    const sim = tVsSimilar(sp, p, main, opp), seas = mean(p.logs.map((r) => tVal(r, main)).filter((v) => v != null));
    const reg = seas ? vPctOf(sp, p, main, seas) : null;
    if (sim && sim.n >= 2 && seas && reg != null && reg >= 0.5 && sim.avg >= seas * 1.2) out.push({ k: `sim-${main}`, score: 0.55 + Math.min(0.3, sim.avg / seas - 1.2), label: 'Similar D',
      txt: `Vs the ${sim.n} defenses most like ${opp}: ${show(sim.avg)} ${vStatLbl(sp, main)} (season ${show(seas)}).` });
  }
  // NBA shot zones: he makes a lot from a zone where this defense gives his position the most
  if (sp === 'nba' && VSH.ready) {
    const zs = VSH.p.get(String(p.pid)), n = VSH.nT;
    if (zs) ZN.forEach(([z]) => {
      const r = zs[z], dz = VSH.t.get(`def|${opp}|${p.pos}|${z}`);
      if (!r || !dz || r.games < 3 || r.fgm_pg < 1 || r.fg_pct < (VSH.lg[z] || 0) + 1) return;
      if (dz.rank_fgm < n - 7) return;
      const most = n + 1 - dz.rank_fgm;
      out.push({ k: `zone-${z}`, score: 0.7 + (dz.rank_fgm / n) * 0.2 + Math.min(0.2, r.fgm_pg / 20), label: ZS[z],
        txt: `${opp} gives ${posL} the ${most === 1 ? 'most' : `${ordinal(most)}-most`} makes there (${vNum(dz.fgm_pg)}/g at ${vNum(dz.fg_pct, 0)}%). He makes ${vNum(r.fgm_pg)}/g at ${vNum(r.fg_pct, 0)}% (league ${vNum(VSH.lg[z], 0)}%).` });
    });
  }
  // keep combos from repeating the same idea: one rec-yds-type edge per family
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score).filter((e) => { const fam = e.k.replace(/receiving_yards|receptions|targets/, 'rec').replace(/rushing_yards|carries/, 'rush').replace(/passing_yards|attempts|completions/, 'pass'); if (seen.has(fam)) return false; seen.add(fam); return true; }).slice(0, 3);
}
const vEdgeRow = (e) => h('div', { class: 'vx-edge-ln' }, h('span', { class: 'vx-edge-k' }, e.label), h('span', null, e.txt));
// game page: the players with the clearest edges in this game (both teams), one line each
function vGameEdges(sp, g, host) {
  if (!host) return;
  host.hidden = true;
  if (!g || g.status === 'final' || !tEnsure(sp)) { host.replaceChildren(); if (!tReady(sp)) tEnsure(sp); return; }
  if (sp === 'nba' && !VSH.ready && !VSH.error) vShotsLoad().then((ok) => { if (ok) render(); });
  const U = tUni(sp), rows = [];
  [[g.away_team, g.home_team], [g.home_team, g.away_team]].forEach(([t, opp]) => U.players.filter((p) => p.team === t && !p.missed).forEach((p) => {
    const es = vPlayerEdges(sp, p, opp); if (es.length) rows.push({ p, es, score: es[0].score + 0.05 * (es.length - 1) });
  }));
  rows.sort((a, b) => b.score - a.score);
  const chips = vMatchChips(sp, g);
  if (!rows.length && !chips.length) { host.replaceChildren(); return; }
  const open = S.vEdgeAll, list = open ? rows : rows.slice(0, 5);
  host.replaceChildren(h('div', { class: 'bar' }, h('h2', null, 'Player Edges'), h('small', { class: 'muted' }, 'Where a strength meets a soft spot')),
    chips.length ? h('div', { class: 'vx-qc vx-gchips' }, ...chips) : null,
    ...list.map(({ p, es }) => h('div', { class: 'vx-gedge' },
      h('div', { class: 'vx-gedge-who' }, badge(p.team, 'sm'), vPlayerLink(sp, p.pid, p.name), h('small', { class: 'muted' }, p.pos)),
      h('div', { class: 'vx-gedge-list' }, ...es.slice(0, open ? 3 : 2).map(vEdgeRow)))),
    ...(rows.length > 5 ? [h('button', { type: 'button', class: 'more', onclick: () => { S.vEdgeAll = !S.vEdgeAll; render(); } }, open ? 'Show fewer' : `All ${rows.length} players with an edge`)] : []));
  host.hidden = false;
}

// ================================================================= TOTALS CHECK (NBA / CBB)
// Ben's over rule: both teams top 10 in offensive efficiency, both bottom 10 in defensive efficiency, both top 10 in possessions per game.
// The under is the mirror: both bottom 10 on offense, both top 10 on defense, both bottom 10 in possessions.
// NBA numbers come from data/nba/team_eff.csv (nba_shots.py); CBB from data/cbb/ratings.csv (adjusted efficiency and tempo).
const VEFF = { ready: false, loading: null };
function vEffLoad() {
  if (VEFF.loading) return VEFF.loading;
  VEFF.loading = d3.csv(`data/nba/team_eff.csv?v=${Date.now()}`).then((r) => { VEFF.m = new Map(r.map(clean).map((x) => [x.team, x])); VEFF.n = VEFF.m.size; VEFF.ready = true; return true; }).catch(() => { VEFF.error = true; return false; });
  return VEFF.loading;
}
function vTotEff(sp, t) {
  if (sp === 'cbb') { const r = CBB.rt && CBB.rt.get(t); return r ? { o: r.adj_o, ork: r.adj_o_rk, d: r.adj_d, drk: r.adj_d_rk, p: r.adj_t, prk: r.adj_t_rk, n: CBB.nRt || 365 } : null; }
  if (sp === 'nba') { if (!VEFF.ready) return null; const r = VEFF.m.get(t); return r ? { o: r.off_eff, ork: r.off_eff_rk, d: r.def_eff, drk: r.def_eff_rk, p: r.pace, prk: r.pace_rk, n: VEFF.n } : null; }
  return null;
}
function vTotCheck(sp, g) {
  const A = vTotEff(sp, g.away_team), H = vTotEff(sp, g.home_team);
  if (!A || !H) return null;
  // NBA: literal top / bottom 10 of 30. CBB has ~365 teams, so top 10 would almost never happen: use the top / bottom 10% (about 36) instead
  const n = A.n, cut = sp === 'cbb' ? Math.round(n * 0.1) : 10, top = (r) => r <= cut, bot = (r) => r > n - cut;
  const rows = [
    { lab: 'Offensive efficiency', a: A.ork, b: H.ork, av: A.o, bv: H.o, over: top, under: bot },
    { lab: 'Defensive efficiency', a: A.drk, b: H.drk, av: A.d, bv: H.d, over: bot, under: top },
    { lab: 'Possessions / game', a: A.prk, b: H.prk, av: A.p, bv: H.p, over: top, under: bot },
  ];
  const ov = rows.filter((r) => r.over(r.a) && r.over(r.b)).length, un = rows.filter((r) => r.under(r.a) && r.under(r.b)).length;
  return { rows, n, cut, ov, un, call: ov === 3 ? 'Over' : un === 3 ? 'Under' : null };
}
function vTotCard(sp, g, host) {
  if (!host) return;
  host.hidden = true;
  if (!isBB(sp) || !g || g.status === 'final') return;
  if (sp === 'nba' && !VEFF.ready) { if (!VEFF.error) vEffLoad().then((ok) => { if (ok) render(); }); return; }
  const c = vTotCheck(sp, g); if (!c) return;
  const ck = (r, v) => h('span', { class: `vx-tc ${r.over(v) ? 'g' : r.under(v) ? 'r' : ''}` }, ordinal(v));
  const verdict = c.call ? h('span', { class: `vx-pill ${c.call === 'Over' ? 'g' : 'r'}` }, `${c.call}${g.total_line != null ? ` ${show(g.total_line)}` : ''}`)
    : h('span', { class: 'vx-pill' }, `Over ${c.ov}/3 · Under ${c.un}/3`);
  host.replaceChildren(h('div', { class: 'bar' }, h('h2', null, 'Totals Check'), verdict),
    h('table', { class: 'vx-tct' }, h('thead', null, h('tr', null, h('th', { class: 'l' }, ''), h('th', null, g.away_team), h('th', null, g.home_team), h('th', null, 'Over Needs'))),
      h('tbody', null, c.rows.map((r) => h('tr', null, h('td', { class: 'l' }, r.lab), h('td', null, show(r.av), ' ', ck(r, r.a)), h('td', null, show(r.bv), ' ', ck(r, r.b)),
        h('td', { class: 'muted' }, r.lab.startsWith('Def') ? `both bottom ${c.cut}` : `both top ${c.cut}`))))),
    h('p', { class: 'note' }, `Ranks among ${c.n} teams${sp === 'cbb' ? ` (adjusted efficiency and tempo; top 10% = top ${c.cut})` : ''}. Over = all 3 rows met by both teams; Under = the mirror. Green = fits the over, red = fits the under.`));
  host.hidden = false;
}

// ================================================================= GAMES WITHOUT (player profiles, all sports)
// Pick one or more teammates: his averages in games they all missed vs games they played.
// NFL uses the snap/roster availability file (woSplit); NBA / CFB / CBB use the box scores (no line = didn't play).
S.vWo = S.vWo || { key: '', list: [] };
function vWoSplit(sp, p, mates) {
  const U = tUni(sp), mine = p.logs.filter((r) => r.team === p.team);
  if (sp === 'nfl') return mine.map((r) => ({ r, st: woSplit(U.season, p.team, r.week, mates.map((m) => m.pid)) }));
  const played = mates.map((m) => {
    const ks = new Set(m.logs.filter((r) => r.team === p.team).map((r) => m.key(r)));
    const other = m.logs.some((r) => r.team !== p.team); // traded: only count games after he joined
    const first = m.logs.filter((r) => r.team === p.team).map((r) => String(r.date || r.week)).sort()[0];
    return { ks, other, first };
  });
  return mine.map((r) => {
    const k = p.key(r), when = String(r.date || r.week);
    let out = 0, inn = 0;
    played.forEach((m) => { if (m.ks.has(k)) inn++; else if (!m.other || (m.first && when >= m.first)) out++; });
    return { r, st: out === played.length ? 'without' : inn === played.length ? 'with' : null };
  });
}
function vWoCard(sp, p) {
  const U = tUni(sp), key = `${sp}|${p.pid}`;
  if (S.vWo.key !== key) S.vWo = { key, list: [] };
  const mates = U.players.filter((m) => m.team === p.team && m.pid !== p.pid && m.logs.some((r) => r.team === p.team))
    .map((m) => ({ m, v: mean(m.logs.map((r) => tVal(r, T_MAIN[m.pos])).filter((x) => x != null)) || 0 }))
    .sort((a, b) => b.v - a.v).map((x) => x.m);
  const chosen = S.vWo.list.map((id) => mates.find((m) => m.pid === id)).filter(Boolean);
  const dl = `vwo-${p.pid}`.replace(/\W/g, '');
  const inp = h('input', { class: 'search', type: 'search', list: dl, placeholder: 'Add a teammate who sat out', 'aria-label': 'Teammate who sat out',
    onchange: (e) => { const m = mates.find((x) => `${x.name} (${x.pos})` === e.target.value || x.name === e.target.value); if (m && !S.vWo.list.includes(m.pid)) { S.vWo.list.push(m.pid); render(); } } });
  const picker = h('div', { class: 'wo vx-wo' }, inp,
    h('datalist', { id: dl }, ...mates.map((m) => h('option', { value: `${m.name} (${m.pos})` }))),
    h('div', { class: 'chips' }, ...chosen.map((m) => h('button', { type: 'button', class: 'chip', title: 'Remove', onclick: () => { S.vWo.list = S.vWo.list.filter((x) => x !== m.pid); render(); } }, `${m.name} ✕`))),
    !chosen.length ? h('span', { class: 'vx-wo-quick' }, ...mates.slice(0, 4).map((m) => h('button', { type: 'button', class: 'chip', onclick: () => { S.vWo.list.push(m.pid); render(); } }, `+ ${m.name}`))) : null);
  const kids = [h('h2', null, 'Games Without'), picker];
  if (chosen.length) {
    const split = vWoSplit(sp, p, chosen), wo = split.filter((x) => x.st === 'without').map((x) => x.r), wi = split.filter((x) => x.st === 'with').map((x) => x.r);
    const names = chosen.map((m) => m.name).join(' + ');
    if (!wo.length) kids.push(h('p', { class: 'empty' }, `${p.name} hasn't played a game without ${names} this season.`));
    else {
      const stats = tStats(sp, p.pos).map((x) => x[0]).filter(vFant).slice(0, 8);
      const rows = stats.map((k) => {
        const a = mean(wo.map((r) => tVal(r, k)).filter((v) => v != null)), b = wi.length ? mean(wi.map((r) => tVal(r, k)).filter((v) => v != null)) : null, d = a != null && b != null ? a - b : null;
        return h('tr', null, h('td', { class: 'l' }, vStatLbl(sp, k)), h('td', null, h('b', null, show(a))), h('td', null, b == null ? '—' : show(b)),
          h('td', { class: d == null ? '' : d > 0 ? 'g' : d < 0 ? 'r' : '' }, d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${show(Math.abs(d))}`));
      });
      kids.push(h('div', { class: 'tblwrap' }, h('table', { class: 'dvp' }, h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Stat'), h('th', null, `Without (${wo.length} g)`), h('th', null, `With (${wi.length} g)`), h('th', null, 'Diff'))), h('tbody', null, rows))),
        h('p', { class: 'note' }, `Games without ${names}: `, ...wo.slice().reverse().flatMap((r, i) => [i ? ', ' : '', isBB(sp) ? String(r.date).slice(5) : `Wk ${r.week}`, ' ', r.home === 0 ? '@' : 'vs', ' ', vTeamLink(sp, r.opp)]), '.'));
    }
  }
  return h('div', { class: 'card vx-card' }, ...kids);
}

// ================================================================= PLAYER STATS (NBA / CFB / CBB): same layout as the NFL Player Stats page
// pick a stat, set a line, This Season / This + Last, games without, hit tiles, chart, game log, history vs the opponent,
// and a collapsible "(position) vs (defense)" table of every game a player at his position had against the next opponent.
S.vPs = S.vPs || { stat: null, line: null, seas: null, wo: [], key: '', pdWin: 'both', pdDepth: null, pdFor: '' };
const V_PS_BB = [...T_BB, ['stl', 'Steals'], ['blk', 'Blocks'], ['tov', 'Turnovers'], ['min', 'Minutes']];
const V_PS_LAB = { min: 'Min', stl: 'Stl', blk: 'Blk', tov: 'TO', pr: 'Pts + Reb', pa: 'Pts + Ast', ra: 'Reb + Ast', sb: 'Stl + Blk', fpts: 'Fantasy Pts',
  completions: 'Comp', attempts: 'Att', passing_interceptions: 'INT', long_rush: 'Long Rush', long_reception: 'Long Rec', carries: 'Carries' };
const vPsLbl = (sp, k) => V_PS_LAB[k] || vStatLbl(sp, k);
function vPsStats(sp, pos) {
  if (isBB(sp)) return V_PS_BB.map((x) => x[0]).filter((k) => k !== 'fpts' || (sp === 'nba' && S.fantasy));
  return tStats(sp, pos).map((x) => x[0]).filter((k) => !String(k).startsWith('fp'));
}
function vPsCols(sp, pos) {
  if (isBB(sp)) return ['min', 'pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'pra', 'pr', 'pa'];
  return { QB: ['completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'carries', 'rushing_yards', 'rushing_tds'],
    RB: ['carries', 'rushing_yards', 'rushing_tds', 'long_rush', 'receptions', 'receiving_yards', 'rush_rec_yds'] }[pos]
    || ['receptions', 'receiving_yards', 'receiving_tds', 'long_reception', 'rushing_yards'];
}
const vPsOk = (r) => String(r.player).trim() !== 'Team';
// game r: did every chosen teammate sit out? (box scores: no row = didn't play; a teammate not on the team that season doesn't count)
function vPsWo(sp, logs, team, mates) {
  const X = SPX[sp](), per = mates.map((m) => {
    const rows = (X.byPid.get(String(m)) || []).filter((r) => r.team === team);
    const seasons = new Map();
    rows.forEach((r) => { const s = seasons.get(r.season); const w = String(r.date || r.week).padStart(10, '0'); if (!s) seasons.set(r.season, { first: w, ks: new Set([String(r.game_id)]) }); else { s.ks.add(String(r.game_id)); if (w < s.first) s.first = w; } });
    const other = (X.byPid.get(String(m)) || []).some((r) => r.team !== team);
    return { seasons, other };
  });
  return logs.map((r) => {
    let out = 0, inn = 0;
    const when = String(r.date || r.week).padStart(10, '0');
    per.forEach((m) => {
      const s = m.seasons.get(r.season);
      if (!s) return;
      if (s.ks.has(String(r.game_id))) inn++;
      else if (!m.other || when >= s.first) out++;
    });
    return { r, st: out === per.length ? 'without' : inn === per.length ? 'with' : null };
  });
}
function vPsTable(name, cols, rows, opts) { const t = newTable(); t.classList.add('dvp'); table(t, name, cols, rows, opts); return t; }
const vPsRkCls = (n) => (v) => (v == null || !n ? 'rk' : (v - 1) / Math.max(1, n - 1) <= 0.25 ? 'rk rk-r' : (v - 1) / Math.max(1, n - 1) >= 0.75 ? 'rk rk-g' : 'rk');

function vPlayerStats(sp, p, U, nx) {
  const X = SPX[sp](), st = S.vPs, key = `${sp}|${p.pid}`;
  const keys = vPsStats(sp, p.pos);
  if (st.key !== key) { st.key = key; st.line = null; st.wo = []; if (!keys.includes(st.stat)) st.stat = null; }
  if (!st.stat || !keys.includes(st.stat)) { st.stat = keys.includes(T_MAIN[p.pos]) ? T_MAIN[p.pos] : keys[0]; st.line = null; }
  if (!st.seas) st.seas = sp === 'cbb' && X.early ? 'both' : 'cur';
  const stat = st.stat, both = st.seas === 'both', lbl = vPsLbl(sp, stat);
  const seasons = both ? [U.season, U.season - 1] : [U.season];
  const allLogs = (X.byPid.get(String(p.pid)) || X.byPid.get(Number(p.pid)) || p.logs).filter((r) => seasons.includes(r.season));
  const rerender = () => render();
  // teammates (this season) for the picker
  const mates = U.players.filter((m) => m.team === p.team && m.pid !== p.pid && m.logs.some((r) => r.team === p.team))
    .map((m) => ({ m, v: mean(m.logs.map((r) => tVal(r, T_MAIN[m.pos])).filter((x) => x != null)) || 0 }))
    .sort((a, b) => b.v - a.v).map((x) => x.m);
  st.wo = st.wo.filter((id) => mates.some((m) => m.pid === id));
  const chosen = st.wo.map((id) => mates.find((m) => m.pid === id));
  const wo = chosen.length > 0, names = chosen.map((m) => m.name).join(' + ');
  const tagged = wo ? vPsWo(sp, allLogs.filter((r) => r.team === p.team), p.team, st.wo) : null;
  const games = wo ? tagged.filter((x) => x.st === 'without').map((x) => x.r) : allLogs;
  const vals = games.map((r) => tVal(r, stat)).filter((v) => v != null);
  const avg = mean(vals);
  if (st.line == null) st.line = lineFor(avg);
  const line = st.line;
  const hit = (a) => ({ o: a.filter((v) => v > line).length, n: a.length, pu: a.filter((v) => v === line).length });
  const fmtHit = (x) => (x.n ? `${x.o}/${x.n}` : '—');
  const pctHit = (x) => (x.n ? ` (${Math.round((x.o / (x.n - x.pu || 1)) * 100)}%)` : '');
  const hs = hit(vals), h5 = hit(vals.slice(-5)), h3 = hit(vals.slice(-3));
  const opp = nx && nx.opp, d = opp ? tDv(sp, opp, p.pos, stat) : null;
  const tiles = [[fmtHit(hs), `Over ${line}${pctHit(hs)}`], [fmtHit(h5), `L5${pctHit(h5)}`], [fmtHit(h3), `L3${pctHit(h3)}`],
    [show(avg), `Avg ${lbl.toLowerCase()}`], [show(median(vals)), 'Median'], [vals.length ? `${show(Math.min(...vals))}–${show(Math.max(...vals))}` : '—', 'Low–high']];
  if (isBB(sp) && stat !== 'min') tiles.push([show(mean(games.map((r) => r.min).filter((v) => v != null))), 'Avg min']);
  if (d) tiles.push([show(d.pg), `${opp} allows to ${p.pos}s/g (${ordinal(d.rank)} of ${d.n})`]);
  // controls
  const lineInp = h('input', { class: 'num vx-ps-line', type: 'number', step: '0.5', value: String(line), 'aria-label': 'Prop line',
    onchange: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v !== st.line) { st.line = v; rerender(); } },
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  const sel = h('select', { 'aria-label': 'Stat', onchange: (e) => { st.stat = e.target.value; st.line = null; rerender(); } },
    ...keys.map((k) => h('option', { value: k, selected: k === stat ? '' : null }, vPsLbl(sp, k))));
  const dl = `vps-${sp}`;
  const find = h('input', { class: 'search', type: 'search', list: dl, placeholder: 'Search player', 'aria-label': 'Find player',
    onchange: (e) => { const v = e.target.value.trim().toLowerCase(); const m = U.players.find((x) => `${x.name} (${x.pos}, ${x.team})`.toLowerCase() === v) || U.players.find((x) => x.name.toLowerCase() === v) || U.players.find((x) => x.name.toLowerCase().includes(v)); if (m) go(`player/${sp}/${m.pid}`); } });
  const seasSeg = vSeg([['cur', 'This Season'], ['both', 'This + Last']], st.seas, (v) => { st.seas = v; st.line = null; rerender(); }, 'Seasons');
  const woDl = `vpswo-${sp}`;
  const woInp = h('input', { class: 'search', type: 'search', list: woDl, placeholder: 'Add a teammate who sat out', 'aria-label': 'Filter to games a teammate missed',
    onchange: (e) => { const m = mates.find((x) => `${x.name} (${x.pos})` === e.target.value || x.name.toLowerCase() === e.target.value.trim().toLowerCase()); if (m && !st.wo.includes(m.pid)) { st.wo.push(m.pid); rerender(); } } });
  const woBox = h('div', { class: `wo${wo ? ' wo-on' : ''}` }, h('span', { class: 'lbl' }, 'Games without'), woInp,
    h('datalist', { id: woDl }, ...mates.map((m) => h('option', { value: `${m.name} (${m.pos})` }))),
    h('div', { class: 'chips' }, ...chosen.map((m) => h('span', { class: 'chip' }, `Without ${m.name}`, h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { st.wo = st.wo.filter((x) => x !== m.pid); rerender(); } }, '×')))),
    !wo ? h('span', { class: 'vx-wo-quick' }, ...mates.slice(0, 4).map((m) => h('button', { type: 'button', class: 'chip', onclick: () => { st.wo.push(m.pid); rerender(); } }, `+ ${m.name}`))) : null);
  let split = null;
  if (wo) {
    const withV = tagged.filter((x) => x.st === 'with').map((x) => tVal(x.r, stat)).filter((v) => v != null);
    split = h('p', { class: 'summary' }, !vals.length ? `No games${both ? '' : ' this season'} where ${p.name} played and ${names} didn't.${both ? '' : ' Try "This + Last".'}`
      : [`${lbl} without ${names}: `, h('b', null, `${show(avg)} avg`), ` in ${vals.length} game${vals.length > 1 ? 's' : ''}`,
        withV.length ? [' · with: ', h('b', null, `${show(mean(withV))} avg`), ` in ${withV.length}`] : null, '.', vals.length < 4 ? ' Small sample, so treat it as a hint, not a trend.' : null]);
  }
  const nextTxt = nx ? `Next: ${nx.home ? 'vs' : '@'} ${opp}${nx.implied != null ? ` · ${p.team} implied total ${show(nx.implied)}` : ''}` : 'No game scheduled.';
  const chartBox = h('div', { class: 'chart vx-ps-chart' });
  const statsCard = h('div', { class: 'card' },
    h('div', { class: 'bar' }, h('h2', null, `${p.name} · ${p.pos} · ${p.team}`),
      h('div', { class: 'controls' }, find, h('datalist', { id: dl }, ...U.players.map((x) => h('option', { value: `${x.name} (${x.pos}, ${x.team})` }))),
        sel, h('span', { class: 'lbl' }, 'Line'), lineInp, seasSeg)),
    woBox, split, h('p', { class: 'note' }, nextTxt),
    h('div', { class: 'stats' }, ...tiles.map(([v, k]) => tile(v, k))),
    chartBox,
    h('div', { class: 'legend' }, h('span', { class: 'lg' }, 'Over the line'), h('span', { class: 'lr' }, 'Under the line')));
  const gx = (r) => (isBB(sp) ? `${both ? `'${String(r.season).slice(2)} ` : ''}${String(r.date || '').slice(5)} ${r.opp}` : `${both ? `'${String(r.season).slice(2)} ` : ''}W${r.week} ${r.opp}`);
  const chartData = games.map((r) => { const v = tVal(r, stat) ?? 0; return { x: gx(r), y: v, color: v > line ? 'var(--ok)' : v === line ? 'var(--muted)' : 'var(--bad)',
    tipTitle: `${isBB(sp) ? r.date : `${both ? `${r.season} ` : ''}Week ${r.week}`} ${r.home === 0 ? '@' : 'vs'} ${r.opp}`, tipBody: `${show(v)} ${lbl.toLowerCase()}` }; });

  // ---- game log
  const ex = vPsCols(sp, p.pos);
  const statCols = ex.map((k) => ({ f: k, label: vPsLbl(sp, k) }));
  if (!ex.includes(stat)) statCols.unshift({ f: stat, label: lbl });
  const hl = (v) => (v == null ? '' : v > line ? 'g' : v < line ? 'r' : '');
  statCols.forEach((c) => { if (c.f === stat) c.cls = hl; });
  const fill = (r) => { const o = { ...r }; statCols.forEach((c) => { o[c.f] = tVal(r, c.f); }); return o; };
  let nRk = null;
  const glRows = games.map((r) => { const dd = r.season === U.season ? tDv(sp, r.opp, p.pos, stat) : null; if (dd) nRk = dd.n;
    return { ...fill(r), gkey: `${r.season}|${String(r.date || '').padStart(10, '0')}|${String(r.week || 0).padStart(3, '0')}`, when: isBB(sp) ? String(r.date || '').slice(5) : r.week,
      oppTxt: `${r.home === 0 ? '@ ' : r.home === 1 ? 'vs ' : ''}${r.opp}`, opp_rank: dd ? dd.rank : null }; });
  const glCols = [...(both ? [{ f: 'season', label: 'Season' }] : []), { f: 'when', label: isBB(sp) ? 'Date' : 'Wk', l: true }, { f: 'oppTxt', label: 'Opp', l: true },
    { f: 'opp_rank', label: 'Opp Rk', cls: vPsRkCls(nRk), fmt: (v) => (v == null ? '—' : ordinal(v)) }, ...statCols];
  const glCard = h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', null, `Game Log${wo ? ` without ${names}` : ''}`)),
    h('div', { class: 'scroll', style: 'max-height: 32rem' }, vPsTable(`vps-log-${sp}`, glCols, glRows, { sort: { f: 'gkey', dir: 'desc' } })));
  // ---- history vs next opponent (this season and last)
  const cards = [glCard];
  if (opp) {
    const vs = (X.byPid.get(String(p.pid)) || p.logs).filter((r) => r.opp === opp).map((r) => ({ ...fill(r), when: isBB(sp) ? r.date : `W${r.week}` }));
    cards.push(h('div', { class: 'card' }, h('h2', null, `History vs ${opp}`), h('p', { class: 'note' }, 'Every game vs this opponent.'),
      vs.length ? h('div', { class: 'scroll', style: 'max-height: 14rem' }, vPsTable(`vps-vs-${sp}`, [{ f: 'season', label: 'Season' }, { f: 'when', label: isBB(sp) ? 'Date' : 'Wk', l: true }, { f: 'team', label: 'For', l: true }, ...statCols], vs, { sort: { f: 'when', dir: 'desc' } }))
        : h('p', { class: 'empty' }, 'No games against them in the last two seasons.')));
    cards.push(vPosVsDef(sp, p, U, opp, stat, line, statCols, fill));
  }
  return { block: h('div', { class: 'joined vx-ps' }, statsCard, ...cards), mount: () => bars(chartBox, chartData, { height: 220, line }) };
}

// every game a player at his position had against the next opponent (collapsible)
function vPosVsDef(sp, p, U, opp, stat, line, statCols, fill) {
  const X = SPX[sp](), st = S.vPs, pos = p.pos, bb = isBB(sp);
  const depths = bb ? [['start', `Starting ${pos}s`], ['all', `All ${pos}s`]] : [['top', `${pos}1`], ['all', `All ${pos}s`]];
  const main = T_MAIN[pos] || stat;
  // CFB: who led his team at the position each game (by the position's main stat)
  let topKey = null;
  if (!bb) {
    topKey = new Set(); const best = new Map();
    X.logs.forEach((r) => { if (!vPsOk(r) || r.position !== pos) return; const k = `${r.game_id}|${r.team}`, v = tVal(r, main) || 0; const b = best.get(k); if (!b || v > b.v) best.set(k, { v, pid: String(r.player_id) }); });
    best.forEach((b, k) => topKey.add(`${k}|${b.pid}`));
  }
  const isTop = (r) => (bb ? r.starter === 1 : topKey.has(`${r.game_id}|${r.team}|${String(r.player_id)}`));
  if (st.pdFor !== `${sp}|${p.pid}`) {
    const mine = p.logs; const n = mine.filter(isTop).length;
    st.pdDepth = n >= mine.length / 2 ? depths[0][0] : 'all'; st.pdFor = `${sp}|${p.pid}`;
  }
  const label = depths.find((x) => x[0] === st.pdDepth)[1];
  const rows = X.logs.filter((r) => vPsOk(r) && r.opp === opp && r.position === pos && (st.pdWin === 'both' || r.season === U.season)
    && (!bb || (r.min || 0) > 0) && (st.pdDepth === 'all' || isTop(r)))
    .map((r) => ({ ...fill(r), pid: String(r.player_id), when: bb ? r.date : `${r.season} W${String(r.week).padStart(2, '0')}`, me: String(r.player_id) === String(p.pid) }));
  const vals = rows.map((r) => r[stat]).filter((v) => v != null);
  const cur = rows.filter((r) => r.season === U.season).map((r) => r[stat]).filter((v) => v != null);
  const over = (a) => a.filter((v) => v > line).length, o = over(vals);
  const title = `${label} vs ${opp} Defense`;
  const sum = vals.length ? h('p', { class: 'summary' }, `${label} vs ${opp} went over ${line} ${vPsLbl(sp, stat).toLowerCase()} in `, h('b', { class: o / vals.length >= 0.5 ? 'g' : 'r' }, `${o} of ${vals.length}`), ' games',
    st.pdWin === 'both' && cur.length ? [' (this season ', h('b', null, `${over(cur)} of ${cur.length}`), ')'] : null, '. Average ', h('b', null, show(mean(vals))), ', median ', h('b', null, show(median(vals))), '.') : null;
  const hl = (v) => (v == null ? '' : v > line ? 'g rk' : v < line ? 'r rk' : 'rk');
  const cols = [{ f: 'when', label: 'Game', l: true }, { f: 'team', label: 'Team', l: true }, { f: 'player', label: 'Player', l: true }, ...statCols.map((c) => ({ ...c, cls: c.f === stat ? hl : undefined }))];
  let open = true; try { open = localStorage.getItem('ml-pvd-open') !== '0'; } catch (e) { /* storage off */ }
  const det = h('details', { class: 'vx-pvd', open: open ? '' : null, ontoggle: (e) => { try { localStorage.setItem('ml-pvd-open', e.target.open ? '1' : '0'); } catch (err) { /* storage off */ } } },
    h('summary', null, h('h2', null, title), h('span', { class: 'vx-pvd-arrow', 'aria-hidden': 'true' }, '▾')),
    h('div', { class: 'bar vx-pvd-bar' }, h('p', { class: 'note' }, 'Every game a player at this position had against this opponent.'),
      h('div', { class: 'controls' }, vSeg(depths, st.pdDepth, (v) => { st.pdDepth = v; render(); }, 'Depth'),
        vSeg([['both', 'This + Last'], ['cur', 'This Season']], st.pdWin, (v) => { st.pdWin = v; render(); }, 'Seasons'))),
    sum,
    rows.length ? h('div', { class: 'scroll', style: 'max-height: 30rem' }, vPsTable(`vps-pd-${sp}`, cols, rows, { sort: { f: 'when', dir: 'desc' }, selected: (r) => r.me,
      onClick: (r) => { if (r.pid !== String(p.pid)) go(`player/${sp}/${r.pid}`); } })) : h('p', { class: 'empty' }, 'No games to show.'),
    h('div', { class: 'legend' }, h('span', { class: 'lg' }, 'Over your line'), h('span', { class: 'lr' }, 'Under your line')));
  return h('div', { class: 'card' }, det);
}
