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
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_IMAGE_SIDE = 1920;

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let statusTimer;

function say(msg) {
  const s = $('status');
  s.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.textContent = ''; }, 4000);
}

async function patch(p) {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored || {}), ...p };
  await chrome.storage.sync.set({ settings });
  say('Saved');
}

function fill() {
  $('columns').value = settings.columns;
  $('name').value = settings.name;
  $('theme').value = settings.theme;
  $('bgColor').value = HEX.test(settings.bgColor) ? settings.bgColor : '#f6f6f4';
  $('bgColorState').textContent = settings.bgColor ? '' : '(default)';
  $('city').value = settings.city;
  $('cityState').textContent = settings.lat != null ? `Using ${settings.cityLabel || settings.city}.` : 'No city set. Weather is hidden.';
}

async function load() {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  fill();
}

/* ---------- simple fields ---------- */

$('columns').addEventListener('change', (e) => {
  const n = Math.min(8, Math.max(1, Math.round(Number(e.target.value)) || 3));
  e.target.value = n;
  patch({ columns: n });
});
$('name').addEventListener('change', (e) => patch({ name: e.target.value.trim() }));
$('theme').addEventListener('change', (e) => patch({ theme: e.target.value }));
$('bgColor').addEventListener('change', async (e) => {
  await patch({ bgColor: e.target.value });
  $('bgColorState').textContent = '';
});
$('bgColorClear').addEventListener('click', async () => {
  await patch({ bgColor: '' });
  $('bgColorState').textContent = '(default)';
});

/* ---------- background image ---------- */

$('bgImage').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    await chrome.storage.local.set({ bgImage: canvas.toDataURL('image/jpeg', 0.85) });
    say('Background image saved');
  } catch (err) {
    say('Could not read that image.');
    console.warn(err);
  }
  e.target.value = '';
});
$('bgImageClear').addEventListener('click', async () => {
  await chrome.storage.local.remove('bgImage');
  say('Background image removed');
});

/* ---------- weather city ---------- */

async function findCity() {
  const name = $('city').value.trim();
  if (!name) return;
  $('cityState').textContent = 'Searching...';
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const hit = j.results && j.results[0];
    if (!hit) {
      $('cityState').textContent = `No match for "${name}". Try another spelling.`;
      return;
    }
    await patch({ city: name, cityLabel: hit.name, lat: hit.latitude, lon: hit.longitude });
    $('cityState').textContent = `Using ${hit.name}${hit.country ? `, ${hit.country}` : ''}.`;
  } catch (err) {
    $('cityState').textContent = 'Could not reach the weather service. Check your connection and try again.';
    console.warn(err);
  }
}
$('cityFind').addEventListener('click', findCity);
$('city').addEventListener('keydown', (e) => { if (e.key === 'Enter') findCity(); });
$('cityClear').addEventListener('click', async () => {
  await patch({ city: '', cityLabel: '', lat: null, lon: null });
  $('city').value = '';
  $('cityState').textContent = 'No city set. Weather is hidden.';
});

/* ---------- folders ---------- */

function hasLinks(node) {
  return (node.children || []).some((c) => c.url || hasLinks(c));
}

// Same rule as the new tab page: cards are the top-level folders that hold bookmarks
// anywhere inside them, plus a root folder (e.g. Bookmarks bar) for bookmarks sitting
// directly in it. Deeper subfolders open as popups inside their card, so they aren't listed.
async function listFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const out = [];
  for (const top of root.children || []) {
    const title = top.title || 'Untitled';
    if ((top.children || []).some((c) => c.url)) out.push({ id: top.id, title, path: '' });
    for (const c of top.children || []) {
      if (!c.url && hasLinks(c)) out.push({ id: c.id, title: c.title || 'Untitled', path: title });
    }
  }
  return out;
}

async function setHidden(ids) {
  await chrome.storage.sync.set({ hidden: ids });
  say('Saved');
}

async function renderFolders() {
  const folders = await listFolders();
  const { hidden } = await chrome.storage.sync.get('hidden');
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
  const box = $('folders');
  box.textContent = '';
  if (!folders.length) {
    box.textContent = 'No bookmark folders found.';
    return;
  }
  for (const f of folders) {
    const label = document.createElement('label');
    label.className = 'folder';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hiddenSet.has(f.id);
    cb.dataset.id = f.id;
    const name = document.createElement('span');
    name.textContent = f.title;
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = f.path ? `in ${f.path}` : '';
    label.append(cb, name, path);
    box.append(label);
  }
}

$('folders').addEventListener('change', async (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const { hidden } = await chrome.storage.sync.get('hidden');
  const set = new Set(Array.isArray(hidden) ? hidden : []);
  if (e.target.checked) set.delete(e.target.dataset.id);
  else set.add(e.target.dataset.id);
  await setHidden([...set]);
});
$('foldersAll').addEventListener('click', async () => {
  await setHidden([]);
  renderFolders();
});
$('foldersNone').addEventListener('click', async () => {
  await setHidden((await listFolders()).map((f) => f.id));
  renderFolders();
});

const refreshFolders = (() => {
  let t;
  return () => { clearTimeout(t); t = setTimeout(renderFolders, 200); };
})();
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[ev].addListener(refreshFolders);
}

/* ---------- export / import ---------- */

$('export').addEventListener('click', async () => {
  const data = await chrome.storage.sync.get(SYNC_KEYS);
  const blob = new Blob([JSON.stringify({ app: 'homepage-ext', version: 1, data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'homepage-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('importBtn').addEventListener('click', () => $('importFile').click());

function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function sanitise(data) {
  const out = {};
  if (data.settings && typeof data.settings === 'object') {
    const s = data.settings;
    const clean = { ...DEFAULT_SETTINGS };
    if (Number.isFinite(s.columns)) clean.columns = Math.min(8, Math.max(1, Math.round(s.columns)));
    if (typeof s.name === 'string') clean.name = s.name.slice(0, 60);
    if (['system', 'light', 'dark'].includes(s.theme)) clean.theme = s.theme;
    if (typeof s.bgColor === 'string' && (s.bgColor === '' || HEX.test(s.bgColor))) clean.bgColor = s.bgColor;
    if (typeof s.city === 'string') clean.city = s.city.slice(0, 100);
    if (typeof s.cityLabel === 'string') clean.cityLabel = s.cityLabel.slice(0, 100);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
      clean.lat = s.lat;
      clean.lon = s.lon;
    }
    out.settings = clean;
  }
  if (data.layout && typeof data.layout === 'object' && !Array.isArray(data.layout)) {
    out.layout = {};
    for (const [k, cols] of Object.entries(data.layout)) {
      if (!/^[1-8]$/.test(k) || !Array.isArray(cols)) continue;
      out.layout[k] = cols.slice(0, Number(k)).map(strArray);
    }
  }
  if ('pinned' in data) out.pinned = strArray(data.pinned);
  if ('hidden' in data) out.hidden = strArray(data.hidden);
  if (data.collapsed && typeof data.collapsed === 'object') {
    out.collapsed = {};
    for (const [k, v] of Object.entries(data.collapsed)) if (v === true) out.collapsed[k] = true;
  }
  if (data.cardStyle && typeof data.cardStyle === 'object') {
    out.cardStyle = {};
    for (const [k, v] of Object.entries(data.cardStyle)) {
      if (!v || typeof v !== 'object') continue;
      const st = {};
      if (typeof v.icon === 'string' && v.icon) st.icon = v.icon.slice(0, 8);
      if (typeof v.color === 'string' && HEX.test(v.color)) st.color = v.color;
      if (Object.keys(st).length) out.cardStyle[k] = st;
    }
  }
  return out;
}

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.app !== 'homepage-ext' || !parsed.data || typeof parsed.data !== 'object') {
      throw new Error('Not a Home Page settings file');
    }
    await chrome.storage.sync.set(sanitise(parsed.data));
    await load();
    await renderFolders();
    say('Settings imported');
  } catch (err) {
    say('Could not import that file. Use a file exported from this extension.');
    console.warn(err);
  }
});

load();
renderFolders();
