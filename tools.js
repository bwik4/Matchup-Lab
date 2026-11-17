/*
 * Matchup Lab - Tools hub, Prop screener, Compare & start/sit, Injury report, Home dashboard
 * =========================================================================================
 * Loaded after the main script in index.html and uses its helpers (h, $, show, mean, TI, badge, mrow,
 * simScores, openProp, openLog, go, render ...). Each page draws into a card that's already in index.html,
 * so Edit mode can move / hide / rename those cards like any other.
 *
 * Saved in this browser (localStorage):
 *   ml-favs        starred players            [{ sp, pid }]
 *   ml-fav-tools   starred tools on the Tools page
 *   ml-compare     players picked in Compare  { nfl: [pid, ...], ... }
 *   ml-sleeper     your Sleeper username / league
 */
'use strict';
const T_SP = ['nfl', 'nba', 'cfb', 'cbb'];
const T_SPNAME = { nfl: 'NFL', nba: 'NBA', cfb: 'College football', cbb: 'College basketball' };
const tStore = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
};
const tReady = (sp) => (sp === 'nfl' ? !!DATA.teams : !!SPX[sp]().ready);
function tEnsure(sp) {
  if (tReady(sp)) return true;
  const L = { nba: loadNBA, cfb: loadCFB, cbb: loadCBB }[sp];
  if (L) L().then(() => render());
  return false;
}
const tRC = (el, ...k) => el.replaceChildren(...k.flat(Infinity).filter((x) => x != null && x !== false));
const tLoading = (root, sp) => tRC(root, h('p', { class: 'empty' }, `Loading ${T_SPNAME[sp]}…`));
const tPct = (a, n) => (n ? Math.round((a / n) * 100) : null);
const tQuant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const tHalf = (v) => (v == null ? null : Math.max(0.5, Math.floor(v) + 0.5));

// ---------------------------------------------------------------- stats per sport / position
const T_FB = {
  QB: [['passing_yards', 'Pass yds'], ['passing_tds', 'Pass TDs'], ['completions', 'Completions'], ['attempts', 'Pass attempts'], ['rushing_yards', 'Rush yds'], ['pass_rush_yds', 'Pass + rush yds'], ['passing_interceptions', 'Interceptions'], ['fp_ppr', 'Fantasy pts (PPR)']],
  RB: [['rushing_yards', 'Rush yds'], ['carries', 'Carries'], ['rush_rec_yds', 'Rush + rec yds'], ['receptions', 'Receptions'], ['receiving_yards', 'Rec yds'], ['rushing_tds', 'Rush TDs'], ['fp_ppr', 'Fantasy pts (PPR)']],
  WR: [['receiving_yards', 'Rec yds'], ['receptions', 'Receptions'], ['targets', 'Targets'], ['receiving_tds', 'Rec TDs'], ['long_reception', 'Longest catch'], ['fp_ppr', 'Fantasy pts (PPR)']],
  TE: [['receiving_yards', 'Rec yds'], ['receptions', 'Receptions'], ['targets', 'Targets'], ['receiving_tds', 'Rec TDs'], ['long_reception', 'Longest catch'], ['fp_ppr', 'Fantasy pts (PPR)']],
};
const T_BB = [['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['fg3m', '3-pointers made'], ['pra', 'Pts + reb + ast'], ['pr', 'Pts + reb'], ['pa', 'Pts + ast'], ['ra', 'Reb + ast'], ['sb', 'Steals + blocks'], ['fpts', 'Fantasy pts']];
const T_POS = { nfl: ['QB', 'RB', 'WR', 'TE'], cfb: ['QB', 'RB', 'WR', 'TE'], nba: ['G', 'F', 'C'], cbb: ['G', 'F', 'C'] };
const T_MAIN = { QB: 'passing_yards', RB: 'rush_rec_yds', WR: 'receiving_yards', TE: 'receiving_yards', G: 'pts', F: 'pts', C: 'pts' };
function tStats(sp, pos) {
  if (isBB(sp)) return T_BB;
  const list = pos && T_FB[pos] ? T_FB[pos] : [...new Map(Object.values(T_FB).flat().map((x) => [x[0], x])).values()];
  return sp === 'nfl' ? list : list.filter(([k]) => k !== 'targets');
}
const tStatLabel = (sp, k) => (tStats(sp).find((x) => x[0] === k) || [k, k])[1];
const tLow = (s) => s.replace(/^[A-Z](?=[a-z])/, (m) => m.toLowerCase());
const tTitle = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bPpr\b/g, 'PPR');
// one stat from a game log row (combos computed here)
function tVal(r, k) {
  if (r == null) return null;
  const n = (x) => Number(r[x]) || 0;
  switch (k) {
    case 'pra': return n('pts') + n('reb') + n('ast');
    case 'pr': return n('pts') + n('reb');
    case 'pa': return n('pts') + n('ast');
    case 'ra': return n('reb') + n('ast');
    case 'sb': return n('stl') + n('blk');
    case 'fpts': return Math.round((n('pts') + 1.2 * n('reb') + 1.5 * n('ast') + 3 * n('stl') + 3 * n('blk') - n('tov')) * 10) / 10;
    case 'fp_ppr':
      if (r.fp_ppr != null) return r.fp_ppr;
      return Math.round((0.04 * n('passing_yards') + 4 * n('passing_tds') - 2 * n('passing_interceptions') + 0.1 * n('rushing_yards') + 6 * n('rushing_tds') + n('receptions') + 0.1 * n('receiving_yards') + 6 * n('receiving_tds')) * 10) / 10;
    default: return r[k] == null ? null : Number(r[k]);
  }
}

// ---------------------------------------------------------------- player universe per sport
const T_UNI = {};
function tUni(sp) {
  const src = sp === 'nfl' ? DATA.logs : SPX[sp]().logs;
  if (T_UNI[sp] && T_UNI[sp].src === src) return T_UNI[sp];
  const players = [], next = new Map(), keysByTeam = new Map();
  let season;
  const addKey = (team, k, ord) => { if (!keysByTeam.has(team)) keysByTeam.set(team, new Map()); keysByTeam.get(team).set(k, ord); };
  if (sp === 'nfl') {
    season = S.season;
    DATA.players.forEach((p) => {
      if (!T_POS.nfl.includes(p.position)) return;
      const logs = (IDX.logs.get(p.player_id) || []).filter((r) => r.season === season);
      if (!logs.length) return;
      players.push({ sp, pid: p.player_id, name: p.player, team: p.team, pos: p.position, logs, key: (r) => r.week });
    });
    DATA.team_games.filter((x) => x.season === season).forEach((x) => addKey(x.team, x.week, x.week));
    DATA.games.filter((g) => g.status !== 'final' && g.week >= S.upWeek).sort((a, b) => a.week - b.week).forEach((g) => {
      [[g.home_team, g.away_team, true], [g.away_team, g.home_team, false]].forEach(([t, o, home]) => {
        if (!next.has(t)) next.set(t, { opp: o, home, label: `Wk ${g.week}`, when: kickDate(g), total: g.total_line, implied: home ? g.home_implied : g.away_implied, g });
      });
    });
  } else {
    const X = SPX[sp]();
    season = X.season;
    const okPos = T_POS[sp];
    X.byPid.forEach((logs, pid) => {
      const cur = logs.filter((r) => r.season === season && String(r.player).trim() !== 'Team');
      if (!cur.length) return;
      const last = cur[cur.length - 1];
      if (!okPos.includes(last.position)) return;
      players.push({ sp, pid: String(pid), name: String(last.player).trim(), team: last.team, pos: last.position, logs: cur, key: (r) => String(r.game_id) });
      cur.forEach((r) => addKey(r.team, String(r.game_id), isBB(sp) ? r.date : r.week));
    });
    const today = etToday();
    X.games.filter((g) => g.status !== 'final' && (!g.gameday || g.gameday >= today))
      .sort((a, b) => (a.gameday < b.gameday ? -1 : a.gameday > b.gameday ? 1 : (a.week || 0) - (b.week || 0)))
      .forEach((g) => {
        const sl = g.spread_line, tot = g.total_line;
        [[g.home_team, g.away_team, true], [g.away_team, g.home_team, false]].forEach(([t, o, home]) => {
          if (next.has(t)) return;
          const imp = sl != null && tot != null ? (home ? (tot + sl) / 2 : (tot - sl) / 2) : null;
          const d = kickDate(g);
          next.set(t, { opp: o, home, label: isBB(sp) ? (d ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : g.gameday) : `Wk ${g.week}`, when: d, total: tot, implied: imp, g });
        });
      });
  }
  const teamKeys = new Map();
  keysByTeam.forEach((m, t) => teamKeys.set(t, [...m.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map((x) => x[0])));
  players.forEach((p) => {
    const keys = teamKeys.get(p.team) || [], have = new Set(p.logs.filter((r) => r.team === p.team).map(p.key));
    let m = 0; for (let i = keys.length - 1; i >= 0 && !have.has(keys[i]); i--) m++;
    p.missed = m;
    const first = keys.findIndex((k) => have.has(k));
    p.missedN = first < 0 ? 0 : keys.slice(first).filter((k) => !have.has(k)).length;
    p.teamGames = keys.length;
    p.mins = isBB(sp) ? mean(p.logs.slice(-5).map((r) => r.min || 0)) : null;
  });
  const byPid = new Map(players.map((p) => [p.pid, p]));
  return (T_UNI[sp] = { src, sp, season, players, byPid, next, teamKeys });
}
// what a defense allows to a position (rank 1 = allows the least)
const T_DV = {};
function tDv(sp, opp, pos, stat) {
  if (!opp) return null;
  if (sp === 'nfl') { const r = mrow(opp, pos, stat); return r ? { pg: r.per_game, rank: r.rank, n: 32, games: r.games } : null; }
  const X = SPX[sp](), r = X.dv && X.dv.get(`${opp}|${pos}|${stat}`);
  if (!r) return null;
  const k = `${sp}|${pos}|${stat}`;
  if (!(k in T_DV)) T_DV[k] = X.dvp.filter((x) => x.position === pos && x.stat === stat).length;
  return { pg: r.per_game, rank: r.rank, n: T_DV[k], games: r.games };
}
const T_LG = {};
function tLg(sp, pos, stat) {
  const k = `${sp}|${pos}|${stat}|${sp === 'nfl' ? DATA.matchups.length : SPX[sp]().dvp.length}`;
  if (!(k in T_LG)) {
    const v = sp === 'nfl' ? DATA.matchups.filter((r) => r.window === 'season' && r.position === pos && r.stat === stat).map((r) => r.per_game)
      : SPX[sp]().dvp.filter((r) => r.position === pos && r.stat === stat).map((r) => r.per_game);
    T_LG[k] = mean(v.filter((x) => x != null));
  }
  return T_LG[k];
}
// projection: 60% season + 40% last 5, nudged by how much the opponent allows to his position (shrunk toward average early on)
function tProject(sp, p, stat) {
  const U = tUni(sp), vals = p.logs.map((r) => tVal(r, stat)).filter((v) => v != null);
  if (!vals.length) return null;
  const seas = mean(vals), l5 = mean(vals.slice(-5)), l3 = mean(vals.slice(-3));
  const base = vals.length >= 5 ? 0.6 * seas + 0.4 * l5 : seas;
  const nx = U.next.get(p.team), d = nx ? tDv(sp, nx.opp, p.pos, stat) : null, lg = tLg(sp, p.pos, stat);
  let f = 1;
  if (d && lg) { const g = d.games || 6, shr = (g * (d.pg / lg) + 4) / (g + 4); f = Math.min(1.25, Math.max(0.75, 1 + 0.5 * (shr - 1))); }
  return { proj: base * f, base, f, d, nx, seas, l5, l3, vals, med: median(vals), floor: tQuant(vals, 0.2), ceil: tQuant(vals, 0.8) };
}
// his average in games against the 3 defenses he's faced that most resemble the next opponent's
function tVsSimilar(sp, p, stat, opp) {
  if (!opp) return null;
  let sc;
  try { sc = simScores(sp, opp, 'off'); } catch (e) { return null; }
  if (!sc) return null;
  const g = p.logs.filter((r) => r.opp !== opp && sc.get(r.opp)).map((r) => ({ r, sim: sc.get(r.opp).sim })).sort((a, b) => b.sim - a.sim).slice(0, 3);
  return g.length ? { avg: mean(g.map((x) => tVal(x.r, stat))), opps: g.map((x) => x.r.opp), n: g.length } : null;
}
const tPctCls = (rank, n) => { if (rank == null || !n) return ''; const q = (rank - 1) / Math.max(1, n - 1); return q <= 0.25 ? 'r' : q >= 0.75 ? 'g' : ''; };
function tOpenPlayer(sp, pid, stat) {
  if (sp === 'nfl') { if (stat) S.pStat = stat; openProp(pid, stat || null); } else openLog(sp, pid);
}

// ---------------------------------------------------------------- favorites
const tFavs = () => tStore.get('ml-favs', []);
const tIsFav = (sp, pid) => tFavs().some((f) => f.sp === sp && String(f.pid) === String(pid));
function tToggleFav(sp, pid) {
  const f = tFavs(), i = f.findIndex((x) => x.sp === sp && String(x.pid) === String(pid));
  if (i >= 0) f.splice(i, 1); else f.push({ sp, pid: String(pid) });
  tStore.set('ml-favs', f); render();
}
const tStar = (sp, pid) => h('button', { type: 'button', class: `t-star${tIsFav(sp, pid) ? ' on' : ''}`, title: tIsFav(sp, pid) ? 'Remove from favorites' : 'Add to favorites (shows on Home)', 'aria-label': 'Favorite',
  onclick: (e) => { e.stopPropagation(); tToggleFav(sp, pid); } }, tIsFav(sp, pid) ? '★' : '☆');

// ---------------------------------------------------------------- small sortable table (cells can hold buttons)
S.tSort = S.tSort || {};
function tTable(name, cols, rows, opts = {}) {
  const st = S.tSort[name] || opts.sort || null;
  let list = rows.slice();
  if (st) {
    const c = cols.find((x) => x.k === st.k), sv = c && (c.sv || ((r) => r[c.k]));
    if (sv) list.sort((a, b) => { const x = sv(a), y = sv(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return st.dir === 'asc' ? d : -d; });
  }
  const total = list.length;
  if (opts.limit) list = list.slice(0, opts.limit);
  const head = h('tr', null, ...cols.map((c) => h('th', { class: c.l ? 'l' : '', title: c.title || null, 'aria-sort': st && st.k === c.k ? (st.dir === 'asc' ? 'ascending' : 'descending') : null },
    c.nosort ? c.label : h('button', { type: 'button', onclick: () => { S.tSort[name] = st && st.k === c.k ? { k: c.k, dir: st.dir === 'asc' ? 'desc' : 'asc' } : { k: c.k, dir: c.l || c.asc ? 'asc' : 'desc' }; render(); } },
      c.label + (st && st.k === c.k ? (st.dir === 'asc' ? ' ↑' : ' ↓') : '')))));
  const body = list.map((r) => h('tr', { class: [opts.onClick ? 'click' : '', opts.rowCls ? opts.rowCls(r) : ''].join(' ').trim() || null, onclick: opts.onClick ? () => opts.onClick(r) : null },
    ...cols.map((c) => { const v = c.fmt ? c.fmt(r) : show(r[c.k]); return h('td', { class: [c.l ? 'l' : '', c.cls ? c.cls(r) : ''].join(' ').trim() || null, title: c.tip ? c.tip(r) : null }, v); })));
  return { el: h('table', { class: 'dvp t-tbl' }, h('thead', null, head), h('tbody', null, ...body)), total, shown: list.length };
}

// ================================================================= PROP SCREENER
S.scr = S.scr || {};
function tScr(sp) {
  if (!S.scr[sp]) S.scr[sp] = { pos: T_POS[sp][isBB(sp) ? 0 : 2], stat: null, line: null, minG: 3, onlyNext: true, team: '', q: '', limit: 50 };
  const c = S.scr[sp];
  const stats = tStats(sp, isBB(sp) ? null : c.pos);
  if (!c.stat || !stats.some((x) => x[0] === c.stat)) { c.stat = T_MAIN[c.pos] || stats[0][0]; c.line = null; }
  return c;
}
function renderScreener() {
  const root = $('.scr-root'), sp = S.sport;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  const U = tUni(sp), c = tScr(sp);
  const pool = U.players.filter((p) => p.pos === c.pos && p.logs.length >= c.minG);
  // a sensible default line: the typical player's average at this stat, rounded to .5
  if (c.line == null) {
    // a starter-level default: the median of the top N players, N = teams playing × starters at the position
    const live = pool.filter((p) => U.next.has(p.team));
    const src = live.length ? live : pool;
    const avgs = src.map((p) => mean(p.logs.map((r) => tVal(r, c.stat)).filter((v) => v != null))).filter((v) => v != null && v > 0).sort((a, b) => b - a);
    const n = Math.max(3, new Set(src.map((p) => p.team)).size * ({ QB: 1, RB: 1, WR: 2, TE: 1, G: 2, F: 2, C: 1 }[c.pos] || 1));
    c.line = tHalf(avgs.length ? median(avgs.slice(0, n)) : 1);
  }
  const line = c.line, q = c.q.trim().toLowerCase();
  const rows = [];
  pool.forEach((p) => {
    if (c.onlyNext && !U.next.has(p.team)) return;
    if (c.team && p.team !== c.team) return;
    if (q && !`${p.name} ${p.team} ${TI(p.team).name || ''}`.toLowerCase().includes(q)) return;
    const pr = tProject(sp, p, c.stat);
    if (!pr) return;
    const v = pr.vals, hit = (a) => ({ o: a.filter((x) => x > line).length, n: a.length });
    const sim = tVsSimilar(sp, p, c.stat, pr.nx && pr.nx.opp);
    rows.push({ p, pr, nx: pr.nx, d: pr.d, hs: hit(v), h5: hit(v.slice(-5)), h10: hit(v.slice(-10)), edge: pr.proj - line, sim,
      mins: p.mins, missed: p.missed });
  });
  const hitFmt = (x) => (x.n ? `${x.o}/${x.n}` : '—'), hitSv = (x) => (x.n ? x.o / x.n : null);
  const hitCls = (x) => { if (!x.n) return ''; const r = x.o / x.n; return r >= 0.7 ? 'g' : r <= 0.3 ? 'r' : ''; };
  const cols = [
    { k: 'fav', label: '', nosort: true, fmt: (r) => tStar(sp, r.p.pid) },
    { k: 'name', label: 'Player', l: true, sv: (r) => r.p.name, fmt: (r) => h('span', { class: 't-who' }, badge(r.p.team, 'sm'), h('span', null, h('b', null, r.p.name), h('small', null, `${r.p.pos} · ${r.p.team}${r.missed ? ` · missed last ${r.missed}` : ''}`))) },
    { k: 'opp', label: 'Next', l: true, sv: (r) => (r.nx ? r.nx.opp : null), fmt: (r) => (r.nx ? `${r.nx.home ? 'vs' : '@'} ${r.nx.opp}` : '—'), tip: (r) => (r.nx ? r.nx.label : null) },
    { k: 'mrank', label: 'Opp rank', title: `How the opponent ranks against ${c.pos}s at this stat: 1 = allows the least (toughest)`, sv: (r) => (r.d ? (r.d.rank - 1) / Math.max(1, r.d.n - 1) : null),
      fmt: (r) => (r.d ? `${ordinal(r.d.rank)}` : '—'), cls: (r) => (r.d ? tPctCls(r.d.rank, r.d.n) : ''), tip: (r) => (r.d ? `Allows ${show(r.d.pg)} per game (${ordinal(r.d.rank)} of ${r.d.n})` : null) },
    { k: 'proj', label: 'Proj', title: '60% season avg + 40% L5, adjusted for the opponent', sv: (r) => r.pr.proj, fmt: (r) => h('b', null, show(r.pr.proj)) },
    { k: 'edge', label: 'Proj − line', sv: (r) => r.edge, fmt: (r) => `${r.edge > 0 ? '+' : ''}${show(r.edge)}`, cls: (r) => (r.edge >= 0.1 * Math.max(1, line) ? 'g' : r.edge <= -0.1 * Math.max(1, line) ? 'r' : '') },
    { k: 'avg', label: 'Avg', sv: (r) => r.pr.seas, fmt: (r) => show(r.pr.seas) },
    { k: 'l5', label: 'L5 avg', sv: (r) => r.pr.l5, fmt: (r) => show(r.pr.l5) },
    { k: 'med', label: 'Median', sv: (r) => r.pr.med, fmt: (r) => show(r.pr.med) },
    { k: 'h5', label: 'L5 over', sv: (r) => hitSv(r.h5), fmt: (r) => hitFmt(r.h5), cls: (r) => hitCls(r.h5) },
    { k: 'h10', label: 'L10 over', sv: (r) => hitSv(r.h10), fmt: (r) => hitFmt(r.h10), cls: (r) => hitCls(r.h10) },
    { k: 'hs', label: 'Season over', sv: (r) => hitSv(r.hs), fmt: (r) => `${hitFmt(r.hs)}${r.hs.n ? ` · ${tPct(r.hs.o, r.hs.n)}%` : ''}`, cls: (r) => hitCls(r.hs) },
    { k: 'sim', label: 'Vs similar D', title: 'His average against the 3 defenses he has faced that look most like the next opponent', sv: (r) => (r.sim ? r.sim.avg : null),
      fmt: (r) => (r.sim ? show(r.sim.avg) : '—'), cls: (r) => (r.sim ? (r.sim.avg > line ? 'g' : 'r') : ''), tip: (r) => (r.sim ? `vs ${r.sim.opps.join(', ')}` : null) },
  ];
  if (isBB(sp)) cols.splice(4, 0, { k: 'mins', label: 'Min (L5)', sv: (r) => r.mins, fmt: (r) => show(r.mins) });
  cols.push({ k: 'cmp', label: '', nosort: true, fmt: (r) => h('button', { type: 'button', class: 't-add', title: 'Add to Compare', onclick: (e) => { e.stopPropagation(); tCmpAdd(sp, r.p.pid); } }, tCmpHas(sp, r.p.pid) ? '✓ Compare' : '+ Compare') });
  const tb = tTable(`scr-${sp}`, cols, rows, { sort: { k: 'edge', dir: 'desc' }, limit: c.limit, onClick: (r) => tOpenPlayer(sp, r.p.pid, c.stat) });
  const teams = [...new Set(U.players.map((p) => p.team))].sort();
  const posSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Position' }, ...T_POS[sp].map((p) => h('button', { type: 'button', 'aria-pressed': String(p === c.pos), onclick: () => { c.pos = p; c.stat = null; c.line = null; render(); } }, p)));
  const statSel = h('select', { 'aria-label': 'Stat', onchange: (e) => { c.stat = e.target.value; c.line = null; render(); } }, ...tStats(sp, isBB(sp) ? null : c.pos).map(([k, l]) => h('option', { value: k, selected: k === c.stat }, l)));
  const lineIn = h('input', { type: 'number', step: '0.5', min: '0', value: String(line), class: 't-line', 'aria-label': 'Line', onchange: (e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) { c.line = v; render(); } } });
  const teamSel = h('select', { 'aria-label': 'Team', onchange: (e) => { c.team = e.target.value; render(); } }, h('option', { value: '' }, 'All teams'), ...teams.map((t) => h('option', { value: t, selected: t === c.team }, isBB(sp) || sp === 'cfb' ? (TI(t).name || t) : t)));
  const search = h('input', { type: 'search', placeholder: 'Find a player…', value: c.q, class: 't-search', 'aria-label': 'Find a player', onchange: (e) => { c.q = e.target.value; render(); } });
  const minG = h('select', { 'aria-label': 'Minimum games', onchange: (e) => { c.minG = Number(e.target.value); render(); } }, ...[1, 3, 5, 8].map((n) => h('option', { value: n, selected: n === c.minG }, `${n}+ games`)));
  const onlyNext = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: c.onlyNext, onchange: (e) => { c.onlyNext = e.target.checked; render(); } }), isBB(sp) ? 'Only teams with a game next' : 'Only teams playing next');
  const posNote = sp === 'nfl' ? 'NFL' : T_SPNAME[sp];
  tRC(root, 
    h('div', { class: 't-controls' }, posSeg, h('label', { class: 't-lab' }, 'Stat', statSel), h('label', { class: 't-lab' }, 'Line', lineIn), teamSel, minG, search, onlyNext),
    h('p', { class: 'note' }, `${posNote} ${c.pos}s ranked by projection minus your line (${line} ${tLow(tStatLabel(sp, c.stat))}).`),
    h('div', { class: 'scroll', style: 'max-height: none' }, tb.el),
    tb.total > tb.shown ? h('button', { type: 'button', class: 'more', onclick: () => { c.limit += 50; render(); } }, `Show more (${tb.total - tb.shown} left)`) : null);
}

// ================================================================= COMPARE & START / SIT
const tCmpIds = (sp) => (tStore.get('ml-compare', {})[sp] || []).map(String);
function tCmpSet(sp, ids) { const all = tStore.get('ml-compare', {}); all[sp] = ids.slice(0, 4); tStore.set('ml-compare', all); }
const tCmpHas = (sp, pid) => tCmpIds(sp).includes(String(pid));
function tCmpAdd(sp, pid) {
  const ids = tCmpIds(sp);
  if (ids.includes(String(pid))) tCmpSet(sp, ids.filter((x) => x !== String(pid)));
  else if (ids.length >= 4) { tCmpSet(sp, [...ids.slice(1), String(pid)]); }
  else tCmpSet(sp, [...ids, String(pid)]);
  render();
}
S.cmpStat = S.cmpStat || {};
function renderCompare() {
  const root = $('.cmp-root'), sp = S.sport;
  if (!tEnsure(sp)) { tLoading(root, sp); return; }
  const U = tUni(sp), ids = tCmpIds(sp).filter((id) => U.byPid.has(id)), ps = ids.map((id) => U.byPid.get(id));
  const opts = U.players.slice().sort((a, b) => a.name.localeCompare(b.name));
  const list = h('datalist', { id: 'cmp-list' }, ...opts.map((p) => h('option', { value: `${p.name} (${p.pos}, ${p.team})` })));
  const inp = h('input', { type: 'search', list: 'cmp-list', placeholder: ids.length >= 4 ? 'Up to 4 players (adding replaces the first)' : 'Add a player…', class: 't-search t-wide', 'aria-label': 'Add a player',
    onchange: (e) => {
      const v = e.target.value.trim().toLowerCase(); if (!v) return;
      const hit = opts.find((p) => `${p.name} (${p.pos}, ${p.team})`.toLowerCase() === v) || opts.find((p) => p.name.toLowerCase() === v) || opts.find((p) => p.name.toLowerCase().includes(v));
      if (hit) tCmpAdd(sp, hit.pid); else e.target.value = '';
    } });
  const statOpts = isBB(sp) ? T_BB : (() => { const pos = [...new Set(ps.map((p) => p.pos))]; const base = [['fp_ppr', 'Fantasy pts (PPR)']]; const more = pos.length === 1 ? tStats(sp, pos[0]).filter(([k]) => k !== 'fp_ppr') : [['pass_rush_yds', 'Pass + rush yds'], ['rush_rec_yds', 'Rush + rec yds'], ['receiving_yards', 'Rec yds'], ['receptions', 'Receptions']]; return [...base, ...more]; })();
  let stat = S.cmpStat[sp];
  if (!stat || !statOpts.some((x) => x[0] === stat)) stat = S.cmpStat[sp] = isBB(sp) ? 'fpts' : 'fp_ppr';
  const statSel = h('select', { 'aria-label': 'Compare on', onchange: (e) => { S.cmpStat[sp] = e.target.value; render(); } }, ...statOpts.map(([k, l]) => h('option', { value: k, selected: k === stat }, l)));
  const chips = h('div', { class: 't-chips' }, ...ps.map((p) => h('span', { class: 't-chip' }, badge(p.team, 'sm'), `${p.name}`, h('button', { type: 'button', title: 'Remove', onclick: () => tCmpAdd(sp, p.pid) }, '×'))));
  const head = [h('div', { class: 't-controls' }, inp, list, h('label', { class: 't-lab' }, 'Compare on', statSel), ps.length ? h('button', { type: 'button', class: 'more', onclick: () => { tCmpSet(sp, []); render(); } }, 'Clear') : null), chips];
  if (ps.length < 2) {
    tRC(root, ...head, h('p', { class: 'empty' }, ps.length ? 'Add at least one more player to compare.' : `Pick 2 to 4 ${T_SPNAME[sp]} players to see them side by side with a start/sit call. You can also add players from the Prop screener with "+ Compare".`));
    return;
  }
  const inj = tInjRows(sp);
  const info = ps.map((p) => {
    const pr = tProject(sp, p, stat), nx = pr && pr.nx;
    const sim = tVsSimilar(sp, p, stat, nx && nx.opp);
    const ij = inj.find((r) => r.team === p.team && nmKey(r.player) === nmKey(p.name));
    let usage = null;
    if (isBB(sp)) usage = `${show(p.mins)} min (L5)`;
    else if (p.pos === 'QB') usage = `${show(mean(p.logs.slice(-5).map((r) => r.attempts || 0)))} att (L5)`;
    else if (sp === 'nfl') usage = `${show(mean(p.logs.slice(-5).map((r) => r.target_share).filter((v) => v != null)))}% tgt share · ${show(mean(p.logs.slice(-5).map((r) => r.carries || 0)))} car (L5)`;
    else usage = `${show(mean(p.logs.slice(-5).map((r) => (r.carries || 0) + (r.receptions || 0))))} touches (L5)`;
    return { p, pr, nx, sim, ij, usage };
  });
  const best = info.slice().filter((x) => x.pr).sort((a, b) => b.pr.proj - a.pr.proj);
  const top = best[0], second = best[1];
  const lab = tLow(tStatLabel(sp, stat));
  // verdict + reasons
  const reasons = [];
  if (top && second) {
    const d = top.pr.proj - second.pr.proj;
    reasons.push(`Projects ${show(top.pr.proj)} ${lab} vs ${show(second.pr.proj)} for ${second.p.name} (${d >= 0 ? '+' : ''}${show(d)}).`);
    if (top.pr.d && second.pr.d) {
      const qt = (top.pr.d.rank - 1) / Math.max(1, top.pr.d.n - 1), qs = (second.pr.d.rank - 1) / Math.max(1, second.pr.d.n - 1);
      reasons.push(`Matchup: ${top.nx.opp} ranks ${ordinal(top.pr.d.rank)} of ${top.pr.d.n} against ${top.p.pos}s (${qt >= 0.66 ? 'soft' : qt <= 0.33 ? 'tough' : 'average'}); ${second.nx.opp} ranks ${ordinal(second.pr.d.rank)} against ${second.p.pos}s (${qs >= 0.66 ? 'soft' : qs <= 0.33 ? 'tough' : 'average'}).`);
    }
    const form = (x) => (x.pr.l3 > x.pr.seas * 1.15 ? 'trending up' : x.pr.l3 < x.pr.seas * 0.85 ? 'trending down' : 'steady');
    reasons.push(`Form: ${top.p.name} ${form(top)} (${show(top.pr.l3)} L3 vs ${show(top.pr.seas)} season); ${second.p.name} ${form(second)} (${show(second.pr.l3)} vs ${show(second.pr.seas)}).`);
    reasons.push(`Floor (bad game, 20th percentile): ${show(top.pr.floor)} vs ${show(second.pr.floor)}. Ceiling (80th): ${show(top.pr.ceil)} vs ${show(second.pr.ceil)}.`);
    [top, second].forEach((x) => { if (x.ij) reasons.push(`Injury: ${x.p.name} is listed ${x.ij.label}${x.ij.detail ? ` (${x.ij.detail})` : ''}.`); if (x.p.missed) reasons.push(`${x.p.name} has missed his team's last ${x.p.missed} game${x.p.missed > 1 ? 's' : ''}.`); if (!x.nx) reasons.push(`${x.p.name} has no game scheduled next.`); });
    if (d < 0.08 * Math.max(1, top.pr.proj)) reasons.push('Close call: the projections are within about 8%. Lean on the matchup, the injury news and your gut.');
  }
  const verdict = top && second ? h('div', { class: 't-verdict' },
    h('div', { class: 't-verdict-h' }, h('span', { class: 't-verdict-k' }, 'Start'), badge(top.p.team, 'sm'), h('b', null, top.p.name), second ? h('span', { class: 'muted' }, ` over ${best.slice(1).map((x) => x.p.name).join(', ')}`) : null),
    h('ul', null, ...reasons.map((r) => h('li', null, r)))) : null;
  // side-by-side table
  const row = (label, fn, opts2 = {}) => h('tr', null, h('th', { class: 'l', scope: 'row' }, label), ...info.map((x) => { const v = fn(x); return h('td', { class: (opts2.best && opts2.best(x) ? 'g ' : '') + (opts2.cls ? opts2.cls(x) : '') }, v == null ? '—' : v); }));
  const maxBy = (fn) => { const vs = info.map(fn).filter((v) => v != null); const m = Math.max(...vs); return (x) => vs.length > 1 && fn(x) === m; };
  const projOf = (x) => (x.pr ? x.pr.proj : null);
  const tbl = h('table', { class: 'dvp t-cmp' },
    h('thead', null, h('tr', null, h('th', null, ''), ...info.map((x) => h('th', null, h('div', { class: 't-cmp-h', onclick: () => tOpenPlayer(sp, x.p.pid, stat) }, badge(x.p.team, 'sm'), h('b', null, x.p.name), h('small', null, `${x.p.pos} · ${x.p.team}`)), tStar(sp, x.p.pid))))),
    h('tbody', null,
      row('Next game', (x) => (x.nx ? `${x.nx.home ? 'vs' : '@'} ${x.nx.opp} · ${x.nx.label}` : 'None scheduled')),
      row('Status', (x) => (x.ij ? h('span', { class: `t-pill ${x.ij.status}` }, `${x.ij.label}${x.ij.detail ? ` · ${x.ij.detail}` : ''}`) : x.p.missed ? `Missed last ${x.p.missed}` : 'Active'), { cls: (x) => (x.ij || x.p.missed ? 'r' : '') }),
      row(h('b', null, `Projection (${lab})`), (x) => (x.pr ? h('b', null, show(x.pr.proj)) : null), { best: maxBy(projOf) }),
      row('Season avg', (x) => (x.pr ? show(x.pr.seas) : null), { best: maxBy((x) => (x.pr ? x.pr.seas : null)) }),
      row('L5 avg', (x) => (x.pr ? show(x.pr.l5) : null), { best: maxBy((x) => (x.pr ? x.pr.l5 : null)) }),
      row('L3 avg', (x) => (x.pr ? show(x.pr.l3) : null), { best: maxBy((x) => (x.pr ? x.pr.l3 : null)) }),
      row('Median', (x) => (x.pr ? show(x.pr.med) : null)),
      row('Floor / ceiling', (x) => (x.pr ? `${show(x.pr.floor)} / ${show(x.pr.ceil)}` : null), { best: maxBy((x) => (x.pr ? x.pr.floor : null)) }),
      row('Opponent allows', (x) => (x.pr && x.pr.d ? `${show(x.pr.d.pg)} to ${x.p.pos}s · ${ordinal(x.pr.d.rank)} of ${x.pr.d.n}` : null), { cls: (x) => (x.pr && x.pr.d ? tPctCls(x.pr.d.rank, x.pr.d.n) : '') }),
      row('Vs similar defenses', (x) => (x.sim ? `${show(x.sim.avg)} (vs ${x.sim.opps.join(', ')})` : null)),
      row(isBB(sp) ? 'Team implied pts' : 'Team implied total', (x) => (x.nx && x.nx.implied != null ? show(x.nx.implied) : null), { best: maxBy((x) => (x.nx && x.nx.implied != null ? x.nx.implied : null)) }),
      row('Role', (x) => x.usage),
      row('Games', (x) => `${x.p.logs.length}${x.p.missedN ? ` (missed ${x.p.missedN})` : ''}`),
      row('L8', (x) => tSpark(x.pr ? x.pr.vals.slice(-8) : [], x.pr ? x.pr.proj : null))));
  tRC(root, ...head, verdict, h('div', { class: 'scroll', style: 'max-height: none' }, tbl),
    h('p', { class: 'note' }, 'Projection = 60% season avg + 40% L5, adjusted for the opponent.'));
}
function tSpark(vals, ref) {
  if (!vals.length) return null;
  const W = 120, H = 30, max = Math.max(...vals, ref || 0, 1), bw = W / vals.length;
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('class', 't-spark');
  vals.forEach((v, i) => { const r = document.createElementNS(ns, 'rect'); const hh = Math.max(1, (v / max) * (H - 2)); r.setAttribute('x', i * bw + 1); r.setAttribute('y', H - hh); r.setAttribute('width', bw - 2); r.setAttribute('height', hh); r.setAttribute('rx', 1.5); r.setAttribute('fill', ref != null && v >= ref ? 'var(--ok)' : 'var(--muted)'); const t = document.createElementNS(ns, 'title'); t.textContent = show(v); r.append(t); svg.append(r); });
  if (ref != null) { const l = document.createElementNS(ns, 'line'); const y = H - (ref / max) * (H - 2); l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', y); l.setAttribute('y2', y); l.setAttribute('stroke', 'var(--fg)'); l.setAttribute('stroke-dasharray', '3 2'); l.setAttribute('stroke-width', 1); svg.append(l); }
  return svg;
}

// ================================================================= INJURY REPORT
const T_INJ = {};
function tInjRows(sp) {
  if (T_INJ[sp] && T_INJ[sp].rows) return T_INJ[sp].rows;
  if (!T_INJ[sp]) {
    T_INJ[sp] = { rows: null };
    const path = sp === 'nfl' ? 'data/injuries.csv' : `data/${sp}/injuries.csv`;
    Promise.all([d3.csv(`${path}?v=${Date.now()}`).catch(() => []), d3.csv(`data/manual.csv?v=${Date.now()}`).catch(() => [])]).then(([rows, man]) => {
      const today = new Date().toLocaleDateString('en-CA');
      const manual = man.filter((r) => r.sport === sp && r.player && (!r.until || r.until >= today) && r.status !== 'starter')
        .map((r) => ({ team: r.team, player: r.player, position: r.position || '', status: String(r.status).toLowerCase(), label: r.status[0].toUpperCase() + r.status.slice(1), detail: r.note || '', source: 'Your manual list', updated: '' }));
      const seen = new Set(manual.map((r) => `${r.team}|${nmKey(r.player)}`));
      T_INJ[sp].rows = [...manual, ...rows.filter((r) => !seen.has(`${r.team}|${nmKey(r.player)}`))];
      if (['injuries', 'compare', 'home'].includes(S.view)) render();
    });
  }
  return [];
}
const T_DEF = new Set(['DL', 'DE', 'DT', 'NT', 'LB', 'ILB', 'OLB', 'MLB', 'EDGE', 'DB', 'CB', 'S', 'SS', 'FS', 'DEF']);
const T_OL = new Set(['OL', 'OT', 'OG', 'G', 'C', 'T', 'LT', 'RT', 'LG', 'RG']);
const T_ST = new Set(['K', 'P', 'LS']);
function tInjGroup(sp, pos) {
  if (isBB(sp)) return ['G', 'F', 'C'].includes(pos) ? pos : '';
  if (T_DEF.has(pos)) return 'Defense';
  if (T_OL.has(pos)) return 'OL';
  if (T_ST.has(pos)) return 'K/P';
  if (pos === 'FB') return 'RB';
  return pos;
}
const T_INJ_TABS = { nfl: ['All', 'QB', 'RB', 'WR', 'TE', 'OL', 'K/P', 'Defense'], cfb: ['All', 'QB', 'RB', 'WR', 'TE'], nba: ['All', 'G', 'F', 'C'], cbb: ['All', 'G', 'F', 'C'] };
const T_SEV = { out: 0, doubtful: 1, questionable: 2, probable: 3 };
S.inj = S.inj || {};
function renderInjuries() {
  const root = $('.inj-root'), sp = S.sport;
  const st = S.inj[sp] || (S.inj[sp] = { tab: 'All', status: 'all', team: '', q: '' });
  const college = sp === 'cfb' || sp === 'cbb';
  let rows = tInjRows(sp).map((r) => ({ ...r }));
  const ready = T_INJ[sp] && T_INJ[sp].rows;
  // positions for the NBA list (the league's report doesn't include them): match to our player logs
  if ((isBB(sp) || college) && tReady(sp)) {
    const U = tUni(sp), byName = new Map(U.players.map((p) => [`${p.team}|${nmKey(p.name)}`, p]));
    let anyName = null; // players hurt all season have no logs this year: fall back to any season's position
    rows.forEach((r) => {
      if (r.position) return;
      const p = byName.get(`${r.team}|${nmKey(r.player)}`);
      if (p) { r.position = p.pos; r.pid = p.pid; return; }
      if (!anyName) { anyName = new Map(); SPX[sp]().logs.forEach((x) => anyName.set(nmKey(x.player), x.position)); }
      r.position = anyName.get(nmKey(r.player)) || '';
    });
  }
  // college: no public injury feed, so list rotation players who have sat out their team's recent games (from box scores)
  if (college && tReady(sp)) {
    const U = tUni(sp), have = new Set(rows.map((r) => `${r.team}|${nmKey(r.player)}`));
    U.players.forEach((p) => {
      const need = isBB(sp) ? 3 : 2;
      if (p.missed < need || have.has(`${p.team}|${nmKey(p.name)}`)) return;
      const role = isBB(sp) ? mean(p.logs.map((r) => r.min || 0)) >= 15 : p.pos === 'QB' ? mean(p.logs.map((r) => r.attempts || 0)) >= 10 : mean(p.logs.map((r) => (r.carries || 0) + (r.receptions || 0))) >= 3;
      if (!role || p.logs.length / Math.max(1, p.teamGames) < 0.25) return;
      rows.push({ team: p.team, player: p.name, position: p.pos, pid: p.pid, status: 'absent', label: `Missed last ${p.missed}`, detail: 'Not in the box score (reason not reported)', source: 'Box scores', updated: '' });
    });
  }
  rows.forEach((r) => { r.grp = tInjGroup(sp, r.position); });
  const tabs = T_INJ_TABS[sp];
  const count = (t) => rows.filter((r) => t === 'All' || r.grp === t).length;
  if (!tabs.includes(st.tab)) st.tab = 'All';
  const statusOf = (r) => (r.label === 'Injured Reserve' || /^ir$/i.test(r.label) ? 'ir' : r.status);
  let list = rows.filter((r) => st.tab === 'All' || r.grp === st.tab);
  if (st.status !== 'all') list = list.filter((r) => statusOf(r) === st.status);
  if (st.team) list = list.filter((r) => r.team === st.team);
  const q = st.q.trim().toLowerCase();
  if (q) list = list.filter((r) => `${r.player} ${r.team} ${r.detail}`.toLowerCase().includes(q));
  const teams = [...new Set(rows.map((r) => r.team).filter(Boolean))].sort();
  const statuses = [['all', 'All statuses'], ['out', 'Out'], ['ir', 'Injured reserve'], ['doubtful', 'Doubtful'], ['questionable', 'Questionable'], ['probable', 'Probable']].filter(([k]) => k === 'all' || rows.some((r) => statusOf(r) === k));
  if (college && rows.some((r) => r.status === 'absent')) statuses.push(['absent', 'Missed recent games']);
  const cols = [
    { k: 'player', label: 'Player', l: true, sv: (r) => r.player, fmt: (r) => h('span', { class: 't-who' }, badge(r.team, 'sm'), h('span', null, h('b', null, r.player), h('small', null, `${r.position || '—'} · ${r.team}`))) },
    { k: 'status', label: 'Status', l: true, sv: (r) => (r.status in T_SEV ? T_SEV[r.status] : 5) + (statusOf(r) === 'ir' ? -0.5 : 0), fmt: (r) => h('span', { class: `t-pill ${r.status}` }, r.label || r.status) },
    { k: 'detail', label: 'Injury', l: true, fmt: (r) => r.detail || '—' },
  ];
  if (sp === 'nfl') cols.push({ k: 'practice', label: 'Practice', l: true, fmt: (r) => r.practice || '—', tip: () => 'Latest practice participation from Sleeper' });
  if (sp === 'nba') cols.push({ k: 'game', label: 'Game', l: true, fmt: (r) => r.game || '—' });
  if (rows.some((r) => r.comment)) cols.push({ k: 'comment', label: 'Notes', l: true, fmt: (r) => r.comment || '' });
  cols.push({ k: 'updated', label: 'Updated', l: true, sv: (r) => r.updated, fmt: (r) => tWhen(r.updated) });
  const tb = tTable(`inj-${sp}`, cols, list, { sort: { k: 'updated', dir: 'desc' }, onClick: (r) => { if (sp === 'nfl' && r.player_id && IDX.logs.has(r.player_id)) tOpenPlayer(sp, r.player_id); else if (r.pid) tOpenPlayer(sp, r.pid); } });
  const src = sp === 'nfl' ? 'Sleeper\'s injury data (checked every hour).'
    : sp === 'nba' ? 'the NBA\'s official injury report (checked every hour).'
      : 'box scores (regular players who missed recent games; there\'s no public college injury feed).';
  const tabBar = h('div', { class: 'subnav t-tabs', role: 'tablist' }, ...tabs.map((t) => h('button', { type: 'button', 'aria-current': String(t === st.tab), onclick: () => { st.tab = t; render(); } }, `${t} `, h('small', null, String(count(t))))));
  tRC(root, tabBar,
    h('div', { class: 't-controls' },
      h('select', { 'aria-label': 'Status', onchange: (e) => { st.status = e.target.value; render(); } }, ...statuses.map(([k, l]) => h('option', { value: k, selected: k === st.status }, l))),
      h('select', { 'aria-label': 'Team', onchange: (e) => { st.team = e.target.value; render(); } }, h('option', { value: '' }, 'All teams'), ...teams.map((t) => h('option', { value: t, selected: t === st.team }, isBB(sp) || sp === 'cfb' ? (TI(t).name || t) : t))),
      h('input', { type: 'search', class: 't-search', placeholder: 'Find a player or injury…', value: st.q, 'aria-label': 'Search', onchange: (e) => { st.q = e.target.value; render(); } })),
    h('p', { class: 'note' }, `Source: ${src}`),
    !ready ? h('p', { class: 'empty' }, 'Loading…') : list.length ? h('div', { class: 'scroll', style: 'max-height: 70vh' }, tb.el) : h('p', { class: 'empty' }, 'Nobody on the list here.'));
}
function tWhen(u) {
  if (!u) return '—';
  const m = String(u).match(/^(\d{4})-(\d\d)-(\d\d)_(\d\d)(?:_(\d\d))?(AM|PM)$/);
  if (m) return `${Number(m[2])}/${Number(m[3])} ${Number(m[4])}:${m[5] || '30'} ${m[6]} ET`;
  const d = new Date(String(u).length <= 16 ? `${u}Z` : u);
  return Number.isNaN(d) ? String(u) : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ================================================================= TOOLS HUB
const T_ICONS = {
  filter: 'M4 5h16l-6 7v6l-4 2v-8z', compare: 'M7 4v16M17 4v16M3 8h8M13 16h8', cross: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z', games: 'M4 6h16v12H4zM12 6v12M4 12h16',
  player: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-4 4-6 8-6s8 2 8 6', shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z', team: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M12 20c0-3 3-5 6-5s4 1 4 3',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7', trend: 'M3 17l6-6 4 4 8-8M15 7h6v6', total: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 9.5h4M10 7.5v4M14 15h3',
  sleeper: 'M20 14a8 8 0 1 1-10-10 6 6 0 0 0 10 10z', home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5', edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
};
const T_TOOLS = [
  { id: 'screener', title: 'Prop research screener', desc: 'Rank every player at any stat against your line: hit rates, projection, matchup and similar-defense results in one table.', cats: ['props', 'research'], route: 'screener', icon: 'filter', color: '#16a34a', featured: true },
  { id: 'compare', title: 'Compare & Start/Sit', desc: 'Put 2 to 4 players side by side and get a start/sit call with the reasons behind it.', cats: ['fantasy', 'research'], route: 'compare', icon: 'compare', color: '#16a34a', featured: true },
  { id: 'injuries', title: 'Injury report', desc: 'Everyone on the injury report, by position, with status, injury and practice notes.', cats: ['injuries'], route: 'injuries', icon: 'cross', color: '#e11d48', featured: true },
  { id: 'games', title: 'Games & matchup research', desc: 'Every upcoming game with lines. Open a game for odds, defense vs position, players, usage and trends.', cats: ['research', 'props'], route: 'home', icon: 'games', color: '#2563eb', featured: true },
  { id: 'props', title: 'Player prop card', desc: 'One player against any line: hit rates, game log, history vs the opponent and how his position does against them.', cats: ['props', 'research'], route: 'stats/players', icon: 'player', color: '#7c3aed', sports: ['nfl'] },
  { id: 'dvp', title: 'Defense vs position rankings', desc: 'What every defense allows to QBs, RBs, WRs, TEs and kickers, ranked 1 to 32.', cats: ['research', 'props', 'fantasy'], route: 'stats/dvp', icon: 'shield', color: '#0891b2', sports: ['nfl'] },
  { id: 'teams', title: 'Team stats & with/without splits', desc: 'Team offense and defense numbers, and how players do with or without a teammate.', cats: ['research'], route: 'stats/teams', icon: 'team', color: '#0891b2', sports: ['nfl'] },
  { id: 'fantasy', title: 'Fantasy matchups & rankings', desc: 'Defense vs fantasy positions, weekly projections and rest-of-season schedules.', cats: ['fantasy'], route: 'fantasy', icon: 'trophy', color: '#ca8a04', sports: ['nfl', 'nba'] },
  { id: 'trends', title: 'Betting trends', desc: 'Against-the-spread and over/under trends for the next slate, sorted by edge.', cats: ['research', 'props'], route: 'trends', icon: 'trend', color: '#ea580c' },
  { id: 'totals', title: 'Totals board', desc: 'Projected totals from tempo and efficiency vs the posted line, with the model\'s track record.', cats: ['props'], route: 'totals', icon: 'total', color: '#ea580c', sports: ['cbb'] },
  // { id: 'sleeper', ... } My Sleeper team: off for now
  { id: 'favorites', title: 'Your favorite players', desc: 'Players you starred, with their next matchup and projection, on the Home dashboard.', cats: ['fantasy', 'research'], route: 'home', anchor: '.d-favs', icon: 'home', color: '#64748b' },
  { id: 'edit', title: 'Edit site look & layout', desc: 'Change colors and fonts, reorder or hide sections, and rename anything, without code.', cats: ['site'], route: null, icon: 'edit', color: '#64748b' },
];
S.toolsCat = S.toolsCat || 'all';
S.toolsView = tStore.get('ml-tools-view', 'grid');
S.toolsQ = S.toolsQ || '';
function tToolIcon(t) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', '#fff'); svg.setAttribute('stroke-width', '1.9'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', T_ICONS[t.icon] || T_ICONS.games); svg.append(p);
  return h('span', { class: 't-ico', style: `background:${t.color}` }, svg);
}
function tOpenTool(t) {
  if (t.id === 'edit') { const b = document.querySelector('footer .ed-edit-link'); if (b) b.click(); return; }
  go(t.route);
  if (t.anchor) setTimeout(() => { const el = document.querySelector(t.anchor); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 400);
}
function renderTools() {
  const root = $('.tools-root'), sp = S.sport, fav = tStore.get('ml-fav-tools', []);
  const avail = T_TOOLS.filter((t) => !t.sports || t.sports.includes(sp));
  const cats = [['all', 'All'], ['research', 'Research'], ['props', 'Props & betting'], ['fantasy', 'Fantasy'], ['injuries', 'Injuries'], ['fav', `Favorites (${avail.filter((t) => fav.includes(t.id)).length})`]];
  const q = S.toolsQ.trim().toLowerCase();
  const shown = avail.filter((t) => (S.toolsCat === 'all' || (S.toolsCat === 'fav' ? fav.includes(t.id) : t.cats.includes(S.toolsCat))) && (!q || `${t.title} ${t.desc} ${t.cats.join(' ')}`.toLowerCase().includes(q)));
  const card = (t) => h('div', { class: 't-tool', 'data-tool': t.id, role: 'button', tabIndex: 0, style: `--tc:${t.color}`, onclick: () => tOpenTool(t), onkeydown: (e) => { if (e.key === 'Enter') tOpenTool(t); } },
    tToolIcon(t), h('div', { class: 't-tool-tx' }, h('b', null, t.title), h('span', null, t.desc)),
    h('button', { type: 'button', class: `t-star${fav.includes(t.id) ? ' on' : ''}`, title: 'Favorite tool', onclick: (e) => { e.stopPropagation(); tStore.set('ml-fav-tools', fav.includes(t.id) ? fav.filter((x) => x !== t.id) : [...fav, t.id]); render(); } }, fav.includes(t.id) ? '★' : '☆'));
  const featured = S.toolsCat === 'all' && !q ? shown.filter((t) => t.featured) : [];
  const rest = featured.length ? shown : shown;
  const cls = S.toolsView === 'list' ? 't-tools list' : 't-tools';
  tRC(root, 
    h('div', { class: 't-controls t-tools-bar' },
      h('div', { class: 't-cats', role: 'group', 'aria-label': 'Category' }, ...cats.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(S.toolsCat === k), onclick: () => { S.toolsCat = k; render(); } }, l))),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, ...[['grid', '▦ Grid'], ['list', '☰ List']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(S.toolsView === k), onclick: () => { S.toolsView = k; tStore.set('ml-tools-view', k); render(); } }, l)))),
    h('div', { class: 't-controls' },
      h('select', { 'aria-label': 'Sport', onchange: (e) => { const b = document.querySelector(`.sport-sw button[data-s="${e.target.value}"]`); if (b) b.click(); } }, ...T_SP.map((s) => h('option', { value: s, selected: s === sp }, T_SPNAME[s]))),
      h('input', { type: 'search', class: 't-search t-wide', placeholder: 'Search tools…', value: S.toolsQ, 'aria-label': 'Search tools', oninput: (e) => { S.toolsQ = e.target.value; const pos = e.target.selectionStart; render(); const el = $('.tools-root input[type=search]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } } })),
    // each section is its own block (Featured / All tools) so it can be hidden or styled on its own in Edit site
    featured.length ? h('div', { class: 't-featured' }, h('h3', { class: 't-h' }, 'Featured'), h('div', { class: cls }, ...featured.map(card))) : null,
    h('div', { class: 't-all' }, h('h3', { class: 't-h' }, featured.length ? 'All tools' : `${shown.length} tool${shown.length === 1 ? '' : 's'}`),
      shown.length ? h('div', { class: cls }, ...rest.map(card)) : h('p', { class: 'empty' }, S.toolsCat === 'fav' ? 'Star a tool to keep it here.' : 'No tools match.')));
}

// ================================================================= HOME DASHBOARD
function renderDash() {
  const sp = S.sport;
  const quick = $('.d-quick-body'), favs = $('.d-favs-body'), slp = $('.d-sleeper'), best = $('.d-best-body'), trend = $('.d-trend');
  if (!quick) return;
  tRC(quick, h('div', { class: 't-tools mini' }, ...T_TOOLS.filter((t) => t.featured || t.id === 'props' || t.id === 'dvp').filter((t) => !t.sports || t.sports.includes(sp)).slice(0, 5)
    .map((t) => h('div', { class: 't-tool', 'data-tool': t.id, role: 'button', tabIndex: 0, onclick: () => tOpenTool(t), onkeydown: (e) => { if (e.key === 'Enter') tOpenTool(t); } }, tToolIcon(t), h('div', { class: 't-tool-tx' }, h('b', null, t.title))))),
  h('button', { type: 'button', class: 'more', onclick: () => go('tools') }, 'All tools →'));
  if (slp) slp.hidden = sp !== 'nfl';
  if (trend) trend.hidden = sp !== 'nfl';
  if (!tReady(sp)) { tRC(favs, h('p', { class: 'empty' }, 'Loading…')); tRC(best, ); return; }
  const U = tUni(sp);
  // favorites
  const mine = tFavs().filter((f) => f.sp === sp).map((f) => U.byPid.get(String(f.pid))).filter(Boolean);
  tRC(favs, mine.length ? h('div', { class: 'd-list' }, ...mine.map((p) => tDashRow(sp, p))) : h('p', { class: 'empty' }, 'Star players (☆) in the Prop screener or Compare to pin them here with their next matchup.'));
  // best matchups: regulars whose next opponent gives up the most at their main stat
  const cands = [];
  U.players.forEach((p) => {
    const stat = T_MAIN[p.pos]; if (!stat || !U.next.has(p.team) || p.missed) return;
    const pr = tProject(sp, p, stat); if (!pr || !pr.d) return;
    cands.push({ p, pr, stat });
  });
  const byPos = new Map();
  cands.forEach((x) => { if (!byPos.has(x.p.pos)) byPos.set(x.p.pos, []); byPos.get(x.p.pos).push(x); });
  const picks = [];
  byPos.forEach((a) => {
    a.sort((x, y) => y.pr.base - x.pr.base);
    const regulars = a.slice(0, Math.max(6, Math.round(a.length * (isBB(sp) ? 0.25 : 0.35))));
    regulars.sort((x, y) => y.pr.f - x.pr.f).slice(0, isBB(sp) ? 3 : 2).forEach((x) => picks.push(x));
  });
  picks.sort((a, b) => b.pr.f - a.pr.f);
  tRC(best, picks.length ? h('div', { class: 'd-list' }, ...picks.slice(0, 8).map((x) => h('div', { class: 'd-row', role: 'button', tabIndex: 0, onclick: () => tOpenPlayer(sp, x.p.pid, x.stat) },
    badge(x.p.team, 'sm'), h('div', { class: 'd-main' }, h('b', null, x.p.name), h('small', null, `${x.p.pos} · ${x.pr.nx.home ? 'vs' : '@'} ${x.pr.nx.opp} · ${x.pr.nx.label}`)),
    h('div', { class: 'd-num' }, h('b', null, show(x.pr.proj)), h('small', null, `Proj ${tTitle(tStatLabel(sp, x.stat))}`)),
    h('div', { class: 'd-num g' }, h('b', null, `+${Math.round((x.pr.f - 1) * 100)}%`), h('small', null, `${x.pr.nx.opp}: ${ordinal(x.pr.d.rank)}`)))))
    : h('p', { class: 'empty' }, 'No upcoming games yet.'));
  // Sleeper boxes are off for now (their cards were removed from index.html); add the cards back to turn them on
  if (sp === 'nfl' && slp) tRenderSleeper();
  if (sp === 'nfl' && trend) tRenderTrending();
}
function tDashRow(sp, p) {
  const stat = T_MAIN[p.pos], pr = tProject(sp, p, stat), nx = pr && pr.nx;
  return h('div', { class: 'd-row', role: 'button', tabIndex: 0, onclick: () => tOpenPlayer(sp, p.pid, stat) },
    badge(p.team, 'sm'), h('div', { class: 'd-main' }, h('b', null, p.name), h('small', null, `${p.pos} · ${nx ? `${nx.home ? 'vs' : '@'} ${nx.opp} · ${nx.label}` : 'no game scheduled'}${p.missed ? ` · missed last ${p.missed}` : ''}`)),
    h('div', { class: 'd-num' }, h('b', null, pr ? show(pr.proj) : '—'), h('small', null, `Proj ${tTitle(tStatLabel(sp, stat))}`)),
    pr && pr.d ? h('div', { class: `d-num ${tPctCls(pr.d.rank, pr.d.n)}` }, h('b', null, ordinal(pr.d.rank)), h('small', null, `opp rank of ${pr.d.n}`)) : h('div', { class: 'd-num' }),
    tStar(sp, p.pid));
}

// ---------------------------------------------------------------- Sleeper (NFL)
const T_SLP = { players: null, trending: null, state: tStore.get('ml-sleeper', {}), leagues: null, roster: null, err: '', busy: false };
function tSleeperFiles() {
  if (T_SLP.players) return;
  T_SLP.players = new Map();
  d3.csv(`data/sleeper_players.csv?v=${Date.now()}`).then((rows) => { T_SLP.players = new Map(rows.map((r) => [String(r.sleeper_id), r])); if (S.view === 'home') renderDash(); }).catch(() => {});
  d3.csv(`data/sleeper_trending.csv?v=${Date.now()}`).then((rows) => { T_SLP.trending = rows; if (S.view === 'home') renderDash(); }).catch(() => { T_SLP.trending = []; });
}
async function tSleeperGet(path) {
  const r = await fetch(`https://api.sleeper.app/v1/${path}`);
  if (!r.ok) throw new Error(`Sleeper said ${r.status}`);
  return r.json();
}
async function tSleeperConnect(username) {
  T_SLP.busy = true; T_SLP.err = ''; renderDash();
  try {
    const u = await tSleeperGet(`user/${encodeURIComponent(username)}`);
    if (!u || !u.user_id) throw new Error(`No Sleeper user named "${username}"`);
    const leagues = await tSleeperGet(`user/${u.user_id}/leagues/nfl/${S.season}`);
    T_SLP.state = { username: u.username || username, display: u.display_name, user_id: u.user_id, league_id: leagues[0] ? leagues[0].league_id : null };
    T_SLP.leagues = leagues;
    tStore.set('ml-sleeper', T_SLP.state);
    await tSleeperRoster();
  } catch (e) { T_SLP.err = e.message || 'Could not reach Sleeper'; }
  T_SLP.busy = false; renderDash();
}
async function tSleeperRoster() {
  const st = T_SLP.state;
  if (!st.league_id) { T_SLP.roster = null; return; }
  const rosters = await tSleeperGet(`league/${st.league_id}/rosters`);
  T_SLP.roster = rosters.find((r) => r.owner_id === st.user_id || (r.co_owners || []).includes(st.user_id)) || null;
}
function tRenderSleeper() {
  tSleeperFiles();
  const box = $('.d-sleeper-body'), st = T_SLP.state;
  if (st.user_id && !T_SLP.leagues && !T_SLP.busy && !T_SLP.err) {
    T_SLP.busy = true;
    tSleeperGet(`user/${st.user_id}/leagues/nfl/${S.season}`).then((l) => { T_SLP.leagues = l; return tSleeperRoster(); }).catch((e) => { T_SLP.err = e.message; }).finally(() => { T_SLP.busy = false; renderDash(); });
  }
  if (!st.user_id) {
    const inp = h('input', { type: 'text', placeholder: 'Your Sleeper username', class: 't-search', 'aria-label': 'Sleeper username', onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) tSleeperConnect(e.target.value.trim()); } });
    tRC(box, h('p', { class: 'note' }, 'See your fantasy roster with this week\'s matchups and projections. Sleeper is read-only and needs no password; your username stays in this browser.'),
      h('div', { class: 't-controls' }, inp, h('button', { type: 'button', class: 'more', disabled: T_SLP.busy, onclick: () => { if (inp.value.trim()) tSleeperConnect(inp.value.trim()); } }, T_SLP.busy ? 'Connecting…' : 'Connect')),
      T_SLP.err ? h('p', { class: 'note r' }, T_SLP.err) : null);
    return;
  }
  const leagueSel = T_SLP.leagues && T_SLP.leagues.length > 1 ? h('select', { 'aria-label': 'League', onchange: async (e) => { T_SLP.state.league_id = e.target.value; tStore.set('ml-sleeper', T_SLP.state); T_SLP.busy = true; renderDash(); try { await tSleeperRoster(); } catch (er) { T_SLP.err = er.message; } T_SLP.busy = false; renderDash(); } },
    ...T_SLP.leagues.map((l) => h('option', { value: l.league_id, selected: l.league_id === st.league_id }, l.name))) : null;
  const top = h('div', { class: 't-controls' }, h('span', null, 'Signed in as ', h('b', null, st.display || st.username)), leagueSel,
    h('button', { type: 'button', class: 'more', onclick: () => { T_SLP.state = {}; T_SLP.leagues = null; T_SLP.roster = null; tStore.set('ml-sleeper', {}); renderDash(); } }, 'Disconnect'));
  if (T_SLP.err) { tRC(box, top, h('p', { class: 'note r' }, T_SLP.err)); return; }
  if (T_SLP.busy || !T_SLP.leagues) { tRC(box, top, h('p', { class: 'empty' }, 'Loading your league…')); return; }
  if (!T_SLP.leagues.length) { tRC(box, top, h('p', { class: 'empty' }, `No ${S.season} NFL leagues on that account.`)); return; }
  if (!T_SLP.roster) { tRC(box, top, h('p', { class: 'empty' }, 'Couldn\'t find your team in this league.')); return; }
  const U = tUni('nfl'), byGsis = new Map(U.players.map((p) => [p.pid, p])), byName = new Map(U.players.map((p) => [`${p.team}|${nmKey(p.name)}`, p]));
  const inj = tInjRows('nfl');
  const mapP = (sid) => {
    const s = T_SLP.players.get(String(sid));
    if (!s) return { sid, name: String(sid) };
    const p = (s.gsis_id && byGsis.get(s.gsis_id)) || byName.get(`${s.team}|${nmKey(s.player)}`);
    return { sid, s, p, name: s.player, pos: s.position, team: s.team, ij: inj.find((r) => r.team === s.team && nmKey(r.player) === nmKey(s.player)) };
  };
  const starters = (T_SLP.roster.starters || []).filter((x) => x && x !== '0').map(mapP);
  const bench = (T_SLP.roster.players || []).filter((x) => !(T_SLP.roster.starters || []).includes(x)).map(mapP);
  const line = (x) => {
    const pr = x.p ? tProject('nfl', x.p, 'fp_ppr') : null, nx = pr && pr.nx;
    return h('div', { class: 'd-row', role: x.p ? 'button' : null, tabIndex: x.p ? 0 : null, onclick: x.p ? () => tOpenPlayer('nfl', x.p.pid, 'fp_ppr') : null },
      x.team ? badge(x.team, 'sm') : h('span', { class: 'badge sm' }),
      h('div', { class: 'd-main' }, h('b', null, x.name, x.ij ? h('span', { class: `t-pill ${x.ij.status}` }, x.ij.label === 'Injured Reserve' ? 'IR' : x.ij.label) : null), h('small', null, `${x.pos || ''}${nx ? ` · ${nx.home ? 'vs' : '@'} ${nx.opp}` : x.pos === 'DEF' ? '' : ' · no game'}`)),
      h('div', { class: 'd-num' }, h('b', null, pr ? show(pr.proj) : '—'), h('small', null, 'proj PPR')),
      pr && pr.d ? h('div', { class: `d-num ${tPctCls(pr.d.rank, pr.d.n)}` }, h('b', null, ordinal(pr.d.rank)), h('small', null, 'opp rank')) : h('div', { class: 'd-num' }),
      x.p ? h('button', { type: 'button', class: 't-add', onclick: (e) => { e.stopPropagation(); tCmpAdd('nfl', x.p.pid); } }, tCmpHas('nfl', x.p.pid) ? '✓' : '+ Compare') : null);
  };
  tRC(box, top, h('h3', null, 'Starters'), h('div', { class: 'd-list' }, ...starters.map(line)),
    h('details', null, h('summary', null, `Bench (${bench.length})`), h('div', { class: 'd-list' }, ...bench.map(line))),
    h('p', { class: 'note' }, 'Projections are PPR.'));
}
function tRenderTrending() {
  tSleeperFiles();
  const box = $('.d-trend-body');
  const tr = T_SLP.trending;
  if (!tr) { tRC(box, h('p', { class: 'empty' }, 'Loading…')); return; }
  if (!tr.length) { tRC(box, h('p', { class: 'empty' }, 'No trending data yet.')); return; }
  const col = (kind, title) => h('div', null, h('h3', null, title), h('ol', { class: 'd-trend-l' }, ...tr.filter((r) => r.type === kind).slice(0, 8).map((r) => h('li', null, r.team ? badge(r.team, 'sm') : null, h('span', null, h('b', null, r.player), h('small', null, ` ${r.position}${r.injury ? ` · ${r.injury}` : ''}`)), h('small', { class: 'muted' }, Number(r.count).toLocaleString())))));
  tRC(box, h('div', { class: 'grid' }, col('add', 'Most added'), col('drop', 'Most dropped')), h('p', { class: 'note' }, 'Adds and drops across all Sleeper leagues in the last 24 hours.'));
}

// ---------------------------------------------------------------- styles for these pages
document.head.append(h('style', null, `
  .t-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
  .t-controls select, .t-search, .t-line { font: inherit; font-size: .88rem; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--fg); }
  .t-search { min-width: 12rem; }
  .t-wide { flex: 1; min-width: 14rem; }
  .t-line { width: 5.5rem; }
  .t-lab { display: inline-flex; gap: 6px; align-items: center; font-size: .8rem; color: var(--muted); }
  .t-tbl td, .t-tbl th { white-space: nowrap; }
  .t-tbl td.g { color: var(--ok); font-weight: 600; } .t-tbl td.r { color: var(--bad); font-weight: 600; }
  .t-who { display: inline-flex; gap: 8px; align-items: center; }
  .t-who > span { display: flex; flex-direction: column; line-height: 1.15; }
  .t-who small, .d-main small, .d-num small { color: var(--muted); font-size: .75rem; }
  .t-star { border: 0; background: none; color: var(--muted); font-size: 1.05rem; cursor: pointer; padding: 0 4px; line-height: 1; }
  .t-star.on { color: #eab308; }
  .t-add { font: inherit; font-size: .75rem; border: 1px solid var(--line); background: var(--panel); color: var(--accent); border-radius: 999px; padding: 3px 9px; cursor: pointer; white-space: nowrap; }
  .t-add:hover { background: var(--item); }
  .t-pill { display: inline-block; font-size: .72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-left: 6px; background: color-mix(in srgb, var(--muted) 15%, transparent); color: var(--fg); white-space: nowrap; }
  td > .t-pill { margin-left: 0; }
  .t-pill.out { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .t-pill.doubtful { background: color-mix(in srgb, var(--bad) 10%, transparent); color: var(--bad); }
  .t-pill.questionable { background: color-mix(in srgb, var(--mid) 18%, transparent); color: var(--mid); }
  .t-pill.absent { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
  .t-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .t-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 4px; border: 1px solid var(--line); border-radius: 999px; font-size: .85rem; background: var(--panel); }
  .t-chip button { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 1rem; padding: 0 6px; }
  .t-verdict { border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); background: color-mix(in srgb, var(--ok) 6%, var(--panel)); border-radius: var(--radius); padding: 12px 14px; margin: 12px 0; }
  .t-verdict-h { display: flex; align-items: center; gap: 8px; font-size: 1.05rem; }
  .t-verdict-k { font-weight: 700; color: #fff; background: var(--ok); border-radius: 6px; padding: 2px 8px; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .t-verdict ul { margin: 8px 0 0; padding-left: 20px; font-size: .9rem; }
  .t-verdict li { margin: 3px 0; }
  .t-cmp th[scope=row] { color: var(--muted); font-weight: 500; text-align: left; white-space: nowrap; }
  .t-cmp thead th { vertical-align: bottom; text-align: left; }
  .t-cmp td { text-align: left; vertical-align: middle; }
  .t-cmp td.g { color: var(--ok); font-weight: 700; } .t-cmp td.r { color: var(--bad); }
  .t-cmp-h { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; }
  .t-cmp-h small { display: block; color: var(--muted); font-weight: 400; }
  .t-spark { display: block; }
  .t-tabs { margin: 4px 0; }
  .t-tabs small { color: var(--muted); font-size: .72rem; }
  .t-tools-bar { justify-content: space-between; }
  .t-cats { display: flex; flex-wrap: wrap; gap: 8px; }
  .t-cats button { font: inherit; font-size: .9rem; border: 1px solid var(--line); background: var(--panel); color: var(--fg); border-radius: 999px; padding: 7px 16px; cursor: pointer; }
  .t-cats button[aria-pressed=true] { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--panel)); box-shadow: 0 0 0 1px var(--accent); }
  .t-h { font-size: 1.1rem !important; margin: 18px 0 10px !important; }
  .t-tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); gap: 12px; }
  .t-tools.list { grid-template-columns: 1fr; gap: 6px; }
  .t-tools.mini { grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr)); gap: 8px; margin-bottom: 10px; }
  .t-tool { position: relative; display: flex; gap: 14px; align-items: center; padding: 16px; border-radius: 14px; cursor: pointer; background: color-mix(in srgb, var(--tc, var(--accent)) 7%, var(--panel)); border: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 14%, var(--line)); transition: transform .08s, box-shadow .12s; }
  .t-tool:hover { box-shadow: 0 4px 14px rgba(0,0,0,.08); transform: translateY(-1px); }
  .t-tools.list .t-tool { padding: 10px 14px; border-radius: 10px; }
  .t-tools.mini .t-tool { padding: 10px 12px; border-radius: 10px; }
  .t-ico { flex: none; width: 52px; height: 52px; border-radius: 12px; display: grid; place-items: center; }
  .t-ico svg { width: 26px; height: 26px; }
  .t-tools.list .t-ico, .t-tools.mini .t-ico { width: 36px; height: 36px; border-radius: 9px; }
  .t-tools.list .t-ico svg, .t-tools.mini .t-ico svg { width: 20px; height: 20px; }
  .t-tool-tx { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-right: 22px; }
  .t-tool-tx b { font-size: 1.02rem; }
  .t-tool-tx span { color: var(--muted); font-size: .88rem; line-height: 1.35; }
  .t-tools.mini .t-tool-tx b { font-size: .9rem; }
  .t-tool > .t-star { position: absolute; top: 8px; right: 8px; }
  .d-list { display: flex; flex-direction: column; }
  .d-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 6rem 7rem auto; gap: 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--grid); cursor: pointer; }
  .d-row:hover { background: var(--item); }
  .d-main { display: flex; flex-direction: column; min-width: 0; }
  .d-main b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .d-num { display: flex; flex-direction: column; text-align: right; }
  .d-num.g b { color: var(--ok); } .d-num.r b { color: var(--bad); }
  .d-trend-l { margin: 0; padding-left: 20px; }
  .d-trend-l li { padding: 4px 0; display: list-item; }
  .d-trend-l li > * { vertical-align: middle; margin-right: 6px; }
  .note.r { color: var(--bad); }
  .muted { color: var(--muted); }
  @media (max-width: 640px) { .d-row { grid-template-columns: auto minmax(0, 1fr) 4.5rem auto; } .d-row > .d-num:nth-of-type(2) { display: none; } }
`));
