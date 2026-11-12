'use strict';

const DEFAULT_SETTINGS = {
  columns: 3,
  name: '',
  theme: 'system',
  bgColorLight: '',
  bgColorDark: '',
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
const BOOKMARKLET = /^javascript:/i;
const BOOKMARKLET_MSG = "Bookmarklets can't run from this page. Use them from the bookmarks bar.";
// Open all asks first when it would open more tabs than this.
const OPEN_ALL_CONFIRM = 15;
const FORECAST_DAYS = 5;

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

// Material icon for a WMO weather code, or null for codes Open-Meteo doesn't send.
function weatherIcon(code) {
  if (!(code in WMO)) return null;
  if (code <= 1) return 'WbSunny';
  if (code === 2) return 'FilterDrama';
  if (code === 3) return 'Cloud';
  if (code < 50) return 'Foggy';
  if (code < 60) return 'WaterDrop';
  if (code < 70 || (code >= 80 && code < 85)) return 'Umbrella';
  if (code < 90) return 'AcUnit';
  return 'Thunderstorm';
}

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
  nodes: new Map(),
  cardEls: [],
  matches: [],
  matchIndex: -1,
  selectedUrl: null,
  columnCount: 0,
  // Collapsed cards that search opened and you closed again; cleared when the search is.
  searchClosed: new Set(),
  forecastOpen: false,
};

let dragId = null;
let pinDragId = null;
let editingId = null;
let editingBookmark = null;
let menuEl = null;
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

// action: optional { label, run } shown as a button after the message, e.g. Undo.
function notify(msg, action) {
  let n = $('notice');
  if (!n) {
    n = el('div');
    n.id = 'notice';
    n.setAttribute('role', 'status');
    document.body.append(n);
  }
  n.replaceChildren(el('span', null, msg));
  if (action) {
    const b = el('button', 'notice-action', action.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      n.hidden = true;
      action.run();
    });
    n.append(b);
  }
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.hidden = true; }, action ? 10000 : 6000);
}

/* ---------- storage ---------- */

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

// True when the page shows dark colours: the Dark theme, or Follow system on a dark system.
// 'late-edition' was the earlier name for today's dark colours, so settings saved with it stay dark.
function isDarkMode(theme) {
  return theme === 'dark' || theme === 'late-edition' || (theme !== 'light' && prefersDark.matches);
}

// Older settings had one bgColor for both modes; it becomes the colour of the mode in use now.
function migrateBgColor(s) {
  const out = { ...s };
  if (out.bgColor && !out.bgColorLight && !out.bgColorDark) {
    out[isDarkMode(out.theme) ? 'bgColorDark' : 'bgColorLight'] = out.bgColor;
  }
  delete out.bgColor;
  return out;
}

function normalise(key, value) {
  if (key === 'settings') return migrateBgColor({ ...DEFAULT_SETTINGS, ...(value || {}) });
  if (key === 'pinned' || key === 'hidden') return Array.isArray(value) ? value : [];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadStorage() {
  const s = await chrome.storage.sync.get(SYNC_KEYS);
  for (const k of SYNC_KEYS) state[k] = normalise(k, s[k]);
  const l = await chrome.storage.local.get(['bgImage', 'forecastOpen']);
  state.bgImage = l.bgImage || '';
  state.forecastOpen = l.forecastOpen === true;
}

function save(key) {
  return chrome.storage.sync.set({ [key]: state[key] }).catch((err) => {
    console.warn('Could not save', key, err);
    notify(`Couldn't save your changes (${err.message}).`);
  });
}

/* ---------- opening links ---------- */

function openUrl(url, newTab) {
  if (BOOKMARKLET.test(url)) {
    notify(BOOKMARKLET_MSG);
    return;
  }
  if (newTab) chrome.tabs.create({ url, active: false });
  else if (WEB_URL.test(url)) window.location.href = url;
  else chrome.tabs.update({ url });
}

// Opens the links in one new window, or an incognito one. Bookmarklets are skipped.
function openInWindow(urls, incognito) {
  const list = urls.filter((u) => !BOOKMARKLET.test(u));
  if (!list.length) {
    notify(BOOKMARKLET_MSG);
    return;
  }
  chrome.windows.create({ url: list, incognito }).catch((err) => {
    notify(`Couldn't open the window (${err.message}).`);
  });
}

// Every link in a folder and its subfolders, in bookmark order. Bookmarklets are skipped.
function folderUrls(node) {
  const out = [];
  for (const e of node.entries) {
    if (e.kind === 'folder') out.push(...folderUrls(e.node));
    else if (!BOOKMARKLET.test(e.url)) out.push(e.url);
  }
  return out;
}

// where: 'tabs' (background tabs in this window), 'window' or 'incognito'.
function openAll(node, where = 'tabs') {
  const urls = folderUrls(node);
  if (!urls.length) {
    notify('There are no links to open in this folder.');
    return;
  }
  if (urls.length > OPEN_ALL_CONFIRM && !confirm(`Open ${urls.length} tabs from "${node.title}"?`)) return;
  if (where === 'tabs') {
    for (const url of urls) chrome.tabs.create({ url, active: false });
  } else {
    openInWindow(urls, where === 'incognito');
  }
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(
    () => notify('Link copied.'),
    () => notify("Couldn't copy the link."),
  );
}

/* ---------- editing and deleting bookmarks ---------- */

async function editBookmark(id) {
  let node;
  try {
    [node] = await chrome.bookmarks.get(id);
  } catch {
    notify('That bookmark no longer exists.');
    return;
  }
  editingBookmark = node.id;
  $('bm-title').value = node.title;
  $('bm-url').value = node.url;
  const d = $('bm-dialog');
  d.returnValue = '';
  d.showModal();
  $('bm-title').select();
}

async function saveBookmarkEdit() {
  const d = $('bm-dialog');
  const id = editingBookmark;
  editingBookmark = null;
  if (d.returnValue !== 'save' || !id) return;
  try {
    await chrome.bookmarks.update(id, { title: $('bm-title').value.trim(), url: $('bm-url').value.trim() });
  } catch (err) {
    notify(`Couldn't save the bookmark (${err.message}).`);
  }
}

async function deleteBookmark(id) {
  let node;
  try {
    [node] = await chrome.bookmarks.get(id);
    await chrome.bookmarks.remove(id);
  } catch (err) {
    notify(`Couldn't delete the bookmark (${err.message}).`);
    return;
  }
  const pinAt = state.pinned.indexOf(id);
  notify(`Deleted "${node.title || node.url}".`, {
    label: 'Undo',
    run: () => restoreBookmark(node, pinAt),
  });
}

// Puts a deleted bookmark back where it was. It comes back with a new id, so a pin moves to that id.
async function restoreBookmark(node, pinAt) {
  try {
    const siblings = await chrome.bookmarks.getChildren(node.parentId);
    const created = await chrome.bookmarks.create({
      parentId: node.parentId,
      index: Math.min(node.index, siblings.length),
      title: node.title,
      url: node.url,
    });
    if (pinAt >= 0) {
      const list = state.pinned.filter((p) => p !== node.id);
      list.splice(Math.min(pinAt, list.length), 0, created.id);
      state.pinned = list;
      save('pinned');
      renderPinned();
      syncPinStars();
    }
  } catch (err) {
    notify(`Couldn't restore the bookmark (${err.message}).`);
  }
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
  const out = { id: node.id, title: node.title || 'Untitled', path: here.join(' / '), entries, total };
  state.nodes.set(node.id, out);
  return out;
}

// Cards are the top-level folders (children of Bookmarks bar, Other bookmarks, ...).
// A root folder gets its own card only for bookmarks sitting directly in it.
async function loadBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  state.byId = new Map();
  state.nodes = new Map();
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
  const s = state.settings;
  const t = s.theme === 'late-edition' ? 'dark' : s.theme;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  // Each mode has its own background colour, so a light colour never ends up behind light text.
  document.body.style.backgroundColor = (isDarkMode(t) ? s.bgColorDark : s.bgColorLight) || '';
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

function hideWeather() {
  $('weather').hidden = true;
  $('weather').textContent = '';
  $('forecast').hidden = true;
  $('forecast').textContent = '';
}

async function loadWeather() {
  const s = state.settings;
  if (s.lat == null || s.lon == null) {
    hideWeather();
    return;
  }
  const { weatherCache } = await chrome.storage.local.get('weatherCache');
  const sameSpot = weatherCache && weatherCache.lat === s.lat && weatherCache.lon === s.lon;
  // Readings cached before the forecast was added have no daily part, so they count as stale.
  const fresh = sameSpot && weatherCache.daily && Date.now() - weatherCache.at < WEATHER_MAX_AGE;
  let data = fresh ? weatherCache : null;
  if (!data) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}`
        + '&current=temperature_2m,weather_code'
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${FORECAST_DAYS}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      data = {
        lat: s.lat,
        lon: s.lon,
        at: Date.now(),
        temp: j.current.temperature_2m,
        code: j.current.weather_code,
        daily: {
          time: j.daily.time,
          code: j.daily.weather_code,
          max: j.daily.temperature_2m_max,
          min: j.daily.temperature_2m_min,
        },
      };
      await chrome.storage.local.set({ weatherCache: data });
    } catch (err) {
      console.warn('Weather fetch failed', err);
      data = sameSpot ? weatherCache : null;
    }
  }
  if (!data) {
    hideWeather();
    return;
  }
  const box = $('weather');
  const label = s.cityLabel ? `${s.cityLabel} ` : '';
  const parts = [el('span', null, `${label}${Math.round(data.temp)}°C ${WMO[data.code] || ''}`.trim())];
  const d = data.daily;
  if (d && d.time && d.time.length) {
    parts.push(el('span', 'weather-range', `H ${Math.round(d.max[0])}° L ${Math.round(d.min[0])}°`));
  }
  const icon = weatherIcon(data.code);
  box.replaceChildren(...(icon ? [muiIcon(icon)] : []), ...parts);
  box.hidden = false;
  renderForecast(d);
}

// Parses Open-Meteo's YYYY-MM-DD as a local date, so the weekday doesn't shift by time zone.
function localDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function renderForecast(d) {
  const box = $('forecast');
  box.textContent = '';
  if (d && d.time) {
    d.time.forEach((t, i) => {
      const row = el('div', 'fc-day');
      const name = i === 0 ? 'Today' : localDate(t).toLocaleDateString([], { weekday: 'short' });
      const icon = weatherIcon(d.code[i]);
      row.append(
        el('span', 'fc-name', name),
        icon ? muiIcon(icon) : el('span'),
        el('span', 'fc-desc', WMO[d.code[i]] || ''),
        el('span', 'fc-temp', `${Math.round(d.max[i])}° / ${Math.round(d.min[i])}°`),
      );
      box.append(row);
    });
  }
  showForecast();
}

function showForecast() {
  const has = $('forecast').childElementCount > 0;
  $('forecast').hidden = !(state.forecastOpen && has);
  $('weather').setAttribute('aria-expanded', String(state.forecastOpen && has));
  $('weather').title = state.forecastOpen ? 'Hide the forecast' : 'Show the forecast';
}

function toggleForecast() {
  state.forecastOpen = !state.forecastOpen;
  chrome.storage.local.set({ forecastOpen: state.forecastOpen });
  showForecast();
}

/* ---------- pinned ---------- */

function renderPinned() {
  const list = $('pinned-list');
  list.textContent = '';
  const items = state.pinned.map((id) => state.byId.get(id)).filter(Boolean);
  $('pinned').hidden = items.length === 0;
  for (const it of items) {
    const chip = el('span', 'chip');
    chip.dataset.id = it.id;
    // The chip drags as a whole (to reorder), not the link inside it.
    chip.draggable = true;
    const a = el('a', null, it.title);
    a.href = it.url;
    a.title = it.url;
    a.dataset.bm = it.id;
    a.draggable = false;
    const x = el('button', null, '×');
    x.type = 'button';
    x.title = 'Unpin';
    x.addEventListener('click', () => togglePin(it.id));
    chip.append(favicon(it.url), a, x);
    list.append(chip);
  }
}

// Pins whose bookmark exists on this computer, in the order shown.
function shownPins() {
  return state.pinned.filter((id) => state.byId.has(id));
}

// Moves a pin in front of beforeId, or to the end when beforeId is null.
function movePin(id, beforeId) {
  const list = state.pinned.filter((p) => p !== id);
  const i = beforeId ? list.indexOf(beforeId) : -1;
  if (i >= 0) list.splice(i, 0, id);
  else list.push(id);
  state.pinned = list;
  save('pinned');
  renderPinned();
}

// Swaps a pin with its neighbour on screen: step -1 for left, 1 for right.
function shiftPin(id, step) {
  const shown = shownPins();
  const i = shown.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= shown.length) return;
  movePin(id, step < 0 ? shown[j] : shown[j + 1] || null);
}

// The chip a dragged pin should go in front of, or null for the end. Chips wrap onto
// several rows, so a point above a chip's row, or left of its middle on the same row, is before it.
function pinSlot(x, y) {
  for (const c of $('pinned-list').children) {
    if (c.dataset.id === pinDragId) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top) return c;
    if (y <= r.bottom && x < r.left + r.width / 2) return c;
  }
  return null;
}

function endPinDrag() {
  pinDragId = null;
  clearDropMarks();
  for (const c of document.querySelectorAll('.chip.dragging')) c.classList.remove('dragging');
}

function wirePinDrag() {
  const list = $('pinned-list');
  list.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    pinDragId = chip.dataset.id;
    chip.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chip.querySelector('a').href);
  });
  list.addEventListener('dragover', (e) => {
    if (!pinDragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = pinSlot(e.clientX, e.clientY);
    clearDropMarks();
    if (before) before.classList.add('drop-before');
    else list.classList.add('drop-end');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearDropMarks();
  });
  list.addEventListener('drop', (e) => {
    if (!pinDragId) return;
    e.preventDefault();
    const before = pinSlot(e.clientX, e.clientY);
    const id = pinDragId;
    endPinDrag();
    movePin(id, before ? before.dataset.id : null);
  });
  list.addEventListener('dragend', endPinDrag);
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
  // has-color lets the CSS paint the card's icon in its colour; uncoloured cards keep the theme's icon colour.
  card.classList.toggle('has-color', Boolean(st.color));
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
  a.dataset.bm = it.id;
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
  const openBtn = el('button', 'card-open', '↗');
  openBtn.type = 'button';
  openBtn.title = 'Open all in new tabs';
  openBtn.setAttribute('aria-label', `Open all links in ${f.title} in new tabs`);
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAll(f);
  });
  const edit = el('button', 'card-edit', '✎');
  edit.type = 'button';
  edit.title = 'Customise card';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(f.id, edit);
  });
  head.append(icon, title, openBtn, edit);

  const list = el('ul', 'card-list');
  for (const e of f.entries) list.append(buildEntry(e, 0));
  card.append(head, list);
  applyCardStyle(card, f.id);

  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    // A collapsed card that search opened just closes again for this search; its saved state stays.
    if (card.classList.contains('search-open')) {
      state.searchClosed.add(f.id);
      applySearch();
      return;
    }
    const searching = Boolean($('search').value.trim());
    if (card.classList.toggle('collapsed')) {
      state.collapsed[f.id] = true;
      // Collapsing during a search keeps the card shut for the rest of that search.
      if (searching) state.searchClosed.add(f.id);
    } else {
      delete state.collapsed[f.id];
      state.searchClosed.delete(f.id);
    }
    save('collapsed');
    updateCollapseAll();
    if (searching) applySearch();
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
    wrap.append(emptyState());
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

// Shown instead of the cards when there are none: says why, and offers the way out.
function emptyState() {
  const box = el('div', 'empty');
  const btn = el('button', 'empty-action');
  btn.type = 'button';
  if (state.folders.length) {
    box.append(
      el('h2', null, 'All folders are hidden'),
      el('p', null, 'Pick which bookmark folders to show as cards in settings.'),
    );
    btn.textContent = 'Choose folders';
    btn.addEventListener('click', () => {
      location.href = chrome.runtime.getURL('options.html#folders');
    });
  } else {
    const key = /Mac/i.test(navigator.platform) ? '⌘D' : 'Ctrl+D';
    box.append(
      el('h2', null, 'No bookmarks yet'),
      el('p', null, `Atrium makes a card for each of your bookmark folders. Bookmark a page with ${key}, `
        + "or create folders in Chrome's bookmark manager, and they'll appear here."),
    );
    btn.textContent = 'Open bookmark manager';
    btn.addEventListener('click', () => chrome.tabs.update({ url: 'chrome://bookmarks/' }));
  }
  box.append(btn);
  return box;
}

function renderCards() {
  const hidden = new Set(state.hidden);
  state.cardEls = state.folders.filter((f) => !hidden.has(f.id)).map(buildCard);
  layoutColumns();
  syncPinStars();
  updateCollapseAll();
  applySearch();
}

/* ---------- collapse all ---------- */

function updateCollapseAll() {
  const b = $('collapse-all');
  b.hidden = state.cardEls.length === 0;
  b.textContent = state.cardEls.some((c) => !c.classList.contains('collapsed')) ? 'Collapse all' : 'Expand all';
}

// Collapses every card if any is open; otherwise expands them all.
function toggleAllCards() {
  const collapse = state.cardEls.some((c) => !c.classList.contains('collapsed'));
  for (const c of state.cardEls) {
    c.classList.toggle('collapsed', collapse);
    if (collapse) state.collapsed[c.dataset.id] = true;
    else delete state.collapsed[c.dataset.id];
  }
  state.searchClosed.clear();
  save('collapsed');
  updateCollapseAll();
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

// Under a subfolder row, names the link that matched (the one Enter opens), or removes the line.
function showFolderMatch(li, m) {
  let hint = li.querySelector(':scope > .folder-match');
  if (!m) {
    if (hint) hint.remove();
    return;
  }
  if (!hint) {
    hint = el('a', 'folder-match');
    li.append(hint);
  }
  const first = m[0];
  hint.href = first.url;
  hint.title = first.url;
  hint.dataset.bm = first.id;
  hint.textContent = m.length > 1 ? `${first.title} and ${m.length - 1} more` : first.title;
}

function applySearch() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) state.searchClosed.clear();
  const byFolder = new Map(state.folders.map((f) => [f.id, f]));
  const hits = [];
  for (const card of state.cardEls) {
    const f = byFolder.get(card.dataset.id);
    const folderHit = Boolean(q) && f.title.toLowerCase().includes(q);
    const cardHits = [];
    const rows = card.querySelectorAll(':scope > .card-list > li');
    f.entries.forEach((entry, i) => {
      const li = rows[i];
      let url = null;
      let sub = null;
      if (!q) {
        url = null;
      } else if (entry.kind === 'link') {
        if (folderHit || linkMatches(entry, q)) url = entry.url;
      } else {
        const m = matchingLinks(entry.node, q, folderHit);
        if (m.length) {
          url = m[0].url;
          sub = m;
        }
      }
      const hit = !q || url !== null;
      li.classList.toggle('dim', !hit);
      if (entry.kind === 'folder') showFolderMatch(li, sub);
      if (q && hit) cardHits.push({ li, url });
    });
    const any = cardHits.length > 0;
    card.classList.toggle('dim', Boolean(q) && !any);
    // A collapsed card with matches opens while you search, without changing its saved state,
    // so its matches can be seen and reached with the arrow keys.
    const open = any && card.classList.contains('collapsed') && !state.searchClosed.has(f.id);
    card.classList.toggle('search-open', open);
    if (open || !card.classList.contains('collapsed')) hits.push(...cardHits);
  }
  // Arrow keys walk the matches column by column, top to bottom.
  for (const h of hits) h.rect = h.li.getBoundingClientRect();
  hits.sort((a, b) => (a.rect.left - b.rect.left) || (a.rect.top - b.rect.top));
  state.matches = hits;
  // The selection starts on the top-most, then left-most match, as Enter has always opened.
  let start = -1;
  hits.forEach((h, i) => {
    const best = start >= 0 ? hits[start].rect : null;
    if (!best || h.rect.top < best.top - 1 || (Math.abs(h.rect.top - best.top) <= 1 && h.rect.left < best.left)) start = i;
  });
  selectMatch(start);
}

// Highlights match i (-1 for none); Enter in the search box opens it.
function selectMatch(i) {
  for (const li of document.querySelectorAll('.match-selected')) li.classList.remove('match-selected');
  state.matchIndex = i;
  const m = state.matches[i];
  state.selectedUrl = m ? m.url : null;
  if (m) m.li.classList.add('match-selected');
}

function moveMatch(step) {
  const n = state.matches.length;
  if (!n) return;
  selectMatch((state.matchIndex + step + n) % n);
  state.matches[state.matchIndex].li.scrollIntoView({ block: 'nearest' });
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
    // Search matches the name plus keywords, so "database" finds Storage and "backend" finds Dns.
    b.dataset.search = `${b.title} ${MUI_ICON_TAGS[name] || ''}`.toLowerCase();
    b.append(muiIcon(name));
    box.append(b);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.icon-opt');
    if (!b || !editingId) return;
    updateStyle(editingId, { icon: b.dataset.name });
  });
}

// True when q starts at a word in the icon's search text, so "ai" finds the AI icons but not Email.
function iconMatches(search, q) {
  return ` ${search}`.includes(` ${q}`);
}

function filterIcons() {
  const q = $('ed-search').value.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const b of $('ed-icons').children) b.hidden = Boolean(q) && !iconMatches(b.dataset.search, q);
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

/* ---------- right-click menu ---------- */

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
}

// items: { label, run, disabled?, danger? } or '-' for a divider.
function showMenu(e, items) {
  closeMenu();
  const m = el('div', 'menu');
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') {
      m.append(el('div', 'menu-sep'));
      continue;
    }
    const b = el('button', 'menu-item', it.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.classList.add('danger');
    b.disabled = Boolean(it.disabled);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      it.run();
    });
    m.append(b);
  }
  const opener = e.target.closest('a, button') || null;
  m.addEventListener('keydown', (ev) => {
    const btns = [...m.querySelectorAll('.menu-item:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      btns[(i + step + btns.length) % btns.length].focus();
    } else if (ev.key === 'Escape' || ev.key === 'Tab') {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      if (opener) opener.focus();
    }
  });
  document.body.append(m);
  menuEl = m;
  // A menu opened from the keyboard has no pointer position; place it under the focused element.
  let x = e.pageX;
  let y = e.pageY;
  if (!e.clientX && !e.clientY) {
    const r = e.target.getBoundingClientRect();
    x = r.left + window.scrollX;
    y = r.bottom + window.scrollY;
  }
  const maxX = window.scrollX + window.innerWidth - m.offsetWidth - 8;
  const maxY = window.scrollY + window.innerHeight - m.offsetHeight - 8;
  m.style.left = `${Math.max(window.scrollX + 8, Math.min(x, maxX))}px`;
  m.style.top = `${Math.max(window.scrollY + 8, Math.min(y, maxY))}px`;
  const first = m.querySelector('.menu-item:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}

function linkMenu(link, inPinBar) {
  const pinned = state.pinned.includes(link.id);
  const items = [
    { label: 'Open in new tab', run: () => openUrl(link.url, true) },
    { label: 'Open in new window', run: () => openInWindow([link.url], false) },
    { label: 'Open in incognito window', run: () => openInWindow([link.url], true) },
    '-',
    { label: 'Copy link', run: () => copyLink(link.url) },
    { label: pinned ? 'Unpin' : 'Pin', run: () => togglePin(link.id) },
  ];
  if (inPinBar) {
    const shown = shownPins();
    const i = shown.indexOf(link.id);
    items.push(
      { label: 'Move left', disabled: i <= 0, run: () => shiftPin(link.id, -1) },
      { label: 'Move right', disabled: i < 0 || i >= shown.length - 1, run: () => shiftPin(link.id, 1) },
    );
  }
  items.push(
    '-',
    { label: 'Edit…', run: () => editBookmark(link.id) },
    { label: 'Delete', danger: true, run: () => deleteBookmark(link.id) },
  );
  return items;
}

// isSub: a subfolder row, which gets an icon but no card colour.
function folderMenu(node, editBtn, isSub) {
  const n = folderUrls(node).length;
  return [
    { label: `Open all (${n})`, disabled: !n, run: () => openAll(node, 'tabs') },
    { label: 'Open all in new window', disabled: !n, run: () => openAll(node, 'window') },
    { label: 'Open all in incognito window', disabled: !n, run: () => openAll(node, 'incognito') },
    '-',
    { label: isSub ? 'Change icon…' : 'Customise card…', run: () => openEditor(node.id, editBtn, isSub) },
  ];
}

function onContextMenu(e) {
  closeMenu();
  const a = linkFromEvent(e);
  if (a) {
    const link = a.dataset.bm && state.byId.get(a.dataset.bm);
    if (!link) return;
    e.preventDefault();
    showMenu(e, linkMenu(link, Boolean(a.closest('.chip'))));
    return;
  }
  const row = e.target.closest('.folder-item');
  const head = row ? null : e.target.closest('.card-head');
  const id = row ? row.dataset.folder : head ? head.closest('.card').dataset.id : null;
  const node = id && state.nodes.get(id);
  if (!node) return;
  e.preventDefault();
  const editBtn = row ? row.querySelector('.folder-edit') : head.querySelector('.card-edit');
  showMenu(e, folderMenu(node, editBtn, Boolean(row)));
}

/* ---------- wiring ---------- */

function render() {
  applyTheme();
  tick();
  renderPinned();
  renderCards();
}

const refreshBookmarks = debounce(async () => {
  // Open popups and menus point at the old bookmarks, so close them before redrawing.
  closePopups();
  closeMenu();
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
    if (e.key === 'Enter' && state.selectedUrl) {
      openUrl(state.selectedUrl, e.ctrlKey || e.metaKey);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveMatch(e.key === 'ArrowDown' ? 1 : -1);
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

  document.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  wirePinDrag();
  $('collapse-all').addEventListener('click', toggleAllCards);
  $('weather').addEventListener('click', toggleForecast);
  $('bm-dialog').addEventListener('close', saveBookmarkEdit);

  document.addEventListener('keydown', (e) => {
    // Escape in the edit dialog only closes the dialog.
    if (e.target.closest && e.target.closest('dialog')) return;
    if (e.key === 'Escape') {
      closeMenu();
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
    if (menuEl && !e.target.closest('.menu')) closeMenu();
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

  $('settings-btn').replaceChildren(muiIcon('Settings'));
  // Follow system can flip between light and dark while the tab is open; swap the background colour too.
  prefersDark.addEventListener('change', applyTheme);
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
