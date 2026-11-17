/*
 * Matchup Lab - Edit mode
 * =======================
 * Lets the site owner restyle and reorganize the site without touching code.
 * Every change is stored in site-config.json (repo root). The data pipelines never touch that file,
 * so the look/layout and the daily data updates stay independent.
 *
 * Open it with the "Edit site" link in the footer. Changes are kept as a draft in this browser
 * until you press "Publish to GitHub" (or download the file and upload it to the repo yourself).
 *
 * site-config.json shape:
 *   look      colors, fonts, sizes            { accent, bg, panel, fg, muted, line, ok, bad, font, headFont, size, radius, pad, width }
 *   siteName  the big title                   "Matchup Lab"
 *   hidden    boxes you've hidden             ["game/gp-sim", ...]
 *   order     box order inside each area      { "<area>": ["<box>", ...] }
 *   text      renamed words                   [{ "from": "This season's game log", "to": "Game log" }]
 *   cols      hidden table columns            { "<table>": ["Long rush", ...] }
 *   buttons   hidden tabs / menu buttons      ["gp-tabs|Usage share", "side-nav|Trends", ...]
 *   nav       side menu order                 ["home", "tools", ...]
 *   styles    one piece's own look            [{ sp, area, base, label, css: { bg, fg, inner, border, bw, radius, zoom, weight, italic, caps, align, pad, mt, width, opacity, hide } }]
 *   moves     order of pieces inside a part   [{ sp, area, base, label, flex, order: ["<child selector>", ...] }]
 *             (sp = only for that sport, area = only on that page, base = which pieces; "Select & style" writes these)
 */
(() => {
  'use strict';
  const LS_DRAFT = 'ml-site-draft', LS_TOKEN = 'ml-gh-token', LS_REPO = 'ml-gh-repo';
  const DEFAULT_REPO = 'bwik4/Matchup-Lab';
  const BLANK = () => ({ look: {}, siteName: '', hidden: [], order: {}, text: [], cols: {}, buttons: [], nav: [], styles: [], moves: [] });
  // [key, label, CSS variable, group]
  const LOOK_FIELDS = [
    ['bg', 'Page background', '--bg', 'Backgrounds'], ['panel', 'Boxes', '--panel', 'Backgrounds'], ['game', 'Game cards', '--game', 'Backgrounds'],
    ['tile', 'Odds buttons & small tiles', '--tile', 'Backgrounds'], ['item', 'Selected tabs & hovered rows', '--item', 'Backgrounds'], ['field', 'Inputs & dropdowns', '--field', 'Backgrounds'],
    ['thead', 'Table header row', '--thead', 'Backgrounds'], ['stripe', 'Table stripes (every other row)', '--stripe', 'Backgrounds'],
    ['fg', 'Main text', '--fg', 'Text & lines'], ['muted', 'Secondary text', '--muted', 'Text & lines'], ['line', 'Borders', '--line', 'Text & lines'], ['accent', 'Accent (buttons, highlights)', '--accent', 'Text & lines'],
    ['ok', 'Good / over (green)', '--ok', 'Results'], ['bad', 'Bad / under (red)', '--bad', 'Results'],
    ['side', 'Side menu background', '--side-bg', 'Side menu'], ['sideFg', 'Side menu text & icons', '--side-fg', 'Side menu'], ['sideActive', 'Current page tile', '--side-active', 'Side menu'],
  ];
  const FONTS = {
    system: ['System', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
    helvetica: ['Clean (Helvetica / Arial)', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
    inter: ['Inter (default)', '"Inter", system-ui, sans-serif', 'Inter:wght@400;500;600;700'],
    poppins: ['Poppins (FantasyPros-style)', '"Poppins", system-ui, sans-serif', 'Poppins:wght@400;500;600;700'],
    barlow: ['Barlow (sporty)', '"Barlow", system-ui, sans-serif', 'Barlow:wght@400;500;600;700'],
    condensed: ['Roboto Condensed', '"Roboto Condensed", "Arial Narrow", sans-serif', 'Roboto+Condensed:wght@400;600;700'],
    oswald: ['Oswald (bold, sports headline)', '"Oswald", "Arial Narrow", sans-serif', 'Oswald:wght@400;500;600'],
    montserrat: ['Montserrat', '"Montserrat", system-ui, sans-serif', 'Montserrat:wght@400;500;600;700'],
    georgia: ['Georgia (serif)', 'Georgia, "Times New Roman", serif'],
    mono: ['Monospace', 'ui-monospace, Menlo, Consolas, monospace'],
  };
  const DEF_HEAD = 'inter';

  // ---------------- state ----------------
  let published = BLANK();   // what's in site-config.json on the site
  let cfg = BLANK();         // what's showing now (published, or your draft)
  let editing = false, textMode = false, pickMode = false, dirty = false;
  const base = {};           // the site's own CSS values, for reset buttons
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const norm = (c) => ({ ...BLANK(), ...(c || {}), look: { ...((c && c.look) || {}) } });
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((k) => { if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); });
    return e;
  };

  // ---------------- give every box a stable name ----------------
  const areaKey = (sec) => sec.dataset.view || sec.dataset.page || 'main';
  function tagBoxes() {
    const used = new Set();
    document.querySelectorAll('main section[data-view], main section[data-page]').forEach((sec) => {
      const area = areaKey(sec);
      sec.dataset.ea = area;
      [...sec.querySelectorAll('.card')].filter((c) => c.closest('section[data-view], section[data-page]') === sec).forEach((card, i) => {
        const hd = card.querySelector('h2');
        const nameCls = hd && [...hd.classList].find((c) => c !== 'note');
        let k = `${area}/${nameCls || slug(hd && hd.textContent) || `box-${i + 1}`}`;
        while (used.has(k)) k += '-2';
        used.add(k);
        card.dataset.ek = k;
        card.dataset.elabel = (hd && hd.textContent.trim()) || `Box ${i + 1}`;
      });
      // a grid of boxes moves as one block inside its area; the boxes inside it move within the grid
      [...sec.querySelectorAll('.grid, .joined')].filter((g) => g.closest('section[data-view], section[data-page]') === sec && g.querySelector('.card[data-ek]')).forEach((g) => {
        const first = g.querySelector(':scope > .card') || g.querySelector('.card[data-ek]');
        g.dataset.ek = `${first.dataset.ek}+${g.classList.contains('joined') ? 'group' : 'grid'}`;
        g.dataset.ea = `${area}:${first.dataset.ek}`;
        g.dataset.elabel = [...g.querySelectorAll('.card[data-ek]')].map((c) => c.dataset.elabel).join(' + ');
      });
      // boxes can also sit inside a tab's panel (e.g. a game's Matchup tab): that panel is their area
      sec.querySelectorAll('[data-ek]').forEach((b) => {
        const par = b.parentElement;
        if (par && !par.dataset.ea) par.dataset.ea = `${area}:${par.dataset.gp || par.dataset.xg || par.dataset.page || [...par.classList].join('.') || 'part'}`;
      });
    });
  }
  const blocksOf = (parent) => [...parent.children].filter((c) => c.dataset.ek);

  // ---------------- applying a config ----------------
  function fontLink(key) {
    const f = FONTS[key];
    if (!f || !f[2] || document.querySelector(`link[data-ef="${key}"]`)) return;
    document.head.append(el('link', { rel: 'stylesheet', 'data-ef': key, href: `https://fonts.googleapis.com/css2?family=${f[2]}&display=swap` }));
  }
  function applyLook() {
    const r = document.documentElement.style, L = cfg.look;
    LOOK_FIELDS.forEach(([k, , v]) => { if (L[k]) r.setProperty(v, L[k]); else r.removeProperty(v); });
    if (L.accent) r.setProperty('--c1', L.accent); else r.removeProperty('--c1');
    if (L.font && FONTS[L.font]) { fontLink(L.font); r.setProperty('--font', FONTS[L.font][1]); } else r.removeProperty('--font');
    if (L.headFont && FONTS[L.headFont]) { fontLink(L.headFont); r.setProperty('--serif', FONTS[L.headFont][1]); } else r.removeProperty('--serif');
    if (L.size) r.fontSize = `${L.size}%`; else r.fontSize = '';
    if (L.radius != null && L.radius !== '') r.setProperty('--radius', `${L.radius}px`); else r.removeProperty('--radius');
    if (L.pad != null && L.pad !== '') r.setProperty('--card-pad', `${L.pad}px`); else r.removeProperty('--card-pad');
    if (L.width) r.setProperty('--page-w', `${L.width}px`); else r.removeProperty('--page-w');
    if (L.sideStroke) r.setProperty('--side-stroke', String(L.sideStroke)); else r.removeProperty('--side-stroke');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = L.bg || base.bg || meta.content;
    const h1 = document.querySelector('header h1');
    if (h1) h1.textContent = cfg.siteName || base.siteName;
    document.title = cfg.siteName || base.siteName;
  }
  const BTN_BOX = '.subnav, .tabs, .side-nav, .sport-sw, .seg';
  const btnBoxKey = (box) => [...box.classList].find((c) => !['subnav', 'tabs', 'seg'].includes(c)) || [...box.classList][0] || 'menu';
  const btnKey = (btn) => { const box = btn.closest(BTN_BOX); return box ? `${btnBoxKey(box)}|${longestText(btn) || ''}` : null; };
  const navButtons = () => [...document.querySelectorAll('.side-nav > button')];
  function moveNav(view, dir) {
    const order = navButtons().map((b) => b.dataset.view), i = order.indexOf(view), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    cfg.nav = order; changed();
  }
  function applyNav() {
    const nav = document.querySelector('.side-nav'), want = cfg.nav || [];
    if (!nav || !want.length) return;
    const bs = navButtons(), pos = (b) => { const i = want.indexOf(b.dataset.view); return i < 0 ? 100 + bs.indexOf(b) : i; };
    const sorted = bs.slice().sort((a, b) => pos(a) - pos(b));
    if (sorted.every((b, i) => b === bs[i])) return;
    sorted.forEach((b) => nav.append(b));
  }
  function applyLayout() {
    applyNav();
    document.querySelectorAll('[data-ek]').forEach((b) => b.classList.toggle('ed-hide', cfg.hidden.includes(b.dataset.ek)));
    const hb = new Set(cfg.buttons || []);
    document.querySelectorAll(`:is(${BTN_BOX}) > button, .side-nav button`).forEach((btn) => {
      const k = btnKey(btn);
      const on = !!k && hb.has(k);
      if (on !== btn.classList.contains('ed-hide')) btn.classList.toggle('ed-hide', on);
    });
    document.querySelectorAll('[data-ea]').forEach((parent) => {
      const want = cfg.order[parent.dataset.ea];
      if (!want || !want.length) return;
      const blocks = blocksOf(parent);
      if (blocks.length < 2) return;
      const pos = (b) => { const i = want.indexOf(b.dataset.ek); return i < 0 ? 1e3 + blocks.indexOf(b) : i; };
      const sorted = blocks.slice().sort((a, b) => pos(a) - pos(b));
      if (sorted.every((b, i) => b === blocks[i])) return;
      const mark = document.createComment('order');
      parent.insertBefore(mark, blocks[0]);
      sorted.forEach((b) => parent.insertBefore(b, mark));
      mark.remove();
    });
  }
  const tableKey = (t) => {
    const c = [...t.classList].find((x) => x.startsWith('t-') || /^[a-z]/.test(x) && x !== 'dvp');
    if (c) return c;
    const card = t.closest('[data-ek]');
    return card ? `${card.dataset.ek}#${[...card.querySelectorAll('table')].indexOf(t)}` : null;
  };
  const thLabel = (th) => th.textContent.replace(/[↑↓▲▼]/g, '').trim();
  function applyCols() {
    const any = Object.values(cfg.cols).some((a) => a && a.length);
    document.querySelectorAll('main table').forEach((t) => {
      const k = tableKey(t), hide = (k && cfg.cols[k]) || [];
      const head = t.tHead && t.tHead.rows[0];
      if (!head) return;
      const idx = new Set([...head.cells].map((th, i) => (hide.includes(thLabel(th)) ? i : -1)).filter((i) => i >= 0));
      if (!any && !t.querySelector('.ed-col-off')) return;
      [...t.rows].forEach((row) => {
        if (row.cells.length < head.cells.length) return; // expanded box-score rows etc.
        [...row.cells].forEach((c, i) => c.classList.toggle('ed-col-off', idx.has(i)));
      });
    });
  }
  // ---------------- renames that work for every version (all players, teams, numbers...) ----------------
  // When you rename text that has a player, team, position, number or date in it, the rename is saved as a pattern:
  // "Aaron Rodgers' game log" -> "Rodgers log" also turns "Josh Allen's game log" into "Allen log".
  // A rule like that is stored as { from, to, tf, tt }: tf = the original text's "shape" (each changing part replaced by a
  // marker), tt = the new text as pieces, where a number n means "put the n-th changing part here".
  const VK = { p: 'player', t: 'team', s: 'position', n: 'number', d: 'date' };
  const MK = { p: '', t: '', s: '', n: '', d: '' };
  const KM = Object.fromEntries(Object.entries(MK).map(([k, v]) => [v, k]));
  const isMk = (c) => !!KM[c];
  const WCH = /[A-Za-z0-9]/;
  const isW = (c) => !!c && WCH.test(c);
  const NUM = /\d+(?:\.\d+)?(?:st|nd|rd|th)?/y;
  const POSW = /(?:QB|RB|WR|TE|FB)s?/y;
  const DATEW = /(?:January|February|March|April|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec|Mon|Tues|Tue|Wed|Thurs|Thu|Fri|Sat|Sun)\.?/y;
  const firstWord = (s) => { const m = /^[A-Za-z0-9][A-Za-z0-9.'’&-]*/.exec(s); return m ? m[0].replace(/[.'’&-]+$/, '') : ''; };
  let ENT = null, entSig = '';
  function siteSig() {
    try {
      const n = (x) => (x && x.length) || 0;
      return [typeof DATA !== 'undefined' ? n(DATA.players) + n(DATA.logs) : 0,
        ...[typeof NBA !== 'undefined' && NBA, typeof CFB !== 'undefined' && CFB, typeof CBB !== 'undefined' && CBB].map((X) => (X ? n(X.logs) + n(X.teams) : 0))].join('|');
    } catch (e) { return ''; }
  }
  function entities() {
    const sig = siteSig();
    if (ENT && sig === entSig) return ENT;
    entSig = sig;
    const by = new Map(), seen = new Set();
    const add = (name, k) => {
      name = String(name || '').trim();
      if (name.length < 2 || seen.has(name) || /^\d+$/.test(name)) return;
      seen.add(name);
      const fw = firstWord(name); if (!fw) return;
      if (!by.has(fw)) by.set(fw, []);
      by.get(fw).push({ name, k });
    };
    const team = (t) => { add(t.team, 't'); add(t.name, 't'); add(t.nick, 't'); };
    const player = (nm) => {
      add(nm, 'p');
      const w = String(nm || '').trim().split(/\s+/);
      if (w.length > 1 && /^[A-Z]/.test(w[0])) add(`${w[0][0]}. ${w.slice(1).join(' ')}`, 'p');
    };
    try {
      (DATA.team_info || []).forEach(team);
      (DATA.players || []).forEach((r) => player(r.player));
      (DATA.logs || []).forEach((r) => player(r.player));
    } catch (e) { /* site data not loaded yet */ }
    try {
      [typeof NBA !== 'undefined' && NBA, typeof CFB !== 'undefined' && CFB, typeof CBB !== 'undefined' && CBB].forEach((X) => {
        if (!X) return;
        (X.teams || []).forEach(team);
        (X.logs || []).forEach((r) => player(r.player));
      });
    } catch (e) { /* not loaded */ }
    by.forEach((a) => a.sort((x, y) => y.name.length - x.name.length));
    ENT = by;
    tokCache.clear();
    return ENT;
  }
  // split text into plain pieces and changing pieces: [{ t: 'Aaron Rodgers', k: 'p' }, { t: "'s game log" }]
  const tokCache = new Map();
  function tokenize(s) {
    if (tokCache.has(s)) return tokCache.get(s);
    const E = entities(), segs = [];
    let lit = '', i = 0;
    const push = (t, k) => { if (lit) { segs.push({ t: lit }); lit = ''; } segs.push({ t, k }); };
    const sticky = (re) => { re.lastIndex = i; const m = re.exec(s); return m && !isW(s[i + m[0].length]) ? m[0] : null; };
    while (i < s.length) {
      const c = s[i];
      if (!isW(c) || isW(s[i - 1])) { lit += c; i++; continue; }
      let hit = null;
      const cands = E.get(firstWord(s.slice(i, i + 60)));
      if (cands) hit = cands.find((x) => s.startsWith(x.name, i) && !isW(s[i + x.name.length]));
      if (hit) { push(hit.name, hit.k); i += hit.name.length; continue; }
      let m;
      if ((m = sticky(NUM))) { push(m, 'n'); i += m.length; continue; }
      if ((m = sticky(POSW))) { push(m, 's'); i += m.length; continue; }
      if ((m = sticky(DATEW))) { push(m, 'd'); i += m.length; continue; }
      const w = /^[A-Za-z0-9]+/.exec(s.slice(i))[0]; // an ordinary word
      lit += w; i += w.length;
    }
    if (lit) segs.push({ t: lit });
    if (tokCache.size > 4000) tokCache.clear();
    tokCache.set(s, segs);
    return segs;
  }
  // shape of a text: plain text with markers where the changing parts were, plus where each piece sits in the original
  function shapeOf(s) {
    const segs = tokenize(s);
    let shape = '', pos = 0;
    const map = []; // map[i] = [start, end] in the original string for shape char i
    segs.forEach((g) => {
      if (g.k) { shape += MK[g.k]; map.push([pos, pos + g.t.length, g.t]); } else { for (let j = 0; j < g.t.length; j++) map.push([pos + j, pos + j + 1]); shape += g.t; }
      pos += g.t.length;
    });
    return { shape, map };
  }
  // build a pattern rule from the original text, the new text, and which changing parts the user wants kept fixed
  function buildTemplate(from, to, fixed) {
    const segs = tokenize(from), vars = [];
    segs.forEach((g, i) => { if (g.k) vars.push({ i, t: g.t, k: g.k }); });
    if (!vars.length) return null;
    // numbers that vanish from the new text were probably reworded on purpose ("last 5" -> "last five"): keep them fixed
    const used = []; // [start, end, varIndex] places in `to` where an original value was kept
    const live = [];
    vars.forEach((v, j) => {
      if (fixed && fixed.includes(j)) return;
      let at = -1, from0 = 0;
      while ((at = to.indexOf(v.t, from0)) >= 0) {
        const end = at + v.t.length;
        if (!isW(to[at - 1]) && !isW(to[end]) && !used.some(([a, b]) => at < b && end > a)) break;
        from0 = at + 1;
      }
      if (at < 0 && v.k === 'n') return; // number dropped -> fixed
      live.push(j);
      if (at >= 0) used.push([at, at + v.t.length, j]);
    });
    if (!live.length) return null;
    let tf = '';
    segs.forEach((g, i) => { const j = vars.findIndex((v) => v.i === i); tf += j >= 0 && live.includes(j) ? MK[g.k] : g.t; });
    used.sort((a, b) => a[0] - b[0]);
    const tt = []; let c = 0;
    used.forEach(([a, b, j]) => { if (a > c) tt.push(to.slice(c, a)); tt.push(live.indexOf(j)); c = b; });
    if (c < to.length) tt.push(to.slice(c));
    return { tf, tt, vars: vars.map((v, j) => ({ t: v.t, k: v.k, on: live.includes(j) })) };
  }
  const markers = (tf) => (tf.match(/[\uE001-\uE005]/g) || []).length;
  // safe to use everywhere: has some real wording, or several changing parts together ("Name · QB · PIT"), not a bare name
  const tplOk = (t) => !!t && (keyOfTf(t.tf).length >= 3 || markers(t.tf) >= 2);
  const keyOfTf = (tf) => tf.split(/[-]/).reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), '');
  // apply pattern rules to one string; returns the new string (or the same one)
  function applyTemplates(v, rules) {
    let shp = null;
    rules.forEach((r) => {
      if (r._key === undefined) r._key = keyOfTf(r.tf);
      if (r._key && !v.includes(r._key)) return;
      if (!shp) shp = shapeOf(v);
      const { shape, map } = shp;
      const hits = [];
      let at = shape.indexOf(r.tf);
      while (at >= 0) { hits.push(at); at = shape.indexOf(r.tf, at + r.tf.length); }
      if (!hits.length) return;
      let out = v;
      hits.reverse().forEach((p) => {
        const vals = [];
        for (let i = p; i < p + r.tf.length; i++) if (isMk(shape[i])) vals.push(map[i][2]);
        const a = map[p][0], b = map[p + r.tf.length - 1][1];
        const rep = r.tt.map((x) => (typeof x === 'number' ? vals[x] ?? '' : x)).join('');
        if (out.startsWith(rep, a)) return; // already says the new wording
        out = out.slice(0, a) + rep + out.slice(b);
      });
      if (out !== v) { v = out; shp = null; }
    });
    return v;
  }

  // text node -> { out: what we set, orig: the site's own text, ver } so renames can be redone from the original
  const done = new WeakMap();
  let textVer = 0;
  function applyText() {
    const plain = cfg.text.filter((r) => !r.tf), tpls = cfg.text.filter((r) => r.tf);
    const roots = [document.querySelector('main'), document.querySelector('aside')].filter(Boolean);
    roots.forEach((root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && n.parentElement.closest('td, script, style, .ed-ui, input, textarea, select') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let n;
      while ((n = w.nextNode())) {
        const v0 = n.nodeValue;
        if (!v0 || !v0.trim()) continue;
        const prev = done.get(n);
        if (prev && prev.out === v0 && prev.ver === textVer) continue;
        const base = prev && prev.out === v0 ? prev.orig : v0; // re-apply from the site's own wording
        if (!prev && !cfg.text.length) continue;
        let v = base;
        plain.forEach(({ from, to }) => { if (from && v.includes(from) && !(to && to.includes(from) && v.includes(to))) v = v.split(from).join(to); });
        if (tpls.length) v = applyTemplates(v, tpls);
        done.set(n, { out: v, orig: base, ver: textVer });
        if (v !== v0) n.nodeValue = v;
      }
    });
  }
  let applying = false;
  function applyAll() {
    applying = true;
    textVer++;
    try { syncSport(); applyLook(); applyCustomCSS(); applyLayout(); applyText(); applyCols(); if (editing) decorate(); } finally { applying = false; }
  }
  // the site re-draws parts of the page all the time; re-apply column/text/layout rules after it does
  let queued = false;
  new MutationObserver(() => {
    if (applying || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; applying = true; try { syncSport(); applyLayout(); applyText(); applyCols(); if (editing) { decorate(); repick(); } } finally { applying = false; } });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------------- edit-mode decorations on the page ----------------
  function decorate() {
    document.querySelectorAll('.card[data-ek], .grid[data-ek], .joined[data-ek]').forEach((b) => {
      if (b.querySelector(':scope > .ed-tools')) { b.querySelector(':scope > .ed-tools .ed-hidebtn').textContent = cfg.hidden.includes(b.dataset.ek) ? 'Show' : 'Hide'; return; }
      const isGrid = b.classList.contains('grid') || b.classList.contains('joined');
      const tools = el('ed-tools', { class: `ed-ui ed-tools${isGrid ? ' ed-tools-grid' : ''}` },
        el('span', { class: 'ed-name' }, b.classList.contains('joined') ? 'Group' : isGrid ? 'Row' : 'Box'),
        el('button', { type: 'button', title: 'Move up', onclick: (e) => { e.stopPropagation(); move(b, -1); } }, '↑'),
        el('button', { type: 'button', title: 'Move down', onclick: (e) => { e.stopPropagation(); move(b, 1); } }, '↓'),
        el('button', { type: 'button', class: 'ed-hidebtn', onclick: (e) => { e.stopPropagation(); toggleHide(b.dataset.ek); } }, cfg.hidden.includes(b.dataset.ek) ? 'Show' : 'Hide'));
      b.prepend(tools);
    });
  }
  function undecorate() { document.querySelectorAll('.ed-tools').forEach((t) => t.remove()); closePop(); unpick(); }
  function move(block, dir) {
    const parent = block.parentElement, blocks = blocksOf(parent), i = blocks.indexOf(block), j = i + dir;
    if (j < 0 || j >= blocks.length) { flash(dir < 0 ? 'Already at the top of this area' : 'Already at the bottom of this area'); return; }
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    cfg.order[parent.dataset.ea] = blocks.map((b) => b.dataset.ek);
    changed();
    block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function toggleHide(k) {
    cfg.hidden = cfg.hidden.includes(k) ? cfg.hidden.filter((x) => x !== k) : [...cfg.hidden, k];
    changed();
  }

  // ---------------- click-to-rename popover ----------------
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function longestText(elm) {
    let best = null;
    const w = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) { if (n.parentElement.closest('.ed-ui')) continue; const t = n.nodeValue.trim(); if (t && (!best || t.length > best.length)) best = t; }
    return best;
  }
  const PICK = 'h1, h2, h3, h4, th, button, label, summary, .note, .lbl, .sub, small, p, li, .side-nav span, .k, legend';
  document.addEventListener('click', (e) => {
    if (!editing || !textMode) return;
    if (e.target.closest('.ed-ui')) return;
    const t = e.target.closest(PICK);
    if (!t || !t.closest('main, aside')) return;
    e.preventDefault(); e.stopPropagation();
    openPop(t, e.clientX, e.clientY);
  }, true);
  function longestNode(elm) {
    let best = null;
    const w = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) { if (n.parentElement.closest('.ed-ui')) continue; const t = n.nodeValue.trim(); if (t && (!best || t.length > best.nodeValue.trim().length)) best = n; }
    return best;
  }
  function countOnScreen(tf) {
    let c = 0;
    const root = document.querySelector('main'); if (!root) return 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest('td, script, style, .ed-ui, [hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const key = keyOfTf(tf); let n;
    while ((n = w.nextNode()) && c < 999) {
      const info = done.get(n), v = info && info.out === n.nodeValue ? info.orig : n.nodeValue;
      if (v && (!key || v.includes(key)) && shapeOf(v).shape.includes(tf)) c++;
    }
    return c;
  }
  function openPop(target, x, y) {
    closePop();
    const node = longestNode(target);
    const isTh = target.tagName === 'TH' && target.closest('table');
    if (!node && !isTh) return;
    const shown = node ? node.nodeValue.trim() : '';
    const info = node && done.get(node);
    const site = info && info.out === node.nodeValue ? info.orig.trim() : shown; // the site's own wording, before any rename
    // the saved rename that produced what's on screen, if any (edit it instead of stacking a new one)
    const prior = cfg.text.find((r) => !r.tf && (r.from === site || r.to === shown))
      || cfg.text.find((r) => r.tf && site && applyTemplates(site, [r]) !== site) || null;
    const orig = prior && !prior.tf && prior.to === shown && prior.from !== site ? prior.from : site;
    const input = el('input', { type: 'text', value: shown || '', 'aria-label': 'New text' });
    let fixed = prior && prior.tf && prior.fixed ? prior.fixed.slice() : [];
    let every = null; // null = use the default
    const scopeBox = el('div', { class: 'ed-tplbox' });
    const drawScope = () => {
      scopeBox.replaceChildren();
      const v = input.value.trim();
      const all = orig ? buildTemplate(orig, v || orig, []) : null;
      if (!all) return;
      const t = buildTemplate(orig, v || orig, fixed);
      const keyOk = tplOk(t);
      const on = every === null ? keyOk : every && !!t;
      const n = on && t ? countOnScreen(t.tf) : 0;
      scopeBox.append(...[
        el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: on, disabled: !tplOk(all), onchange: (e) => { every = e.target.checked; drawScope(); } }),
          el('span', null, 'Change every version of this (other players, teams, numbers)')),
        !keyOk ? el('small', { class: 'ed-dim' }, !t && tplOk(all) ? 'Every changing part is set to "only this one", so this changes just this exact text.' : 'This is only a name or number by itself, so it changes just this spot.') : null,
        on || (tplOk(all) && every !== false) ? el('div', { class: 'ed-chips' }, ...all.vars.map((x, j) => {
          const live = t && t.vars[j] && t.vars[j].on;
          const dropped = !live && !fixed.includes(j) && x.k === 'n';
          return el('button', { type: 'button', class: `ed-chip${live ? ' on' : ''}`, title: live ? 'Click to keep this exact one' : 'Click to let this change',
            onclick: () => { fixed = fixed.includes(j) ? fixed.filter((i) => i !== j) : [...fixed, j]; drawScope(); } },
          el('b', null, x.t), live ? ` → any ${VK[x.k]}` : dropped ? ' (you reworded it, so it stays)' : ' (only this one)');
        })) : null,
        on && t ? el('small', { class: 'ed-dim' }, n > 1 ? `Changes ${n} spots on this screen, and the same kind of text on every other player/team page.` : 'Also changes the same kind of text on every other player/team page.') : null].filter(Boolean));
    };
    const save = () => {
      const v = input.value.trim();
      cfg.text = cfg.text.filter((r) => r !== prior && !(!r.tf && r.from === orig));
      if (v && v !== orig) {
        const t = buildTemplate(orig, v, fixed);
        const on = every === null ? tplOk(t) : every && !!t;
        cfg.text.push(on ? { from: orig, to: v, tf: t.tf, tt: t.tt, fixed: fixed.slice() } : { from: orig, to: v });
      }
      closePop(); changed();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') closePop(); });
    input.addEventListener('input', () => drawScope());
    drawScope();
    const kids = [el('div', { class: 'ed-pop-h' }, 'Rename'), input, scopeBox,
      el('div', { class: 'ed-row' }, el('button', { type: 'button', class: 'ed-primary', onclick: save }, 'Save'), el('button', { type: 'button', onclick: closePop }, 'Cancel'),
        prior ? el('button', { type: 'button', onclick: () => { cfg.text = cfg.text.filter((r) => r !== prior); closePop(); changed(); } }, 'Undo rename') : null)];
    if (isTh) {
      const tk = tableKey(target.closest('table')), lab = thLabel(target);
      kids.push(el('div', { class: 'ed-sep' }), el('button', { type: 'button', onclick: () => { cfg.cols[tk] = [...new Set([...(cfg.cols[tk] || []), lab])]; closePop(); changed(); } }, `Hide the "${lab}" column`));
    }
    const btn = target.closest('button');
    if (btn && btn.closest(BTN_BOX)) {
      const k = btnKey(btn);
      if (k) kids.push(el('div', { class: 'ed-sep' }), el('button', { type: 'button', onclick: () => { cfg.buttons = [...new Set([...(cfg.buttons || []), k])]; closePop(); changed(); } }, 'Hide this tab / button'));
    }
    const box = target.closest('[data-ek]');
    if (box) kids.push(el('div', { class: 'ed-sep' }), el('small', { class: 'ed-dim' }, `In: ${box.dataset.elabel}`));
    pop = el('div', { class: 'ed-ui ed-pop' }, ...kids);
    document.body.append(pop);
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(x - 20, innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y + 14, innerHeight - hgt - 8))}px`;
    input.focus(); input.select();
  }

  // ---------------- "Select & style": click any piece, then style / move / delete just that kind of piece ----------------
  // A piece is remembered by a selector built from the site's own class names (e.g. "div.gcard > div.gfoot"), so the change
  // keeps working when the data updates and lands on every piece like it (every game's time bar), optionally only on one page
  // and/or one sport.
  const SPORTS = { nfl: 'NFL', nba: 'NBA', cfb: 'college football', cbb: 'college basketball' };
  const SKIP_CLS = /^(ed-|click$|static$|active$|current$|on$|off$|sel$|selected$|win$|loss$|open$|show$|hidden$|is-|has-)/;
  const ANCHOR = 'section[data-view], section[data-page], main > header, aside.side, main > footer';
  const scope = { page: false, sport: false, which: 'all' };
  let picked = null, pickedSel = null, hoverEl = null;
  function syncSport() {
    let sp = null;
    try { sp = typeof S !== 'undefined' && S && S.sport; } catch (e) { sp = null; } // S is the site's own state
    if (sp && document.documentElement.dataset.sport !== sp) document.documentElement.dataset.sport = sp;
  }
  const curSport = () => document.documentElement.dataset.sport || '';
  const q = (s) => JSON.stringify(String(s));
  function anchorSel(a) {
    if (!a) return '';
    if (a.dataset.view) return `section[data-view=${q(a.dataset.view)}]`;
    if (a.dataset.page) return `section[data-page=${q(a.dataset.page)}]`;
    if (a.matches('aside.side')) return 'aside.side';
    return a.matches('footer') ? 'main > footer' : 'main > header';
  }
  function tokOf(e) {
    if (e.dataset && e.dataset.ek) return { t: `[data-ek=${q(e.dataset.ek)}]`, stop: true };
    if (e.id && !/\d{3,}/.test(e.id)) return { t: `#${CSS.escape(e.id)}`, stop: true };
    const tag = e.tagName.toLowerCase();
    const cls = [...e.classList].filter((c) => !SKIP_CLS.test(c));
    if (cls.length) return { t: tag + cls.map((c) => `.${CSS.escape(c)}`).join(''), classed: true };
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [e];
    return { t: same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag };
  }
  // -> { base, area } : base = the piece's own selector, area = its page's selector ('' if none)
  function selFor(e) {
    const anchor = e.closest(ANCHOR);
    if (anchor === e) return { base: anchorSel(e), area: '' };
    const parts = []; let cur = e, classed = 0, top = null;
    while (cur && cur !== anchor && cur !== document.body && parts.length < 6) {
      const k = tokOf(cur);
      parts.unshift(k.t); top = k;
      if (k.stop) break;
      if (k.classed) classed++;
      if (k.classed && classed >= 2) break;
      cur = cur.parentElement;
    }
    let base = parts.join(' > ');
    const area = anchor && anchor.matches('section') ? anchorSel(anchor) : '';
    // nothing distinctive above it: tie it to its page so it doesn't hit every plain <div> on the site
    if (top && !top.classed && !top.stop && anchor) base = `${anchorSel(anchor)} > ${base}`;
    return { base, area };
  }
  // ---- narrower choices: "only the ones in this group" and "only this one" ----
  const IDATTR = ['data-tool', 'data-pid', 'data-player', 'data-team', 'data-game', 'data-id', 'data-view', 'data-s', 'data-gp', 'data-xg'];
  const idOf = (x) => { for (const a of IDATTR) if (x.hasAttribute && x.hasAttribute(a)) return `[${a}=${q(x.getAttribute(a))}]`; return ''; };
  // nearest container around the piece that is the only one of its kind on the page ("Featured" section, one box...)
  function groupOf(e) {
    const anchor = e.closest(ANCHOR), within = anchor || document;
    let a = e.parentElement;
    while (a && a !== anchor && a !== document.body && !a.matches('main')) {
      const k = tokOf(a);
      if (k.classed || k.stop) { try { if (within.querySelectorAll(k.t).length === 1) return a; } catch (x) { /* bad selector */ } }
      a = a.parentElement;
    }
    return null;
  }
  // a selector for just this one piece, using a label the site gives it (which tool, which player...)
  function oneSel(e, A) {
    let x = e; const path = [];
    while (x && x !== A && x !== document.body && !x.matches(ANCHOR)) {
      const id = idOf(x);
      if (id) return [A ? tokOf(A).t : '', [tokOf(x).t + id, ...path].join(' > ')].filter(Boolean).join(' ');
      path.unshift(tokOf(x).t);
      x = x.parentElement;
    }
    return null;
  }
  const groupName = (A) => { const hd = A.querySelector('h1, h2, h3, h4'); const t = hd && hd.textContent.trim(); return t ? `"${t.length > 28 ? `${t.slice(0, 26)}…` : t}"` : 'this section'; };
  function whichChoices(e) {
    const { base, area } = selFor(e), A = groupOf(e);
    const o = { all: base };
    if (A && !base.includes(tokOf(A).t)) o.group = `${tokOf(A).t} ${base}`;
    const one = oneSel(e, A); if (one) o.one = one;
    const cnt = (b) => { try { return document.querySelectorAll(compose({ base: b, area: scope.page ? area : '', sp: scope.sport ? curSport() : '' })).length; } catch (x) { return 0; } };
    const n = { all: cnt(o.all), group: o.group ? cnt(o.group) : 0, one: o.one ? cnt(o.one) : 0 };
    const list = [['all', `Every one like this (${n.all} on screen)`]];
    if (o.group && n.group && n.group < n.all) list.push(['group', `Only the ones in ${groupName(A)} (${n.group})`]);
    if (o.one && n.one === 1 && n.one < (list.length > 1 ? n.group : n.all)) list.push(['one', 'Only this one']);
    const eff = list.some(([k]) => k === scope.which) ? scope.which : 'all';
    return { o, list, eff, n };
  }
  const compose = (r, mid) => [r.sp ? `html[data-sport=${q(r.sp)}]` : '', mid || '', r.area && !r.base.startsWith(r.area) ? r.area : '', r.base].filter(Boolean).join(' ');
  const keyOf = (r) => compose(r);
  function target(e) {
    const { area } = selFor(e), w = whichChoices(e);
    return { base: w.o[w.eff], area: scope.page ? area : '', sp: scope.sport ? curSport() : '' };
  }
  function describe(e) {
    if (e.dataset.elabel) return e.dataset.elabel;
    const KIND = { button: 'Button', table: 'Table', th: 'Column header', h1: 'Title', h2: 'Title', h3: 'Title', h4: 'Heading', h5: 'Heading', p: 'Text', small: 'Small text', svg: 'Icon', select: 'Dropdown', input: 'Input', label: 'Label', img: 'Image', a: 'Link', b: 'Bold text', span: 'Text', li: 'List item', ul: 'List' };
    const t = ((e.children.length > 1 && e.innerText) || longestText(e) || '').replace(/\s+/g, ' ').trim();
    const kind = KIND[e.tagName.toLowerCase()] || (e.children.length > 1 ? 'Section' : 'Piece');
    return t ? `${kind} · "${t.length > 34 ? `${t.slice(0, 32)}…` : t}"` : kind;
  }
  function pickTarget(t) {
    if (!t || !t.closest || t.closest('.ed-ui')) return null;
    if (!t.closest('main, aside.side') || t === document.body) return null;
    const svg = t.closest('svg'); if (svg) t = svg;
    if (t.closest('td') || t.closest('tbody, tfoot')) t = t.closest('table');
    if (t.tagName === 'TR' || t.tagName === 'THEAD') t = t.closest('table');
    if (t.matches('main, main.ml')) return null;
    return t;
  }
  function setHover(t) {
    if (hoverEl === t) return;
    if (hoverEl) hoverEl.classList.remove('ed-hov');
    hoverEl = t;
    if (t) t.classList.add('ed-hov');
  }
  function unpick() {
    setHover(null);
    document.querySelectorAll('.ed-picked, .ed-match').forEach((x) => x.classList.remove('ed-picked', 'ed-match'));
    picked = null; pickedSel = null;
  }
  function highlight() {
    document.querySelectorAll('.ed-picked, .ed-match').forEach((x) => x.classList.remove('ed-picked', 'ed-match'));
    if (!picked || !picked.isConnected) return 0;
    let all = [];
    try { all = [...document.querySelectorAll(compose(target(picked)))]; } catch (e) { all = [picked]; }
    all.forEach((x) => x.classList.add(x === picked ? 'ed-picked' : 'ed-match'));
    pickedSel = compose(target(picked));
    return all.length;
  }
  function select(t) {
    picked = t;
    // already styled under some scope? show that one
    const { o } = whichChoices(t), rules = (cfg.styles || []).concat(cfg.moves || []);
    for (const w of ['one', 'group', 'all']) {
      const prior = o[w] && rules.find((r) => r.base === o[w] && (!r.sp || r.sp === curSport()));
      if (prior) { scope.which = w; scope.page = !!prior.area; scope.sport = !!prior.sp; break; }
    }
    highlight();
    tab = 'pick'; drawPanel();
    if (panel) panel.classList.remove('ed-small');
  }
  function repick() { // the site re-drew the page: find the same kind of piece again
    if (!picked || picked.isConnected) { if (picked) highlight(); return; }
    let n = null;
    try { n = pickedSel && document.querySelector(pickedSel); } catch (e) { n = null; }
    picked = n;
    if (picked) highlight(); else if (tab === 'pick') drawPanel();
  }
  document.addEventListener('mouseover', (e) => { if (editing && pickMode) setHover(pickTarget(e.target)); }, true);
  document.addEventListener('mouseout', (e) => { if (editing && pickMode && !e.relatedTarget) setHover(null); }, true);
  ['mousedown', 'pointerdown'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (editing && pickMode && pickTarget(e.target)) { e.preventDefault(); }
  }, true));
  document.addEventListener('click', (e) => {
    if (!editing || !pickMode) return;
    const t = pickTarget(e.target);
    if (!t) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    select(t);
  }, true);

  // ---- per-piece styles ----
  function ruleFor(make) {
    const t = target(picked), k = keyOf(t);
    let r = (cfg.styles || []).find((x) => keyOf(x) === k);
    if (!r && make) { r = { ...t, label: describe(picked), css: {} }; cfg.styles = [...(cfg.styles || []), r]; }
    return r;
  }
  function setCss(prop, v, live) {
    const r = ruleFor(true);
    if (v == null || v === '' || v === false) delete r.css[prop]; else r.css[prop] = v;
    if (!Object.keys(r.css).length) cfg.styles = cfg.styles.filter((x) => x !== r);
    if (live) { dirty = true; applyCustomCSS(); } else changed();
  }
  const JUST = { left: 'flex-start', center: 'center', right: 'flex-end' };
  function cssFor(r) {
    const c = r.css || {}, d = [], S1 = compose(r);
    if (c.bg) d.push(`background:${c.bg}`);
    if (c.fg) d.push(`color:${c.fg}`);
    if (c.border) d.push(`border-color:${c.border}`);
    if (c.bw != null) d.push(`border-width:${c.bw}px`, 'border-style:solid');
    if (c.radius != null) d.push(`border-radius:${c.radius}px`);
    if (c.zoom) d.push(`zoom:${c.zoom / 100}`);
    if (c.weight) d.push(`font-weight:${c.weight}`);
    if (c.italic) d.push('font-style:italic');
    if (c.caps) d.push('text-transform:uppercase', 'letter-spacing:.03em');
    if (c.align) d.push(`text-align:${c.align}`, `justify-content:${JUST[c.align]}`);
    if (c.pad != null) d.push(`padding:${c.pad}px`);
    if (c.mt != null) d.push(`margin-top:${c.mt}px`);
    if (c.width) d.push(`width:${c.width}%`, 'box-sizing:border-box');
    if (c.opacity != null) d.push(`opacity:${c.opacity / 100}`);
    let inner = '', own = '';
    if (c.fg && c.inner !== false) inner = `${S1} :where(:not(.badge, .badge *)) { color: ${c.fg} !important; }\n`;
    if (d.length) own = `${S1} { ${d.map((x) => `${x} !important`).join('; ')}; }\n`;
    if (c.hide) own += `${compose(r, 'body:not(.ed-on)')} { display: none !important; }\n${compose(r, 'body.ed-on')} { opacity: .35 !important; outline: 2px dashed #94a3b8 !important; }\n`;
    return [inner, own];
  }
  function movesCSS(m) {
    const P = compose(m);
    let s = m.flex ? `${P} { display: flex !important; flex-direction: column !important; }\n` : '';
    m.order.forEach((tk, i) => { s += `${P} > ${tk} { order: ${i} !important; }\n`; });
    return s;
  }
  let styleTag = null;
  function applyCustomCSS() {
    if (!styleTag) { styleTag = el('style', { id: 'ed-custom' }); document.head.append(styleTag); }
    const parts = (cfg.styles || []).map(cssFor);
    // text colors that flow into a piece go first, so a smaller piece's own color still wins
    const txt = parts.map((p) => p[0]).join('') + parts.map((p) => p[1]).join('') + (cfg.moves || []).map(movesCSS).join('');
    if (styleTag.textContent !== txt) styleTag.textContent = txt;
  }

  // ---- moving a piece among its neighbours ----
  function childTok(c, par) {
    const k = tokOf(c);
    if (k.stop) return k.t;
    if (k.classed && [...par.children].filter((x) => x.matches(k.t)).length === 1) return k.t;
    const same = [...par.children].filter((x) => x.tagName === c.tagName);
    return `${c.tagName.toLowerCase()}:nth-of-type(${same.indexOf(c) + 1})`;
  }
  const realKids = (par) => [...par.children].filter((c) => !c.matches('.ed-ui, script, style, template, link'));
  function canArrange(e) {
    const par = e && e.parentElement;
    if (!par || par === document.body || par.matches('main.ml')) return 'This can\'t move. Select the bigger part around it.';
    const kids = realKids(par).filter((c) => getComputedStyle(c).display !== 'none');
    if (kids.length < 2) return 'Nothing next to it to swap with. Click "Select the part around it" and move that instead.';
    const d = getComputedStyle(par).display;
    if (/flex|grid/.test(d)) return '';
    if (!/^(block|list-item|flow-root)$/.test(d)) return 'This sits inside a table or a line of text, so it can\'t move on its own.';
    const inlineKid = kids.some((c) => /^inline/.test(getComputedStyle(c).display));
    const text = [...par.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    return inlineKid || text ? 'This sits inside a line of text, so it can\'t move on its own. Select the part around it instead.' : '';
  }
  function arrange(dir) {
    const e = picked, par = e.parentElement;
    const why = canArrange(e);
    if (why) { flash(why); return; }
    const t = target(par), k = keyOf(t);
    let m = (cfg.moves || []).find((x) => keyOf(x) === k);
    // boxes keep using the simple box order unless this area already has a custom order
    if (!m && e.dataset.ek && (dir === -1 || dir === 1)) { move(e, dir); return; }
    const kids = realKids(par);
    const ord = (c) => { const o = parseInt(getComputedStyle(c).order, 10) || 0; return o * 1e4 + kids.indexOf(c); };
    const vis = kids.slice().sort((a, b) => ord(a) - ord(b));
    const shown = vis.filter((c) => c === e || getComputedStyle(c).display !== 'none');
    let i = shown.indexOf(e), j = dir === 'first' ? 0 : dir === 'last' ? shown.length - 1 : i + dir;
    if (j < 0 || j >= shown.length || j === i) { flash(j <= 0 && dir !== 'last' ? 'Already first' : 'Already last'); return; }
    shown.splice(i, 1); shown.splice(j, 0, e);
    // put hidden kids back where they were
    const full = []; let si = 0;
    vis.forEach((c) => { full.push(c === e || getComputedStyle(c).display !== 'none' ? shown[si++] : c); });
    const toks = full.map((c) => childTok(c, par));
    if (!m) {
      m = { ...t, label: describe(par), flex: !/flex|grid/.test(getComputedStyle(par).display), order: [] };
      cfg.moves = [...(cfg.moves || []), m];
    }
    m.order = toks;
    changed();
  }

  // ---- the "Selected" tab ----
  function colorOf(e, prop) {
    let v = getComputedStyle(e)[prop];
    if (prop === 'backgroundColor') { let p = e; while (p && /rgba\(0, 0, 0, 0\)|transparent/.test(v)) { p = p.parentElement; v = p ? getComputedStyle(p).backgroundColor : '#ffffff'; } }
    return toHex(v);
  }
  function pickColor(label, prop, cssProp) {
    const r = ruleFor(false), cur = r && r.css[prop];
    return el('label', { class: 'ed-field' }, el('span', null, label),
      el('span', { class: 'ed-row' },
        el('input', { type: 'color', value: cur || colorOf(picked, cssProp), oninput: (e) => setCss(prop, e.target.value, true), onchange: (e) => setCss(prop, e.target.value) }),
        cur ? el('button', { type: 'button', class: 'ed-mini', onclick: () => setCss(prop, null) }, 'Reset') : null));
  }
  function pickSlider(label, prop, min, max, step, unit, def) {
    const r = ruleFor(false), cur = r && r.css[prop];
    const out = el('b', null, cur != null ? `${cur}${unit}` : 'original');
    return el('label', { class: 'ed-field' }, el('span', null, label, ' ', out),
      el('span', { class: 'ed-row' },
        el('input', { type: 'range', min, max, step, value: cur ?? def, oninput: (e) => { out.textContent = `${e.target.value}${unit}`; setCss(prop, Number(e.target.value), true); }, onchange: (e) => setCss(prop, Number(e.target.value)) }),
        cur != null ? el('button', { type: 'button', class: 'ed-mini', onclick: () => setCss(prop, null) }, 'Reset') : null));
  }
  function pickSelect(label, prop, opts) {
    const r = ruleFor(false), cur = (r && r.css[prop]) || '';
    return el('label', { class: 'ed-field' }, el('span', null, label),
      el('select', { onchange: (e) => setCss(prop, e.target.value || null) }, ...opts.map(([v, l]) => el('option', { value: v, selected: cur === v }, l))));
  }
  function pickCheck(label, prop, on) {
    const r = ruleFor(false), cur = r ? r.css[prop] : undefined;
    return el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: cur == null ? !!on : !!cur, onchange: (e) => setCss(prop, e.target.checked === !!on ? null : e.target.checked) }), el('span', null, label));
  }
  function pickTab() {
    const help = el('p', { class: 'ed-help' }, 'Pick "Select & style" at the top, then click anything on the page: a title, a button, the time bar under a game, a whole box. Its own colors, size, spacing, order and delete controls show up here.');
    if (!picked || !picked.isConnected) return [help, picked === null && pickedSel ? el('p', { class: 'ed-dim' }, 'The piece you picked isn\'t on this screen anymore.') : null];
    const n = highlight();
    const wc = whichChoices(picked);
    const t = target(picked), r = ruleFor(false), c = (r && r.css) || {};
    const sp = curSport(), pg = picked.closest('section[data-view], section[data-page]');
    const isBox = !!picked.dataset.ek, boxHidden = isBox && cfg.hidden.includes(picked.dataset.ek);
    const why = canArrange(picked);
    const up = picked.parentElement && !picked.parentElement.matches('main.ml, body') ? picked.parentElement : null;
    // clicked the words inside a card (one tool, one player...)? offer the whole card in one click
    let item = picked.parentElement && picked.parentElement.closest(IDATTR.map((x) => `[${x}]`).join(', '));
    if (item && (item.matches(ANCHOR) || !item.closest('main, aside.side'))) item = null;
    const sameCount = n > 1 ? `Changes ${n} pieces like it on this screen (outlined in light blue)` : 'Changes this piece';
    return [
      el('div', { class: 'ed-picked-name' }, el('b', null, describe(picked))),
      el('div', { class: 'ed-row ed-wrap' },
        item ? el('button', { type: 'button', class: 'ed-primary', onclick: () => select(item) }, `⤒ Select the whole ${item.matches('button') ? 'button' : 'card'}`) : null,
        up ? el('button', { type: 'button', onclick: () => select(pickTarget(up) || up) }, '⤒ Select the part around it') : null,
        el('button', { type: 'button', onclick: () => { unpick(); drawPanel(); } }, 'Deselect')),
      el('h4', null, 'Which ones'),
      ...wc.list.map(([k, l]) => el('label', { class: 'ed-check' }, el('input', { type: 'radio', name: 'ed-which', checked: wc.eff === k, onchange: () => { scope.which = k; drawPanel(); } }), el('span', null, l))),
      el('p', { class: 'ed-dim' }, `${sameCount}${t.sp || t.area ? '' : ', on every page and sport where it appears'}.`),
      pg ? el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: scope.page, onchange: (e) => { scope.page = e.target.checked; drawPanel(); } }), el('span', null, `Only on this page (${pg.dataset.view || pg.dataset.page})`)) : null,
      sp ? el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: scope.sport, onchange: (e) => { scope.sport = e.target.checked; drawPanel(); } }), el('span', null, `Only for ${SPORTS[sp] || sp}`)) : null,
      el('h4', null, 'Colors'),
      el('div', { class: 'ed-grid2' }, pickColor('Background', 'bg', 'backgroundColor'), pickColor('Text', 'fg', 'color'), pickColor('Border', 'border', 'borderTopColor')),
      c.fg ? pickCheck('Text color also changes the words inside it', 'inner', true) : null,
      el('h4', null, 'Size & shape'),
      pickSlider('Size (everything inside)', 'zoom', 50, 200, 5, '%', 100),
      pickSlider('Space inside', 'pad', 0, 40, 1, 'px', parseInt(getComputedStyle(picked).paddingTop, 10) || 0),
      pickSlider('Space above', 'mt', -20, 60, 1, 'px', parseInt(getComputedStyle(picked).marginTop, 10) || 0),
      pickSlider('Width', 'width', 10, 100, 5, '%', 100),
      pickSlider('Border thickness', 'bw', 0, 6, 1, 'px', parseInt(getComputedStyle(picked).borderTopWidth, 10) || 0),
      pickSlider('Corner roundness', 'radius', 0, 30, 1, 'px', parseInt(getComputedStyle(picked).borderTopLeftRadius, 10) || 0),
      pickSlider('See-through', 'opacity', 10, 100, 5, '%', 100),
      el('h4', null, 'Text'),
      el('div', { class: 'ed-grid2' },
        pickSelect('Weight', 'weight', [['', 'Original'], ['400', 'Normal'], ['600', 'Semi-bold'], ['800', 'Bold']]),
        pickSelect('Line up', 'align', [['', 'Original'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']])),
      el('div', { class: 'ed-row ed-wrap' }, pickCheck('Italic', 'italic'), pickCheck('ALL CAPS', 'caps')),
      el('h4', null, 'Move'),
      why ? el('p', { class: 'ed-dim' }, why) : el('div', { class: 'ed-row ed-wrap' },
        el('button', { type: 'button', title: 'Move to the start', onclick: () => arrange('first') }, '⇤ First'),
        el('button', { type: 'button', title: 'Move up / left', onclick: () => arrange(-1) }, '↑ Earlier'),
        el('button', { type: 'button', title: 'Move down / right', onclick: () => arrange(1) }, '↓ Later'),
        el('button', { type: 'button', title: 'Move to the end', onclick: () => arrange('last') }, 'Last ⇥')),
      el('h4', null, 'Delete'),
      el('div', { class: 'ed-row ed-wrap' },
        isBox ? el('button', { type: 'button', class: boxHidden ? '' : 'ed-danger', onclick: () => toggleHide(picked.dataset.ek) }, boxHidden ? 'Bring it back' : 'Delete this box')
          : el('button', { type: 'button', class: c.hide ? '' : 'ed-danger', onclick: () => setCss('hide', c.hide ? null : true) }, c.hide ? 'Bring it back' : (n > 1 ? `Delete all ${n}` : 'Delete it')),
        r ? el('button', { type: 'button', onclick: () => { cfg.styles = cfg.styles.filter((x) => x !== r); changed(); } }, 'Undo all changes to this') : null),
      el('p', { class: 'ed-dim' }, 'Deleted pieces stay faded while you edit so you can bring them back. Everything is also listed under Layout.'),
    ];
  }
  function findOnScreen(r) {
    let n = null;
    try { n = document.querySelector(compose(r)); } catch (e) { n = null; }
    if (!n) { flash('That piece isn\'t on this screen. Go to the page it\'s on first.'); return; }
    scope.page = !!r.area; scope.sport = !!r.sp;
    setMode('pick'); select(n);
    n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function setMode(m) {
    textMode = m === 'text'; pickMode = m === 'pick';
    document.body.classList.toggle('ed-textmode', textMode);
    document.body.classList.toggle('ed-pickmode', pickMode);
    closePop(); setHover(null);
    if (pickMode) tab = 'pick';
    drawPanel();
  }

  // ---------------- the edit panel ----------------
  let panel = null, tab = 'pick';
  function changed() {
    dirty = true;
    try { localStorage.setItem(LS_DRAFT, JSON.stringify(cfg)); } catch (e) { /* storage off */ }
    applyAll();
    drawPanel();
  }
  function flash(msg) {
    const f = el('div', { class: 'ed-ui ed-flash' }, msg);
    document.body.append(f);
    setTimeout(() => f.remove(), 2200);
  }
  function lookInput([k, label, v]) {
    const cur = cfg.look[k] || base[k] || '#000000';
    return el('label', { class: 'ed-field' }, el('span', null, label),
      el('span', { class: 'ed-row' },
        el('input', { type: 'color', value: cur, oninput: (e) => { cfg.look[k] = e.target.value; dirty = true; applyLook(); }, onchange: () => changed() }),
        cfg.look[k] ? el('button', { type: 'button', class: 'ed-mini', title: 'Back to the original color', onclick: () => { delete cfg.look[k]; changed(); } }, 'Reset') : null));
  }
  function slider(k, label, min, max, step, unit, def) {
    const cur = cfg.look[k] ?? def;
    const out = el('b', null, `${cur}${unit}`);
    return el('label', { class: 'ed-field' }, el('span', null, label, ' ', out),
      el('span', { class: 'ed-row' },
        el('input', { type: 'range', min, max, step, value: cur, oninput: (e) => { cfg.look[k] = Number(e.target.value); out.textContent = `${e.target.value}${unit}`; dirty = true; applyLook(); }, onchange: () => changed() }),
        cfg.look[k] != null ? el('button', { type: 'button', class: 'ed-mini', onclick: () => { delete cfg.look[k]; changed(); } }, 'Reset') : null));
  }
  function fontSelect(k, label, def) {
    const s = el('select', { onchange: (e) => { if (e.target.value === def) delete cfg.look[k]; else cfg.look[k] = e.target.value; changed(); } },
      ...Object.entries(FONTS).map(([fk, [name]]) => el('option', { value: fk, selected: (cfg.look[k] || def) === fk }, name)));
    return el('label', { class: 'ed-field' }, el('span', null, label), s);
  }
  function lookTab() {
    return [
      el('label', { class: 'ed-field' }, el('span', null, 'Site name'),
        el('input', { type: 'text', value: cfg.siteName || base.siteName, oninput: (e) => { cfg.siteName = e.target.value.trim() === base.siteName ? '' : e.target.value.trim(); dirty = true; applyLook(); }, onchange: () => changed() })),
      ...['Backgrounds', 'Text & lines', 'Results', 'Side menu'].flatMap((g) => [el('h4', null, g), el('div', { class: 'ed-grid2' }, ...LOOK_FIELDS.filter((f) => f[3] === g).map(lookInput))]),
      slider('sideStroke', 'Side menu icon thickness', 1.4, 3.2, 0.2, '', 2.4),
      el('h4', null, 'Fonts'), fontSelect('font', 'Main text', 'inter'), fontSelect('headFont', 'Big titles', DEF_HEAD),
      el('h4', null, 'Size & spacing'),
      slider('size', 'Text size', 85, 125, 5, '%', 100),
      slider('radius', 'Corner roundness', 0, 24, 1, 'px', base.radius),
      slider('pad', 'Space inside boxes', 8, 32, 1, 'px', 18),
      slider('width', 'Page width', 900, 1800, 20, 'px', 1240),
      el('h4', null, 'Presets'),
      el('div', { class: 'ed-row ed-wrap' }, ...PRESETS.map(([name, look]) => el('button', { type: 'button', onclick: () => { cfg.look = { ...cfg.look, ...look }; changed(); } }, name)),
        el('button', { type: 'button', onclick: () => { cfg.look = {}; changed(); } }, 'Original look')),
    ];
  }
  const PRESETS = [
    ['Night', { bg: '#0f1318', panel: '#171c23', fg: '#e6e9ee', muted: '#9aa3ae', line: '#2a313b', accent: '#5b9bd5', ok: '#3fb36b', bad: '#e5534b' }],
    ['Field green', { bg: '#eef3ee', panel: '#ffffff', fg: '#16201a', muted: '#58665c', line: '#cfdccf', accent: '#1f7a3a' }],
    ['Sportsbook', { bg: '#0b1220', panel: '#121b2e', fg: '#eef2f8', muted: '#97a3b8', line: '#22304a', accent: '#22c55e', ok: '#22c55e', bad: '#f05252', font: 'barlow', headFont: 'oswald' }],
    ['Illini', { bg: '#f4f5f7', panel: '#ffffff', fg: '#13294b', muted: '#5b6782', line: '#d5dae3', accent: '#e84a27', headFont: 'montserrat' }],
  ];
  const scopeTxt = (r) => [r.area ? `only on ${r.area.match(/"([^"]+)"/)[1]}` : '', r.sp ? `only ${SPORTS[r.sp] || r.sp}` : ''].filter(Boolean).join(', ') || 'everywhere';
  function nameOf(k) { const b = document.querySelector(`[data-ek="${CSS.escape(k)}"]`); return b ? `${b.dataset.elabel} (${k.split('/')[0]})` : k; }
  function layoutTab() {
    const hid = cfg.hidden, cols = Object.entries(cfg.cols).flatMap(([t, a]) => (a || []).map((c) => [t, c]));
    return [
      el('p', { class: 'ed-help' }, 'To change, move or delete any single piece (a title, a button, the time bar under each game…), switch to "Select & style" and click it. Every box (and row of boxes) also has ↑ ↓ and Hide buttons in its top corner. Hidden boxes stay faded while you edit so you can bring them back. With "Click to rename" on, clicking a column header or a tab/menu button also lets you hide it. Columns whose name includes a team (like "NE D allows") only hide on that game.'),
      el('h4', null, `Hidden boxes (${hid.length})`),
      hid.length ? el('ul', { class: 'ed-list' }, ...hid.map((k) => el('li', null, el('span', null, nameOf(k)), el('button', { type: 'button', class: 'ed-mini', onclick: () => toggleHide(k) }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, `Hidden columns (${cols.length})`),
      cols.length ? el('ul', { class: 'ed-list' }, ...cols.map(([t, c]) => el('li', null, el('span', null, `${c} `, el('small', { class: 'ed-dim' }, t)),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.cols[t] = cfg.cols[t].filter((x) => x !== c); if (!cfg.cols[t].length) delete cfg.cols[t]; changed(); } }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, `Styled & deleted pieces (${(cfg.styles || []).length})`),
      (cfg.styles || []).length ? el('ul', { class: 'ed-list' }, ...cfg.styles.map((r) => el('li', null,
        el('span', null, r.css.hide ? el('s', null, r.label) : r.label, ' ', el('small', { class: 'ed-dim' }, scopeTxt(r))),
        el('span', { class: 'ed-row' }, el('button', { type: 'button', class: 'ed-mini', onclick: () => findOnScreen(r) }, 'Edit'),
          el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.styles = cfg.styles.filter((x) => x !== r); changed(); } }, 'Undo'))))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, `Re-ordered parts (${(cfg.moves || []).length})`),
      (cfg.moves || []).length ? el('ul', { class: 'ed-list' }, ...cfg.moves.map((m) => el('li', null,
        el('span', null, `Inside ${m.label} `, el('small', { class: 'ed-dim' }, scopeTxt(m))),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.moves = cfg.moves.filter((x) => x !== m); changed(); } }, 'Undo')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, 'Side menu'),
      el('p', { class: 'ed-help' }, 'Move items up or down, or hide them. (Some only show for certain sports.) Rename them with "Click to rename".'),
      el('ul', { class: 'ed-list' }, ...navButtons().map((b, i, all) => {
        const k = btnKey(b), off = (cfg.buttons || []).includes(k);
        return el('li', null, el('span', { class: off ? 'ed-dim' : null }, longestText(b) || b.dataset.view),
          el('span', { class: 'ed-row' },
            el('button', { type: 'button', class: 'ed-mini', title: 'Move up', onclick: () => moveNav(b.dataset.view, -1) }, '↑'),
            el('button', { type: 'button', class: 'ed-mini', title: 'Move down', onclick: () => moveNav(b.dataset.view, 1) }, '↓'),
            el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.buttons = off ? cfg.buttons.filter((x) => x !== k) : [...new Set([...(cfg.buttons || []), k])]; changed(); } }, off ? 'Show' : 'Hide')));
      })),
      el('h4', null, `Hidden tabs / buttons (${(cfg.buttons || []).length})`),
      (cfg.buttons || []).length ? el('ul', { class: 'ed-list' }, ...cfg.buttons.map((k) => el('li', null, el('span', null, `${k.split('|')[1]} `, el('small', { class: 'ed-dim' }, k.split('|')[0])),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.buttons = cfg.buttons.filter((x) => x !== k); changed(); } }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('div', { class: 'ed-row ed-wrap' }, el('button', { type: 'button', onclick: () => { cfg.order = {}; cfg.nav = []; changed(); location.reload(); } }, 'Reset box & menu order'),
        el('button', { type: 'button', onclick: () => { cfg.hidden = []; cfg.cols = {}; cfg.buttons = []; cfg.styles = (cfg.styles || []).map((r) => ({ ...r, css: { ...r.css, hide: undefined } })).filter((r) => Object.values(r.css).some((v) => v != null)); changed(); } }, 'Show everything'),
        el('button', { type: 'button', onclick: () => { cfg.styles = []; cfg.moves = []; changed(); } }, 'Undo all piece styles & moves')),
    ];
  }
  function textTab() {
    return [
      el('p', { class: 'ed-help' }, 'Pick "Renames words" at the top, then click any title, tab, button, column header or note and type new words. If the text has a player, team, position or number in it, the rename works like a pattern and changes every version of it (every player, every team, every game). Click a part in the rename box to keep just that one fixed.'),
      el('h4', null, `Renamed (${cfg.text.length})`),
      cfg.text.length ? el('ul', { class: 'ed-list' }, ...cfg.text.map((r) => el('li', null, el('span', null, el('s', { class: 'ed-dim' }, r.from), ' → ', r.to, r.tf ? el('small', { class: 'ed-tag' }, 'every version') : null),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.text = cfg.text.filter((x) => x !== r); changed(); } }, 'Undo')))) : el('p', { class: 'ed-dim' }, 'Nothing yet'),
      cfg.text.some((r) => !r.tf && tplOk(buildTemplate(r.from, r.to, [])))
        ? el('button', { type: 'button', onclick: () => { cfg.text = cfg.text.map((r) => { if (r.tf) return r; const t = buildTemplate(r.from, r.to, []); return tplOk(t) ? { from: r.from, to: r.to, tf: t.tf, tt: t.tt, fixed: [] } : r; }); changed(); flash('Older renames now change every version'); } },
          'Make my older renames work for every player / team') : null,
    ];
  }
  function saveTab() {
    let token = '', repo = DEFAULT_REPO;
    try { token = localStorage.getItem(LS_TOKEN) || ''; repo = localStorage.getItem(LS_REPO) || DEFAULT_REPO; } catch (e) { /* storage off */ }
    const status = el('p', { class: 'ed-status' }, dirty || JSON.stringify(cfg) !== JSON.stringify(published) ? 'You have changes that are only in this browser.' : 'Everything is published.');
    const tokIn = el('input', { type: 'password', value: token, placeholder: 'github_pat_…', autocomplete: 'off', 'aria-label': 'GitHub key' });
    const repoIn = el('input', { type: 'text', value: repo, 'aria-label': 'Repository' });
    const pub = el('button', { type: 'button', class: 'ed-primary', onclick: async () => {
      const t = tokIn.value.trim(), rp = repoIn.value.trim() || DEFAULT_REPO;
      if (!t) { status.textContent = 'Paste your GitHub key first (steps below).'; return; }
      try { localStorage.setItem(LS_TOKEN, t); localStorage.setItem(LS_REPO, rp); } catch (e) { /* storage off */ }
      pub.disabled = true; status.textContent = 'Publishing…';
      try { await publish(t, rp); status.textContent = 'Published. Everyone sees it within about a minute (refresh to check).'; }
      catch (err) { status.textContent = `Didn't publish: ${err.message}`; }
      pub.disabled = false;
    } }, 'Publish to GitHub');
    return [
      status,
      el('div', { class: 'ed-row ed-wrap' }, pub,
        el('button', { type: 'button', onclick: download }, 'Download file'),
        el('button', { type: 'button', onclick: () => { if (confirmBox('Throw away your unpublished changes?')) { cfg = clone(published); dirty = false; try { localStorage.removeItem(LS_DRAFT); } catch (e) { /* */ } location.reload(); } } }, 'Discard changes')),
      el('h4', null, 'GitHub key'),
      el('label', { class: 'ed-field' }, el('span', null, 'Key (saved only in this browser)'), tokIn),
      el('label', { class: 'ed-field' }, el('span', null, 'Repository'), repoIn),
      el('details', { class: 'ed-help' }, el('summary', null, 'How to get a key (one time, 2 minutes)'),
        el('ol', null,
          el('li', null, 'On github.com: your profile picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.'),
          el('li', null, 'Name it "Matchup Lab editor". Pick an expiration (1 year is fine).'),
          el('li', null, 'Repository access: "Only select repositories" → Matchup-Lab.'),
          el('li', null, 'Permissions → Repository permissions → Contents: "Read and write". Nothing else.'),
          el('li', null, 'Generate, copy the key, paste it above. It can only change files in Matchup-Lab. Don\'t share it.'))),
      el('details', { class: 'ed-help' }, el('summary', null, 'No key? Publish by hand'),
        el('ol', null,
          el('li', null, 'Press "Download file" to get site-config.json.'),
          el('li', null, 'On github.com open your Matchup-Lab repo → Add file → Upload files.'),
          el('li', null, 'Drop the file in and press "Commit changes". It replaces the old one.'))),
      el('h4', null, 'Load a saved file'),
      el('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { cfg = norm(JSON.parse(await f.text())); changed(); location.reload(); } catch (err) { status.textContent = "That file isn't a site-config.json."; }
      } }),
    ];
  }
  const confirmBox = (msg) => window.confirm(msg); // only on explicit "discard"
  function drawPanel() {
    if (!panel) return;
    const body = { pick: pickTab, look: lookTab, layout: layoutTab, text: textTab, save: saveTab }[tab]();
    const unpub = JSON.stringify(cfg) !== JSON.stringify(published);
    panel.replaceChildren(
      el('div', { class: 'ed-head' }, el('b', null, 'Edit site'), unpub ? el('span', { class: 'ed-dot', title: 'Unpublished changes' }, '● not published') : null,
        el('button', { type: 'button', class: 'ed-min', title: 'Shrink', onclick: () => panel.classList.toggle('ed-small') }, '–'),
        el('button', { type: 'button', class: 'ed-x', title: 'Done editing', onclick: () => setEditing(false) }, 'Done')),
      el('div', { class: 'ed-toggle ed-modes', role: 'group', 'aria-label': 'What clicking the page does' }, el('span', { class: 'ed-dim' }, 'Clicking the page:'),
        ...[['browse', 'Uses the site'], ['pick', 'Select & style'], ['text', 'Renames words']].map(([m, l]) =>
          el('button', { type: 'button', 'aria-pressed': String(m === (pickMode ? 'pick' : textMode ? 'text' : 'browse')), onclick: () => setMode(m) }, l))),
      el('div', { class: 'ed-tabs', role: 'tablist' }, ...[['pick', 'Selected'], ['look', 'Look'], ['layout', 'Layout'], ['text', 'Words'], ['save', unpub ? 'Publish ●' : 'Publish']].map(([k, l]) =>
        el('button', { type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; drawPanel(); } }, l))),
      el('div', { class: 'ed-body' }, ...body));
  }
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('ed-on', on);
    if (!on) { textMode = false; pickMode = false; document.body.classList.remove('ed-textmode', 'ed-pickmode'); }
    if (on) {
      if (!panel) { panel = el('div', { class: 'ed-ui ed-panel', role: 'dialog', 'aria-label': 'Edit site' }); document.body.append(panel); }
      decorate(); drawPanel();
    } else {
      undecorate();
      if (panel) { panel.remove(); panel = null; }
      drawBanner();
    }
  }

  // ---------------- publish / download ----------------
  const out = () => JSON.stringify(clean(cfg), null, 2) + '\n';
  function clean(c) {
    const o = { look: {}, siteName: c.siteName || '', hidden: [...new Set(c.hidden)], order: {}, text: c.text.filter((r) => r.from && r.to != null).map((r) => (r.tf ? { from: r.from, to: r.to, tf: r.tf, tt: r.tt.slice(), fixed: (r.fixed || []).slice() } : { from: r.from, to: r.to })), cols: {}, buttons: [...new Set(c.buttons || [])], nav: (c.nav || []).slice(),
      styles: (c.styles || []).map((r) => ({ sp: r.sp || '', area: r.area || '', base: r.base, label: r.label || '', css: Object.fromEntries(Object.entries(r.css || {}).filter(([, v]) => v != null && v !== '')) })).filter((r) => r.base && Object.keys(r.css).length),
      moves: (c.moves || []).filter((m) => m && m.base && m.order && m.order.length).map((m) => ({ sp: m.sp || '', area: m.area || '', base: m.base, label: m.label || '', flex: !!m.flex, order: m.order.slice() })) };
    Object.entries(c.look).forEach(([k, v]) => { if (v != null && v !== '') o.look[k] = v; });
    Object.entries(c.order).forEach(([k, v]) => { if (v && v.length) o.order[k] = v; });
    Object.entries(c.cols).forEach(([k, v]) => { if (v && v.length) o.cols[k] = v; });
    return o;
  }
  function download() {
    const a = el('a', { href: URL.createObjectURL(new Blob([out()], { type: 'application/json' })), download: 'site-config.json' });
    document.body.append(a); a.click(); a.remove();
  }
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  async function publish(token, repo) {
    const url = `https://api.github.com/repos/${repo}/contents/site-config.json`;
    const hd = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    let sha;
    const cur = await fetch(`${url}?ref=main&t=${Date.now()}`, { headers: hd, cache: 'no-store' });
    if (cur.status === 401 || cur.status === 403) throw new Error('GitHub rejected the key. Check it has Contents: Read and write on this repo, and hasn\'t expired.');
    if (cur.ok) sha = (await cur.json()).sha; else if (cur.status !== 404) throw new Error(`GitHub said ${cur.status}`);
    const res = await fetch(url, { method: 'PUT', headers: hd, body: JSON.stringify({ message: 'Update site look/layout (Edit mode)', content: b64(out()), sha, branch: 'main' }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `GitHub said ${res.status}`); }
    published = clean(cfg); cfg = clone(published); dirty = false;
    try { localStorage.removeItem(LS_DRAFT); } catch (e) { /* storage off */ }
    drawPanel();
  }

  // ---------------- banner when a draft is showing outside edit mode ----------------
  let banner = null;
  function drawBanner() {
    const unpub = JSON.stringify(cfg) !== JSON.stringify(published);
    if (banner) { banner.remove(); banner = null; }
    if (editing || !unpub) return;
    banner = el('div', { class: 'ed-ui ed-banner' }, 'You\'re seeing your unpublished site edits (only on this device). ',
      el('button', { type: 'button', onclick: () => { setEditing(true); tab = 'save'; drawPanel(); } }, 'Publish or discard'));
    document.body.append(banner);
  }

  // ---------------- styles for the editor itself ----------------
  document.head.append(el('style', null, `
    .card { padding: var(--card-pad, 18px); }
    .ml { max-width: var(--page-w, 1240px); }
    .ed-hide { display: none !important; }
    .ed-col-off { display: none !important; }
    body.ed-on .ed-hide { display: revert !important; opacity: .35; outline: 2px dashed var(--muted); }
    body.ed-on .grid.ed-hide { display: grid !important; }
    body.ed-on .joined.ed-hide { display: block !important; }
    body.ed-on button.ed-hide { display: revert !important; }
    body.ed-on [data-ek] { position: relative; }
    body.ed-on .card[data-ek] { outline: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 3px; }
    body.ed-on .ml { padding-bottom: 60vh; }
    body.ed-textmode main :is(h1, h2, h3, h4, th, button, label, summary, .note, .lbl, .sub, small, p, li):hover,
    body.ed-textmode aside .side-nav span:hover { outline: 2px solid var(--accent); outline-offset: 2px; cursor: text; border-radius: 3px; }
    .ed-ui, .ed-ui * { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px; line-height: 1.35; box-sizing: border-box; }
    .ed-ui button { font: inherit; border: 1px solid #c9ced6; background: #fff; color: #1f2329; border-radius: 6px; padding: 4px 9px; cursor: pointer; }
    .ed-ui button:hover { background: #f1f3f6; }
    .ed-ui .ed-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .ed-ui .ed-primary:hover { background: #1d4ed8; }
    .ed-ui .ed-primary:disabled { opacity: .6; }
    .ed-tools { position: absolute; top: -12px; right: 10px; z-index: 30; display: flex; gap: 3px; align-items: center; background: #1f2329; color: #fff; padding: 3px 4px 3px 8px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .ed-tools-grid { right: auto; left: 10px; background: #475569; }
    .ed-tools .ed-name { font-size: 11px; opacity: .75; margin-right: 3px; }
    .ed-tools button { padding: 1px 7px; font-size: 12px; background: #2d333b; color: #fff; border-color: #444c56; }
    .ed-tools button:hover { background: #444c56; }
    .ed-panel { position: fixed; right: 16px; bottom: 16px; z-index: 1000; width: 340px; max-height: min(78vh, 680px); display: flex; flex-direction: column; background: #fff; color: #1f2329; border: 1px solid #d6d9de; border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.25); }
    .ed-panel.ed-small .ed-body, .ed-panel.ed-small .ed-tabs, .ed-panel.ed-small .ed-toggle { display: none; }
    .ed-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e6e8eb; }
    .ed-head b { font-size: 14px; }
    .ed-dot { color: #c2410c; font-size: 12px; }
    .ed-head .ed-min { margin-left: auto; }
    .ed-toggle { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #e6e8eb; cursor: pointer; }
    .ed-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
    .ed-tabs button { border-radius: 6px 6px 0 0; border-bottom: none; }
    .ed-tabs button[aria-pressed=true] { background: #1f2329; color: #fff; border-color: #1f2329; }
    .ed-body { overflow: auto; padding: 10px 12px 14px; border-top: 1px solid #e6e8eb; }
    .ed-body h4 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5f6670; }
    .ed-field { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
    .ed-field > span:first-child { color: #3b4249; }
    .ed-field input[type=text], .ed-field input[type=password], .ed-field select, .ed-pop input { width: 100%; padding: 6px 8px; border: 1px solid #c9ced6; border-radius: 6px; font: inherit; background: #fff; color: #1f2329; }
    .ed-field input[type=range] { flex: 1; }
    .ed-field input[type=color] { width: 44px; height: 28px; padding: 0 2px; border: 1px solid #c9ced6; border-radius: 6px; background: #fff; }
    .ed-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
    .ed-row { display: flex; gap: 6px; align-items: center; }
    .ed-wrap { flex-wrap: wrap; margin-top: 8px; }
    .ed-mini { padding: 1px 7px !important; font-size: 11px !important; }
    .ed-list { list-style: none; padding: 0; margin: 0; }
    .ed-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid #f0f1f3; }
    .ed-dim { color: #8a919a; }
    .ed-help { color: #4b535c; margin: 4px 0 8px; }
    .ed-help summary { cursor: pointer; color: #2563eb; margin-top: 8px; }
    .ed-help ol { padding-left: 18px; margin: 6px 0; }
    .ed-status { background: #f5f7fa; border-radius: 8px; padding: 8px 10px; margin: 0 0 8px; }
    .ed-pop { position: fixed; z-index: 1001; width: 280px; background: #fff; color: #1f2329; border: 1px solid #d6d9de; border-radius: 10px; padding: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 8px; }
    .ed-pop-h { font-weight: 600; }
    .ed-sep { border-top: 1px solid #eceef1; }
    .ed-flash { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 1002; background: #1f2329; color: #fff; padding: 8px 14px; border-radius: 8px; }
    .ed-banner { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 999; background: #1f2329; color: #fff; padding: 8px 10px 8px 14px; border-radius: 10px; display: flex; gap: 10px; align-items: center; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    body.ed-pickmode main *:not(.ed-ui):not(.ed-ui *), body.ed-pickmode aside.side * { cursor: crosshair !important; }
    body.ed-pickmode .ed-hov { outline: 2px solid #f59e0b !important; outline-offset: 1px; }
    body.ed-on .ed-match { outline: 2px dashed #60a5fa !important; outline-offset: 1px; }
    body.ed-on .ed-picked { outline: 3px solid #2563eb !important; outline-offset: 2px; }
    .ed-modes { flex-wrap: wrap; gap: 4px !important; }
    .ed-modes button[aria-pressed=true] { background: #2563eb; border-color: #2563eb; color: #fff; }
    .ed-tplbox { margin: 6px 0; display: grid; gap: 5px; max-width: 340px; }
    .ed-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .ed-ui .ed-chip { font-size: .78rem; padding: 3px 8px; border-radius: 999px; background: #f1f5f9; border: 1px dashed #94a3b8; color: #334155; }
    .ed-ui .ed-chip.on { background: #dbeafe; border: 1px solid #60a5fa; color: #1e3a8a; }
    .ed-tag { margin-left: 6px; font-size: .7rem; background: #dbeafe; color: #1e3a8a; border-radius: 999px; padding: 1px 6px; }
    .ed-check { display: flex; gap: 6px; align-items: center; margin: 4px 0; cursor: pointer; }
    .ed-picked-name { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 6px 9px; margin-bottom: 6px; }
    .ed-ui .ed-danger { color: #b91c1c; border-color: #fca5a5; }
    .ed-ui .ed-danger:hover { background: #fef2f2; }
    .ed-panel { width: 360px; }
    .ed-edit-link { font: inherit; background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; }
    @media (max-width: 640px) { .ed-panel { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 62vh; } }
  `));

  // ---------------- start ----------------
  function start() {
    tagBoxes();
    const cs = getComputedStyle(document.documentElement);
    const probe = document.createElement('i'); probe.style.display = 'none'; document.body.append(probe);
    LOOK_FIELDS.forEach(([k, , v]) => { probe.style.color = ''; probe.style.color = `var(${v})`; base[k] = toHex(getComputedStyle(probe).color); });
    probe.remove();
    base.radius = parseInt(cs.getPropertyValue('--radius'), 10) || 10;
    base.siteName = (document.querySelector('header h1') || {}).textContent || 'Matchup Lab';
    const foot = document.querySelector('footer');
    if (foot) foot.append(' · ', el('button', { type: 'button', class: 'ed-edit-link', onclick: () => setEditing(!editing) }, 'Edit site'));
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null'); } catch (e) { draft = null; }
    if (draft) { cfg = norm(draft); applyAll(); }
    fetch(`site-config.json?v=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => {
      published = clean(norm(j));
      if (!draft) cfg = clone(published);
      applyAll(); drawBanner();
      if (/[?&#]edit\b/.test(location.search + location.hash)) setEditing(true);
    });
  }
  function toHex(c) {
    c = String(c || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const srgb = c.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (srgb) return `#${srgb.slice(1, 4).map((x) => Math.round(Number(x) * 255).toString(16).padStart(2, '0')).join('')}`;
    if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`;
    const m = c.match(/\d+/g);
    return m && m.length >= 3 ? `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : '#000000';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
