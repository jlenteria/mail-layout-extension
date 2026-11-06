/*
  Gmail Content Filter - popup.

  Saves to the same storage key content.js listens on, so the page updates
  without a reload. Nothing here needs the tabs permission beyond addressing
  the active Gmail tab, which is why the button that used to reload Gmail is
  gone.
*/

const api = typeof browser !== 'undefined' ? browser : chrome;

const KEY = 'rules';
const DEFAULTS = [
  'att: Invoice.pdf',
  'hide: Please see attached',
  'from: @updates.example',
].join('\n');

const area = document.getElementById('rules');
const status = document.getElementById('status');

function countRules(text) {
  const kinds = { att: 0, hide: 0, redact: 0, css: 0, from: 0 };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i < 1) continue;
    const kind = t.slice(0, i).trim().toLowerCase();
    if (kinds[kind] !== undefined && t.slice(i + 1).trim()) kinds[kind] += 1;
  }
  return kinds;
}

function describe(kinds) {
  const parts = Object.entries(kinds)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? `${parts.join('  ·  ')}` : 'no rules yet';
}

async function load() {
  const stored = await api.storage.local.get(KEY);
  area.value = stored[KEY] === undefined ? DEFAULTS : stored[KEY];
  status.textContent = describe(countRules(area.value));
}

async function save() {
  await api.storage.local.set({ [KEY]: area.value });
  status.textContent = `saved - ${describe(countRules(area.value))}`;
}

document.getElementById('save').addEventListener('click', save);

// Same three messages the manifest commands send through the service worker,
// for anyone who would rather click than remember a combination - and for
// Safari, where the shortcut field starts empty until the user records one.
async function send(type, { commitRules = false } = {}) {
  if (commitRules) {
    // Saving first matters for the picker: it appends to what is already in
    // storage, so unsaved edits here would be overwritten by the new rule.
    await api.storage.local.set({ [KEY]: area.value });
  }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || '')) {
    status.textContent = 'open a Gmail tab first, then try again';
    return;
  }
  try {
    await api.tabs.sendMessage(tab.id, { type });
    window.close();
  } catch {
    status.textContent = 'no response from Gmail - reload the tab and try again';
  }
}

for (const [id, type, commitRules] of [
  ['pick', 'gh:pick', true],
  ['edit', 'gh:edit', false],
  ['peek', 'gh:peek', false],
]) {
  document.getElementById(id).addEventListener('click', () => {
    send(type, { commitRules });
  });
}

area.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    save();
  }
});

area.addEventListener('input', () => {
  status.textContent = describe(countRules(area.value));
});

load();
