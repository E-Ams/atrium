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
// Material icon names, e.g. FolderSpecial. Unknown names show the default folder icon.
const ICON_NAME = /^[A-Za-z0-9]{1,40}$/;
const MAX_IMAGE_SIDE = 1920;

const $ = (id) => document.getElementById(id);

// Changes go into a draft and are only written to storage when Save is clicked.
// Cancel throws the draft away and shows the saved values again.
let saved = { ...DEFAULT_SETTINGS };
let draft = { ...DEFAULT_SETTINGS };
let savedHidden = [];
let draftHidden = new Set();
let pendingImage; // undefined: no change, string: new image data URL, null: remove image
let statusTimer;

function say(msg) {
  const s = $('status');
  s.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.textContent = ''; }, 4000);
}

function sameHidden() {
  return savedHidden.length === draftHidden.size && savedHidden.every((id) => draftHidden.has(id));
}

function isDirty() {
  return pendingImage !== undefined
    || !sameHidden()
    || Object.keys(DEFAULT_SETTINGS).some((k) => draft[k] !== saved[k]);
}

function updateActions() {
  const dirty = isDirty();
  $('save').disabled = !dirty;
  $('cancel').disabled = !dirty;
  $('dirtyNote').textContent = dirty ? 'You have unsaved changes.' : '';
}

function edit(p) {
  draft = { ...draft, ...p };
  updateActions();
}

function fill() {
  $('columns').value = draft.columns;
  $('name').value = draft.name;
  $('theme').value = draft.theme;
  $('bgColor').value = HEX.test(draft.bgColor) ? draft.bgColor : '#f6f6f4';
  $('bgColorState').textContent = draft.bgColor ? '' : '(default)';
  $('bgImageState').textContent = '';
  $('city').value = draft.city;
  $('cityState').textContent = draft.lat != null ? `Using ${draft.cityLabel || draft.city}.` : 'No city set. Weather is hidden.';
}

async function load() {
  const { settings: stored, hidden } = await chrome.storage.sync.get(['settings', 'hidden']);
  saved = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  draft = { ...saved };
  savedHidden = Array.isArray(hidden) ? hidden : [];
  draftHidden = new Set(savedHidden);
  pendingImage = undefined;
  fill();
  updateActions();
}

$('save').addEventListener('click', async () => {
  try {
    await chrome.storage.sync.set({ settings: draft, hidden: [...draftHidden] });
    if (typeof pendingImage === 'string') await chrome.storage.local.set({ bgImage: pendingImage });
    else if (pendingImage === null) await chrome.storage.local.remove('bgImage');
    await load();
    say('Saved');
  } catch (err) {
    say('Could not save your settings.');
    console.warn(err);
  }
});

$('cancel').addEventListener('click', async () => {
  draft = { ...saved };
  draftHidden = new Set(savedHidden);
  pendingImage = undefined;
  fill();
  await renderFolders();
  updateActions();
  say('Changes discarded');
});

// Back to Atrium loads the new tab page in this same tab.
let leaving = false;
$('back').addEventListener('click', () => {
  if (isDirty() && !confirm('You have unsaved changes. Leave without saving?')) return;
  leaving = true; // already confirmed, so skip the browser's leave-page prompt
  location.href = chrome.runtime.getURL('newtab.html');
});

// Closing, reloading or leaving the tab with unsaved changes asks first. Chrome shows its own
// "Leave site?" wording; pages can't set the message text.
window.addEventListener('beforeunload', (e) => {
  if (leaving || !isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ---------- simple fields ---------- */

function readColumns() {
  return Math.min(8, Math.max(1, Math.round(Number($('columns').value)) || 3));
}
$('columns').addEventListener('input', () => edit({ columns: readColumns() }));
$('columns').addEventListener('change', (e) => { e.target.value = readColumns(); });
$('name').addEventListener('input', (e) => edit({ name: e.target.value.trim() }));
$('theme').addEventListener('change', (e) => edit({ theme: e.target.value }));
$('bgColor').addEventListener('input', (e) => {
  edit({ bgColor: e.target.value });
  $('bgColorState').textContent = '';
});
$('bgColorClear').addEventListener('click', () => {
  edit({ bgColor: '' });
  $('bgColor').value = '#f6f6f4';
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
    pendingImage = canvas.toDataURL('image/jpeg', 0.85);
    $('bgImageState').textContent = 'New image is used after you save.';
    updateActions();
  } catch (err) {
    say('Could not read that image.');
    console.warn(err);
  }
  e.target.value = '';
});
$('bgImageClear').addEventListener('click', () => {
  pendingImage = null;
  $('bgImageState').textContent = 'Image is removed after you save.';
  updateActions();
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
    edit({ city: name, cityLabel: hit.name, lat: hit.latitude, lon: hit.longitude });
    $('cityState').textContent = `Using ${hit.name}${hit.country ? `, ${hit.country}` : ''}.`;
  } catch (err) {
    $('cityState').textContent = 'Could not reach the weather service. Check your connection and try again.';
    console.warn(err);
  }
}
$('cityFind').addEventListener('click', findCity);
$('city').addEventListener('keydown', (e) => { if (e.key === 'Enter') findCity(); });
$('cityClear').addEventListener('click', () => {
  edit({ city: '', cityLabel: '', lat: null, lon: null });
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

async function renderFolders() {
  const folders = await listFolders();
  const box = $('folderList');
  box.textContent = '';
  if (!folders.length) {
    const none = document.createElement('div');
    none.className = 'no-folders';
    none.textContent = 'No bookmark folders found.';
    box.append(none);
    return;
  }
  for (const f of folders) {
    const label = document.createElement('label');
    label.className = 'folder';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !draftHidden.has(f.id);
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

$('folderList').addEventListener('change', (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  if (e.target.checked) draftHidden.delete(e.target.dataset.id);
  else draftHidden.add(e.target.dataset.id);
  updateActions();
});
$('foldersAll').addEventListener('click', async () => {
  draftHidden = new Set();
  await renderFolders();
  updateActions();
});
$('foldersNone').addEventListener('click', async () => {
  draftHidden = new Set((await listFolders()).map((f) => f.id));
  await renderFolders();
  updateActions();
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
  const blob = new Blob([JSON.stringify({ app: 'atrium-ext', version: 1, data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'atrium-settings.json';
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
    if (['system', 'light', 'dark', 'nocturne-paper'].includes(s.theme)) clean.theme = s.theme;
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
      if (typeof v.icon === 'string' && ICON_NAME.test(v.icon)) st.icon = v.icon;
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
    if (!parsed || !['atrium-ext', 'homepage-ext'].includes(parsed.app) || !parsed.data || typeof parsed.data !== 'object') {
      throw new Error('Not an Atrium settings file');
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

/* ---------- sub pages ---------- */

// The page shown follows the URL hash (#general, #appearance, ...), so reload keeps your place.
const PAGES = ['general', 'appearance', 'folders', 'weather', 'backup'];

function showPage() {
  const want = location.hash.slice(1);
  const name = PAGES.includes(want) ? want : 'general';
  for (const p of PAGES) $(`page-${p}`).hidden = p !== name;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.getAttribute('href') === `#${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', showPage);
showPage();

// Folders read the draft's hidden list, so render them after it is loaded.
load().then(renderFolders);
