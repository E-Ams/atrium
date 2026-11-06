'use strict';

const DEFAULT_SETTINGS = {
  columns: 3,
  name: '',
  theme: 'system',
  bgColor: '',
  city: '',
  cityLabel: '',
  lat: null,
  lon: null,
};
const SYNC_KEYS = ['settings', 'layout', 'collapsed', 'cardStyle', 'pinned', 'hidden'];
const COLORS = ['#e57373', '#f4a261', '#e9c46a', '#81c784', '#4db6ac', '#64b5f6', '#9575cd', '#f06292', '#a1887f', '#90a4ae'];
const DEFAULT_ICON = 'Folder';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_COLUMN_WIDTH = 200;
const WEATHER_MAX_AGE = 30 * 60 * 1000;
const WEATHER_CHECK_EVERY = 10 * 60 * 1000;
const WEB_URL = /^(https?|ftp):/i;

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  layout: {},
  collapsed: {},
  cardStyle: {},
  pinned: [],
  hidden: [],
  bgImage: '',
  folders: [],
  byId: new Map(),
  cardEls: [],
  firstMatch: null,
  columnCount: 0,
};

let dragId = null;
let editingId = null;
let noticeTimer;

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function notify(msg) {
  let n = $('notice');
  if (!n) {
    n = el('div');
    n.id = 'notice';
    n.setAttribute('role', 'status');
    document.body.append(n);
  }
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.hidden = true; }, 6000);
}

/* ---------- storage ---------- */

function normalise(key, value) {
  if (key === 'settings') return { ...DEFAULT_SETTINGS, ...(value || {}) };
  if (key === 'pinned' || key === 'hidden') return Array.isArray(value) ? value : [];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadStorage() {
  const s = await chrome.storage.sync.get(SYNC_KEYS);
  for (const k of SYNC_KEYS) state[k] = normalise(k, s[k]);
  const l = await chrome.storage.local.get('bgImage');
  state.bgImage = l.bgImage || '';
}

function save(key) {
  return chrome.storage.sync.set({ [key]: state[key] }).catch((err) => {
    console.warn('Could not save', key, err);
    notify(`Couldn't save your changes (${err.message}).`);
  });
}

/* ---------- opening links ---------- */

function openUrl(url, newTab) {
  if (/^javascript:/i.test(url)) {
    notify("Bookmarklets can't run from this page. Use them from the bookmarks bar.");
    return;
  }
  if (newTab) chrome.tabs.create({ url, active: false });
  else if (WEB_URL.test(url)) window.location.href = url;
  else chrome.tabs.update({ url });
}

/* ---------- bookmarks ---------- */

// A folder node: { id, title, path, entries, total }.
// entries keep bookmark order and hold links ({ kind: 'link', id, title, url })
// and subfolders ({ kind: 'folder', node }). Folders with no bookmarks anywhere are dropped.
function buildNode(node, path, linksOnly) {
  const here = path.concat(node.title || 'Untitled');
  const entries = [];
  let total = 0;
  for (const c of node.children || []) {
    if (c.url) {
      const link = { kind: 'link', id: c.id, title: c.title || c.url, url: c.url };
      entries.push(link);
      state.byId.set(c.id, link);
      total++;
    } else if (!linksOnly) {
      const sub = buildNode(c, here, false);
      if (sub.total) {
        entries.push({ kind: 'folder', node: sub });
        total += sub.total;
      }
    }
  }
  return { id: node.id, title: node.title || 'Untitled', path: here.join(' / '), entries, total };
}

// Cards are the top-level folders (children of Bookmarks bar, Other bookmarks, ...).
// A root folder gets its own card only for bookmarks sitting directly in it.
async function loadBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  state.byId = new Map();
  const folders = [];
  for (const top of root.children || []) {
    const loose = buildNode(top, [], true);
    if (loose.total) folders.push(loose);
    for (const c of top.children || []) {
      if (c.url) continue;
      const n = buildNode(c, [top.title || 'Untitled'], false);
      if (n.total) folders.push(n);
    }
  }
  state.folders = folders;
}

/* ---------- theme and background ---------- */

function applyTheme() {
  const root = document.documentElement;
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark' || t === 'nocturne-paper') root.dataset.theme = t;
  else delete root.dataset.theme;
  // Nocturne × Paper shows the "/" shortcut as a key next to the box instead.
  $('search').placeholder = t === 'nocturne-paper' ? 'Search bookmarks' : 'Search bookmarks  ( / )';
  document.body.style.backgroundColor = state.settings.bgColor || '';
  document.body.style.backgroundImage = state.bgImage ? `url("${state.bgImage}")` : '';
}

/* ---------- clock, greeting, weather ---------- */

function tick() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = state.settings.name.trim();
  $('greeting').textContent = name ? `${part}, ${name}` : part;
}

async function loadWeather() {
  const s = state.settings;
  const box = $('weather');
  if (s.lat == null || s.lon == null) {
    box.textContent = '';
    return;
  }
  const { weatherCache } = await chrome.storage.local.get('weatherCache');
  const sameSpot = weatherCache && weatherCache.lat === s.lat && weatherCache.lon === s.lon;
  let data = sameSpot && Date.now() - weatherCache.at < WEATHER_MAX_AGE ? weatherCache : null;
  if (!data) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}&current=temperature_2m,weather_code`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      data = { lat: s.lat, lon: s.lon, at: Date.now(), temp: j.current.temperature_2m, code: j.current.weather_code };
      await chrome.storage.local.set({ weatherCache: data });
    } catch (err) {
      console.warn('Weather fetch failed', err);
      data = sameSpot ? weatherCache : null;
    }
  }
  if (!data) {
    box.textContent = '';
    return;
  }
  const label = s.cityLabel ? `${s.cityLabel} ` : '';
  box.textContent = `${label}${Math.round(data.temp)}°C ${WMO[data.code] || ''}`.trim();
}

/* ---------- pinned ---------- */

function renderPinned() {
  const list = $('pinned-list');
  list.textContent = '';
  const items = state.pinned.map((id) => state.byId.get(id)).filter(Boolean);
  $('pinned').hidden = items.length === 0;
  for (const it of items) {
    const chip = el('span', 'chip');
    const a = el('a', null, it.title);
    a.href = it.url;
    a.title = it.url;
    const x = el('button', null, '×');
    x.type = 'button';
    x.title = 'Unpin';
    x.addEventListener('click', () => togglePin(it.id));
    chip.append(favicon(it.url), a, x);
    list.append(chip);
  }
}

function syncPinStars() {
  for (const li of document.querySelectorAll('.item')) {
    const btn = li.querySelector('.item-pin');
    const pinned = state.pinned.includes(li.dataset.id);
    btn.textContent = pinned ? '★' : '☆';
    btn.title = pinned ? 'Unpin' : 'Pin';
  }
}

function togglePin(id) {
  const i = state.pinned.indexOf(id);
  if (i >= 0) state.pinned.splice(i, 1);
  else state.pinned.push(id);
  save('pinned');
  renderPinned();
  syncPinStars();
}

/* ---------- cards ---------- */

function applyCardStyle(card, id) {
  const st = state.cardStyle[id] || {};
  if (st.color) card.style.setProperty('--card-color', st.color);
  else card.style.removeProperty('--card-color');
  setIcon(card.querySelector('.card-icon'), id);
}

/* ---------- folder icons ---------- */

// Saved icon for a card or subfolder; unknown names fall back to the folder icon.
function iconName(id) {
  const name = (state.cardStyle[id] || {}).icon;
  return name && MUI_ICONS[name] ? name : DEFAULT_ICON;
}

function muiIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mui');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', MUI_ICONS[name] || MUI_ICONS[DEFAULT_ICON]);
  svg.append(path);
  return svg;
}

function setIcon(span, id) {
  span.replaceChildren(muiIcon(iconName(id)));
}

// Chrome's favicon cache for a page (needs the "favicon" permission).
// Unknown pages get Chrome's default globe icon.
function favicon(url) {
  const img = el('img', 'favicon');
  img.src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
  img.width = 16;
  img.height = 16;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function buildLink(it) {
  const li = el('li', 'item');
  li.dataset.id = it.id;
  const a = el('a', 'item-link', it.title);
  a.href = it.url;
  a.title = it.url;
  const pin = el('button', 'item-pin');
  pin.type = 'button';
  pin.addEventListener('click', () => togglePin(it.id));
  li.append(favicon(it.url), a, pin);
  return li;
}

// level: 0 for a row in a card, n for a row inside the nth popup.
function buildEntry(entry, level) {
  if (entry.kind === 'link') return buildLink(entry);
  const sub = entry.node;
  const li = el('li', 'folder-item');
  li.dataset.folder = sub.id;
  const btn = el('button', 'folder-btn');
  btn.type = 'button';
  btn.title = sub.path;
  const icon = el('span', 'folder-icon');
  setIcon(icon, sub.id);
  btn.append(icon, el('span', 'folder-name', sub.title), el('span', 'folder-count', String(sub.total)));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    let x = e.pageX;
    let y = e.pageY;
    if (e.detail === 0) {
      const r = btn.getBoundingClientRect();
      x = r.left + window.scrollX + 16;
      y = r.bottom + window.scrollY;
    }
    openPopup(sub, x, y, level);
  });
  const edit = el('button', 'folder-edit', '✎');
  edit.type = 'button';
  edit.title = 'Change icon';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(sub.id, edit, true);
  });
  li.append(btn, edit);
  return li;
}

/* ---------- subfolder popups ---------- */

const popups = [];

function closePopups(fromLevel = 0) {
  while (popups.length > fromLevel) popups.pop().remove();
}

// Opens a popup for a subfolder at the mouse. Opening from level n closes deeper popups.
function openPopup(node, x, y, level) {
  closePopups(level);
  const pop = el('div', 'popup');
  pop.dataset.level = String(level + 1);
  pop.append(el('div', 'popup-title', node.title));
  const list = el('ul', 'card-list');
  for (const e of node.entries) list.append(buildEntry(e, level + 1));
  pop.append(list);
  document.body.append(pop);
  popups.push(pop);
  syncPinStars();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const maxX = window.scrollX + window.innerWidth - w - 8;
  const maxY = window.scrollY + window.innerHeight - h - 8;
  pop.style.left = `${Math.max(window.scrollX + 8, Math.min(x, maxX))}px`;
  pop.style.top = `${Math.max(window.scrollY + 8, Math.min(y, maxY))}px`;
}

function buildCard(f) {
  const card = el('section', 'card');
  card.dataset.id = f.id;
  if (state.collapsed[f.id]) card.classList.add('collapsed');

  const head = el('div', 'card-head');
  const icon = el('span', 'card-icon');
  const title = el('span', 'card-title', f.title);
  title.title = f.path;
  const count = el('span', 'card-count', String(f.total));
  const edit = el('button', 'card-edit', '✎');
  edit.type = 'button';
  edit.title = 'Customise card';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(f.id, edit);
  });
  head.append(icon, title, count, edit);

  const list = el('ul', 'card-list');
  for (const e of f.entries) list.append(buildEntry(e, 0));
  card.append(head, list);
  applyCardStyle(card, f.id);

  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (card.classList.toggle('collapsed')) state.collapsed[f.id] = true;
    else delete state.collapsed[f.id];
    save('collapsed');
  });

  head.addEventListener('mousedown', (e) => {
    if (!e.target.closest('button')) card.draggable = true;
  });
  card.addEventListener('dragstart', (e) => {
    dragId = f.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', f.id);
  });
  card.addEventListener('dragend', () => {
    card.draggable = false;
    endDrag();
  });

  return card;
}

/* ---------- layout and drag ---------- */

function effectiveColumns() {
  const wrap = $('cards');
  const avail = wrap.clientWidth || window.innerWidth;
  const fit = Math.max(1, Math.floor(avail / MIN_COLUMN_WIDTH));
  return Math.max(1, Math.min(Number(state.settings.columns) || 3, fit));
}

function contentHeight(col) {
  const last = col.lastElementChild;
  return last ? last.getBoundingClientRect().bottom - col.getBoundingClientRect().top : 0;
}

function readLayout() {
  return [...$('cards').querySelectorAll('.col')].map((c) =>
    [...c.querySelectorAll(':scope > .card')].map((card) => card.dataset.id));
}

function clearDropMarks() {
  for (const c of document.querySelectorAll('.drop-before, .drop-end')) {
    c.classList.remove('drop-before', 'drop-end');
  }
}

function endDrag() {
  dragId = null;
  clearDropMarks();
  for (const c of document.querySelectorAll('.card.dragging')) c.classList.remove('dragging');
}

// The card the dragged card should go in front of, or null for the end of the column.
function dropSlot(col, y) {
  for (const c of col.querySelectorAll(':scope > .card')) {
    if (c.dataset.id === dragId) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) return c;
  }
  return null;
}

function placeCard(id, colIndex, beforeId) {
  const layout = readLayout().map((ids) => ids.filter((x) => x !== id));
  const col = layout[colIndex];
  if (!col) return;
  const idx = beforeId ? col.indexOf(beforeId) : -1;
  if (idx >= 0) col.splice(idx, 0, id);
  else col.push(id);
  state.layout[layout.length] = withHidden(layout, state.layout[layout.length]);
  save('layout');
  endDrag();
  renderCards();
}

// Hidden folders aren't on the page, so a layout read from the page leaves them out.
// Put them back at their old index so a folder you show again returns to its spot.
function withHidden(layout, saved) {
  if (!Array.isArray(saved)) return layout;
  const hidden = new Set(state.hidden);
  const exists = new Set(state.folders.map((f) => f.id));
  return layout.map((ids, i) => {
    const out = ids.slice();
    const old = Array.isArray(saved[i]) ? saved[i] : [];
    old.forEach((id, idx) => {
      if (hidden.has(id) && exists.has(id) && !out.includes(id)) out.splice(Math.min(idx, out.length), 0, id);
    });
    return out;
  });
}

function buildColumn(index) {
  const col = el('div', 'col');
  col.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = dropSlot(col, e.clientY);
    clearDropMarks();
    if (before) before.classList.add('drop-before');
    else col.classList.add('drop-end');
  });
  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) clearDropMarks();
  });
  col.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const before = dropSlot(col, e.clientY);
    placeCard(dragId, index, before ? before.dataset.id : null);
  });
  return col;
}

// Cards keep the column and position saved for this column count.
// Cards with no saved spot (new folders, first run) go to the shortest column.
function layoutColumns() {
  const wrap = $('cards');
  wrap.textContent = '';
  if (!state.cardEls.length) {
    state.columnCount = 0;
    wrap.append(el('div', 'empty', state.folders.length
      ? 'All folders are hidden. Choose folders to show in settings.'
      : 'No bookmarks found.'));
    return;
  }
  const n = effectiveColumns();
  state.columnCount = n;
  const cols = [];
  for (let i = 0; i < n; i++) {
    const c = buildColumn(i);
    wrap.append(c);
    cols.push(c);
  }

  const unplaced = new Map(state.cardEls.map((c) => [c.dataset.id, c]));
  const saved = state.layout[n];
  if (Array.isArray(saved)) {
    saved.slice(0, n).forEach((ids, i) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids) {
        const card = unplaced.get(id);
        if (!card) continue;
        cols[i].append(card);
        unplaced.delete(id);
      }
    });
  }
  for (const card of unplaced.values()) {
    let best = cols[0];
    for (const c of cols) if (contentHeight(c) < contentHeight(best)) best = c;
    best.append(card);
  }

  const now = withHidden(readLayout(), saved);
  if (JSON.stringify(now) !== JSON.stringify(saved)) {
    state.layout[n] = now;
    save('layout');
  }
}

function renderCards() {
  const hidden = new Set(state.hidden);
  state.cardEls = state.folders.filter((f) => !hidden.has(f.id)).map(buildCard);
  layoutColumns();
  syncPinStars();
  applySearch();
}

/* ---------- search ---------- */

function linkMatches(link, q) {
  return link.title.toLowerCase().includes(q) || link.url.toLowerCase().includes(q);
}

// Links under a folder that match. inherited = an ancestor folder name matched.
function matchingLinks(node, q, inherited) {
  const hit = inherited || node.title.toLowerCase().includes(q);
  const out = [];
  for (const e of node.entries) {
    if (e.kind === 'link') {
      if (hit || linkMatches(e, q)) out.push(e);
    } else {
      out.push(...matchingLinks(e.node, q, hit));
    }
  }
  return out;
}

function applySearch() {
  const q = $('search').value.trim().toLowerCase();
  const byFolder = new Map(state.folders.map((f) => [f.id, f]));
  const hits = [];
  for (const card of state.cardEls) {
    const f = byFolder.get(card.dataset.id);
    const folderHit = Boolean(q) && f.title.toLowerCase().includes(q);
    let any = false;
    const rows = card.querySelectorAll(':scope > .card-list > li');
    f.entries.forEach((entry, i) => {
      const li = rows[i];
      let url = null;
      if (!q) {
        url = null;
      } else if (entry.kind === 'link') {
        if (folderHit || linkMatches(entry, q)) url = entry.url;
      } else {
        const m = matchingLinks(entry.node, q, folderHit);
        if (m.length) url = m[0].url;
      }
      const hit = !q || url !== null;
      li.classList.toggle('dim', !hit);
      if (q && hit) {
        any = true;
        if (!card.classList.contains('collapsed')) hits.push({ li, url });
      }
    });
    card.classList.toggle('dim', Boolean(q) && !any);
  }
  // First match = top-most, then left-most visible result.
  let first = null;
  let best = null;
  for (const h of hits) {
    const r = h.li.getBoundingClientRect();
    if (!best || r.top < best.top - 1 || (Math.abs(r.top - best.top) <= 1 && r.left < best.left)) {
      best = r;
      first = h.url;
    }
  }
  state.firstMatch = first;
}

/* ---------- card editor ---------- */

function buildSwatches() {
  const box = $('ed-colors');
  const none = el('button', 'swatch none');
  none.type = 'button';
  none.title = 'Default colour';
  none.dataset.color = '';
  box.append(none);
  for (const c of COLORS) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.background = c;
    b.dataset.color = c;
    box.append(b);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (!b || !editingId) return;
    updateStyle(editingId, { color: b.dataset.color });
  });
}

function buildIconGrid() {
  const box = $('ed-icons');
  for (const name of Object.keys(MUI_ICONS)) {
    const b = el('button', 'icon-opt');
    b.type = 'button';
    b.title = name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ');
    b.dataset.name = name;
    b.dataset.search = b.title.toLowerCase();
    b.append(muiIcon(name));
    box.append(b);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.icon-opt');
    if (!b || !editingId) return;
    updateStyle(editingId, { icon: b.dataset.name });
  });
}

function filterIcons() {
  const q = $('ed-search').value.trim().toLowerCase();
  for (const b of $('ed-icons').children) b.hidden = Boolean(q) && !b.dataset.search.includes(q);
}

function markSelectedIcon() {
  const cur = iconName(editingId);
  for (const b of $('ed-icons').children) b.classList.toggle('selected', b.dataset.name === cur);
}

function markSelectedSwatch() {
  const cur = (state.cardStyle[editingId] || {}).color || '';
  for (const b of $('ed-colors').children) b.classList.toggle('selected', b.dataset.color === cur);
}

function updateStyle(id, patch) {
  const st = { ...(state.cardStyle[id] || {}), ...patch };
  if (!st.icon || st.icon === DEFAULT_ICON) delete st.icon;
  if (!st.color) delete st.color;
  if (Object.keys(st).length) state.cardStyle[id] = st;
  else delete state.cardStyle[id];
  save('cardStyle');
  refreshStyle(id);
}

// Redraws the card and every subfolder row for a folder, and the editor's selection.
function refreshStyle(id) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) applyCardStyle(card, id);
  for (const s of document.querySelectorAll(`.folder-item[data-folder="${CSS.escape(id)}"] .folder-icon`)) setIcon(s, id);
  markSelectedSwatch();
  markSelectedIcon();
}

// iconOnly: subfolders get an icon but no card colour.
function openEditor(id, btn, iconOnly = false) {
  editingId = id;
  const ed = $('editor');
  ed.classList.toggle('icon-only', iconOnly);
  $('ed-search').value = '';
  filterIcons();
  markSelectedSwatch();
  markSelectedIcon();
  const r = btn.getBoundingClientRect();
  ed.hidden = false;
  ed.style.top = `${r.bottom + window.scrollY + 4}px`;
  ed.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - ed.offsetWidth - 8))}px`;
}

function closeEditor() {
  $('editor').hidden = true;
  editingId = null;
}

/* ---------- wiring ---------- */

function render() {
  applyTheme();
  tick();
  renderPinned();
  renderCards();
}

const refreshBookmarks = debounce(async () => {
  await loadBookmarks();
  renderPinned();
  renderCards();
}, 200);

function linkFromEvent(e) {
  const a = e.target.closest('a[href]');
  return a && (a.closest('.card-list') || a.closest('.chip') || a.closest('.popup')) ? a : null;
}

async function init() {
  await loadStorage();
  applyTheme();
  tick();
  setInterval(tick, 1000);
  await loadBookmarks();
  render();
  loadWeather();
  setInterval(loadWeather, WEATHER_CHECK_EVERY);
  buildSwatches();
  buildIconGrid();

  $('search').addEventListener('input', applySearch);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.firstMatch) {
      openUrl(state.firstMatch, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.target.value = '';
      applySearch();
      e.target.blur();
    }
  });

  // Chrome blocks chrome://, file:// and similar links from extension pages,
  // so those open through the tabs API instead. Web links behave normally.
  document.addEventListener('click', (e) => {
    const a = linkFromEvent(e);
    if (!a) return;
    const url = a.getAttribute('href');
    if (WEB_URL.test(url)) return;
    e.preventDefault();
    openUrl(url, e.ctrlKey || e.metaKey || e.shiftKey);
  });
  document.addEventListener('auxclick', (e) => {
    const a = e.button === 1 ? linkFromEvent(e) : null;
    if (!a) return;
    const url = a.getAttribute('href');
    if (WEB_URL.test(url)) return;
    e.preventDefault();
    openUrl(url, true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEditor();
      closePopups();
    }
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.matches('input, textarea, select') || t.isContentEditable) return;
    e.preventDefault();
    $('search').focus();
  });

  document.addEventListener('mouseup', () => {
    for (const c of document.querySelectorAll('.card[draggable="true"]')) c.draggable = false;
  });
  document.addEventListener('click', (e) => {
    if (!$('editor').hidden && !e.target.closest('#editor') && !e.target.closest('.card-edit, .folder-edit')) closeEditor();
    // Clicks inside a popup keep it open; a folder button there replaces deeper popups itself.
    // The editor can be open for a subfolder inside a popup, so clicks in it keep popups open too.
    if (popups.length && !e.target.closest('.popup, #editor') && !e.target.closest('.folder-btn')) closePopups();
  });

  $('ed-search').addEventListener('input', filterIcons);
  $('ed-reset').addEventListener('click', () => {
    if (!editingId) return;
    delete state.cardStyle[editingId];
    save('cardStyle');
    refreshStyle(editingId);
  });
  $('ed-close').addEventListener('click', closeEditor);

  $('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  window.addEventListener('resize', debounce(() => {
    if (state.cardEls.length && effectiveColumns() !== state.columnCount) layoutColumns();
  }, 150));

  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
    chrome.bookmarks[ev].addListener(refreshBookmarks);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    let dirty = false;
    if (area === 'sync') {
      for (const k of SYNC_KEYS) {
        if (!changes[k]) continue;
        const next = normalise(k, changes[k].newValue);
        if (JSON.stringify(next) === JSON.stringify(state[k])) continue;
        state[k] = next;
        dirty = true;
      }
    } else if (area === 'local' && changes.bgImage) {
      state.bgImage = changes.bgImage.newValue || '';
      dirty = true;
    }
    if (dirty) {
      render();
      loadWeather();
    }
  });
}

init();
