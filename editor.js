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
 *   buttons   hidden tabs / menu buttons      ["gp-tabs|Usage share", ...]
 */
(() => {
  'use strict';
  const LS_DRAFT = 'ml-site-draft', LS_TOKEN = 'ml-gh-token', LS_REPO = 'ml-gh-repo';
  const DEFAULT_REPO = 'bwik4/Matchup-Lab';
  const BLANK = () => ({ look: {}, siteName: '', hidden: [], order: {}, text: [], cols: {}, buttons: [] });
  const LOOK_FIELDS = [
    ['accent', 'Accent (buttons, highlights)', '--accent'], ['bg', 'Page background', '--bg'], ['panel', 'Box background', '--panel'],
    ['fg', 'Main text', '--fg'], ['muted', 'Secondary text', '--muted'], ['line', 'Borders', '--line'],
    ['ok', 'Good / over (green)', '--ok'], ['bad', 'Bad / under (red)', '--bad'],
  ];
  const FONTS = {
    system: ['System (default)', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
    helvetica: ['Clean (Helvetica / Arial)', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
    inter: ['Inter', '"Inter", system-ui, sans-serif', 'Inter:wght@400;500;600;700'],
    barlow: ['Barlow (sporty)', '"Barlow", system-ui, sans-serif', 'Barlow:wght@400;500;600;700'],
    condensed: ['Roboto Condensed', '"Roboto Condensed", "Arial Narrow", sans-serif', 'Roboto+Condensed:wght@400;600;700'],
    oswald: ['Oswald (bold, sports headline)', '"Oswald", "Arial Narrow", sans-serif', 'Oswald:wght@400;500;600'],
    montserrat: ['Montserrat', '"Montserrat", system-ui, sans-serif', 'Montserrat:wght@400;500;600;700'],
    georgia: ['Georgia (serif)', 'Georgia, "Times New Roman", serif'],
    mono: ['Monospace', 'ui-monospace, Menlo, Consolas, monospace'],
  };
  const DEF_HEAD = 'georgia';

  // ---------------- state ----------------
  let published = BLANK();   // what's in site-config.json on the site
  let cfg = BLANK();         // what's showing now (published, or your draft)
  let editing = false, textMode = false, dirty = false;
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
      [...sec.querySelectorAll('.grid')].filter((g) => g.closest('section[data-view], section[data-page]') === sec && g.querySelector(':scope > .card')).forEach((g) => {
        const first = g.querySelector(':scope > .card');
        g.dataset.ek = `${first.dataset.ek}+grid`;
        g.dataset.ea = `${area}:${first.dataset.ek}`;
        g.dataset.elabel = [...g.querySelectorAll(':scope > .card')].map((c) => c.dataset.elabel).join(' + ');
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
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = L.bg || base.bg || meta.content;
    const h1 = document.querySelector('header h1');
    if (h1) h1.textContent = cfg.siteName || base.siteName;
    document.title = cfg.siteName || base.siteName;
  }
  const BTN_BOX = '.subnav, .tabs, .side-nav, .sport-sw, .seg';
  const btnBoxKey = (box) => [...box.classList].find((c) => !['subnav', 'tabs', 'seg'].includes(c)) || [...box.classList][0] || 'menu';
  const btnKey = (btn) => { const box = btn.closest(BTN_BOX); return box ? `${btnBoxKey(box)}|${longestText(btn) || ''}` : null; };
  function applyLayout() {
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
  function applyText() {
    if (!cfg.text.length) return;
    const roots = [document.querySelector('main'), document.querySelector('aside')].filter(Boolean);
    roots.forEach((root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && n.parentElement.closest('td, script, style, .ed-ui, input, textarea, select') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let n;
      while ((n = w.nextNode())) {
        let v = n.nodeValue;
        if (!v || !v.trim()) continue;
        cfg.text.forEach(({ from, to }) => { if (from && v.includes(from) && !(to && to.includes(from) && v.includes(to))) v = v.split(from).join(to); });
        if (v !== n.nodeValue) n.nodeValue = v;
      }
    });
  }
  let applying = false;
  function applyAll() {
    applying = true;
    try { applyLook(); applyLayout(); applyText(); applyCols(); if (editing) decorate(); } finally { applying = false; }
  }
  // the site re-draws parts of the page all the time; re-apply column/text/layout rules after it does
  let queued = false;
  new MutationObserver(() => {
    if (applying || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; applying = true; try { applyLayout(); applyText(); applyCols(); if (editing) decorate(); } finally { applying = false; } });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------------- edit-mode decorations on the page ----------------
  function decorate() {
    document.querySelectorAll('.card[data-ek], .grid[data-ek]').forEach((b) => {
      if (b.querySelector(':scope > .ed-tools')) { b.querySelector(':scope > .ed-tools .ed-hidebtn').textContent = cfg.hidden.includes(b.dataset.ek) ? 'Show' : 'Hide'; return; }
      const isGrid = b.classList.contains('grid');
      const tools = el('div', { class: `ed-ui ed-tools${isGrid ? ' ed-tools-grid' : ''}` },
        el('span', { class: 'ed-name' }, isGrid ? 'Row' : 'Box'),
        el('button', { type: 'button', title: 'Move up', onclick: (e) => { e.stopPropagation(); move(b, -1); } }, '↑'),
        el('button', { type: 'button', title: 'Move down', onclick: (e) => { e.stopPropagation(); move(b, 1); } }, '↓'),
        el('button', { type: 'button', class: 'ed-hidebtn', onclick: (e) => { e.stopPropagation(); toggleHide(b.dataset.ek); } }, cfg.hidden.includes(b.dataset.ek) ? 'Show' : 'Hide'));
      b.prepend(tools);
    });
  }
  function undecorate() { document.querySelectorAll('.ed-tools').forEach((t) => t.remove()); closePop(); }
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
  function openPop(target, x, y) {
    closePop();
    const from = longestText(target);
    const isTh = target.tagName === 'TH' && target.closest('table');
    if (!from && !isTh) return;
    // if this text was already renamed, edit that rule instead of stacking a new one
    const prior = cfg.text.find((r) => r.to === from);
    const input = el('input', { type: 'text', value: from || '', 'aria-label': 'New text' });
    const save = () => {
      const v = input.value.trim(), orig = prior ? prior.from : from;
      cfg.text = cfg.text.filter((r) => r !== prior && r.from !== orig);
      if (v && v !== orig) cfg.text.push({ from: orig, to: v });
      closePop(); changed();
      if (prior) location.reload(); // the page still shows the old rename; reload so the new wording applies cleanly
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') closePop(); });
    const kids = [el('div', { class: 'ed-pop-h' }, 'Rename'), input,
      el('div', { class: 'ed-row' }, el('button', { type: 'button', class: 'ed-primary', onclick: save }, 'Save'), el('button', { type: 'button', onclick: closePop }, 'Cancel'),
        prior ? el('button', { type: 'button', onclick: () => { cfg.text = cfg.text.filter((r) => r !== prior); closePop(); changed(); location.reload(); } }, 'Undo rename') : null)];
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

  // ---------------- the edit panel ----------------
  let panel = null, tab = 'look';
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
      el('h4', null, 'Colors'), el('div', { class: 'ed-grid2' }, ...LOOK_FIELDS.map(lookInput)),
      el('h4', null, 'Fonts'), fontSelect('font', 'Main text', 'system'), fontSelect('headFont', 'Big titles', DEF_HEAD),
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
  function nameOf(k) { const b = document.querySelector(`[data-ek="${CSS.escape(k)}"]`); return b ? `${b.dataset.elabel} (${k.split('/')[0]})` : k; }
  function layoutTab() {
    const hid = cfg.hidden, cols = Object.entries(cfg.cols).flatMap(([t, a]) => (a || []).map((c) => [t, c]));
    return [
      el('p', { class: 'ed-help' }, 'Every box (and row of boxes) now has ↑ ↓ and Hide buttons in its top corner. Hidden boxes stay faded while you edit so you can bring them back. With "Click to rename" on, clicking a column header or a tab/menu button also lets you hide it. Columns whose name includes a team (like "NE D allows") only hide on that game.'),
      el('h4', null, `Hidden boxes (${hid.length})`),
      hid.length ? el('ul', { class: 'ed-list' }, ...hid.map((k) => el('li', null, el('span', null, nameOf(k)), el('button', { type: 'button', class: 'ed-mini', onclick: () => toggleHide(k) }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, `Hidden columns (${cols.length})`),
      cols.length ? el('ul', { class: 'ed-list' }, ...cols.map(([t, c]) => el('li', null, el('span', null, `${c} `, el('small', { class: 'ed-dim' }, t)),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.cols[t] = cfg.cols[t].filter((x) => x !== c); if (!cfg.cols[t].length) delete cfg.cols[t]; changed(); } }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('h4', null, `Hidden tabs / buttons (${(cfg.buttons || []).length})`),
      (cfg.buttons || []).length ? el('ul', { class: 'ed-list' }, ...cfg.buttons.map((k) => el('li', null, el('span', null, `${k.split('|')[1]} `, el('small', { class: 'ed-dim' }, k.split('|')[0])),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.buttons = cfg.buttons.filter((x) => x !== k); changed(); } }, 'Show')))) : el('p', { class: 'ed-dim' }, 'None'),
      el('div', { class: 'ed-row ed-wrap' }, el('button', { type: 'button', onclick: () => { cfg.order = {}; changed(); location.reload(); } }, 'Reset box order'),
        el('button', { type: 'button', onclick: () => { cfg.hidden = []; cfg.cols = {}; cfg.buttons = []; changed(); } }, 'Show everything')),
    ];
  }
  function textTab() {
    return [
      el('p', { class: 'ed-help' }, 'Turn on "Click to rename", then click any title, tab, button, column header or note on the page and type new words. The change applies everywhere that wording appears, including on other games and players. Turn it off to click around the site normally.'),
      el('h4', null, `Renamed (${cfg.text.length})`),
      cfg.text.length ? el('ul', { class: 'ed-list' }, ...cfg.text.map((r) => el('li', null, el('span', null, el('s', { class: 'ed-dim' }, r.from), ' → ', r.to),
        el('button', { type: 'button', class: 'ed-mini', onclick: () => { cfg.text = cfg.text.filter((x) => x !== r); changed(); location.reload(); } }, 'Undo')))) : el('p', { class: 'ed-dim' }, 'Nothing yet'),
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
    const body = { look: lookTab, layout: layoutTab, text: textTab, save: saveTab }[tab]();
    const unpub = JSON.stringify(cfg) !== JSON.stringify(published);
    panel.replaceChildren(
      el('div', { class: 'ed-head' }, el('b', null, 'Edit site'), unpub ? el('span', { class: 'ed-dot', title: 'Unpublished changes' }, '● not published') : null,
        el('button', { type: 'button', class: 'ed-min', title: 'Shrink', onclick: () => panel.classList.toggle('ed-small') }, '–'),
        el('button', { type: 'button', class: 'ed-x', title: 'Done editing', onclick: () => setEditing(false) }, 'Done')),
      el('label', { class: 'ed-toggle' }, el('input', { type: 'checkbox', checked: textMode, onchange: (e) => { textMode = e.target.checked; document.body.classList.toggle('ed-textmode', textMode); closePop(); } }),
        el('span', null, 'Click to rename ', el('small', { class: 'ed-dim' }, '(turn off to use the site normally)'))),
      el('div', { class: 'ed-tabs', role: 'tablist' }, ...[['look', 'Look'], ['layout', 'Layout'], ['text', 'Words'], ['save', unpub ? 'Publish ●' : 'Publish']].map(([k, l]) =>
        el('button', { type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; drawPanel(); } }, l))),
      el('div', { class: 'ed-body' }, ...body));
  }
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('ed-on', on);
    if (!on) { textMode = false; document.body.classList.remove('ed-textmode'); }
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
    const o = { look: {}, siteName: c.siteName || '', hidden: [...new Set(c.hidden)], order: {}, text: c.text.filter((r) => r.from && r.to != null), cols: {}, buttons: [...new Set(c.buttons || [])] };
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
    .ed-edit-link { font: inherit; background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; }
    @media (max-width: 640px) { .ed-panel { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 62vh; } }
  `));

  // ---------------- start ----------------
  function start() {
    tagBoxes();
    const cs = getComputedStyle(document.documentElement);
    LOOK_FIELDS.forEach(([k, , v]) => { base[k] = toHex(cs.getPropertyValue(v).trim()); });
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
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`;
    const m = c.match(/\d+/g);
    return m && m.length >= 3 ? `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : '#000000';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
