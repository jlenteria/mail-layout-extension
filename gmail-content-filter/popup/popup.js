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
  'att: LENTERIA LEDGER.pdf',
  'hide: Please see attached',
  'from: @updates.example',
  'css: div[data-card-id$=":kopisummary"]',
].join('\n');

// Safari's extension storage occasionally rejects reads and writes with
// "Disk I/O error" (Safari 18.5 and 26/27). Retry instead of treating the
// failure as "no rules", which would make the box look empty and a Save wipe
// the rules that are still on disk.
const RETRY_MS = [0, 120, 300, 700];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryStorage(operation) {
  let lastError;
  for (const delay of RETRY_MS) {
    if (delay) await wait(delay);
    try {
      return await operation();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const readStoredRules = () => retryStorage(() => api.storage.local.get(KEY));
const writeStoredRules = (text) => retryStorage(
  () => api.storage.local.set({ [KEY]: text }),
);

const area = document.getElementById('rules');
const status = document.getElementById('status');
const buttons = [...document.querySelectorAll('.row button')];
let savedText = null;

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function setEnabled(on) {
  area.disabled = !on;
  for (const button of buttons) button.disabled = !on;
}

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
  try {
    const stored = await readStoredRules();
    savedText = stored[KEY] === undefined ? DEFAULTS : String(stored[KEY]);
    area.value = savedText;
    setEnabled(true);
    setStatus(describe(countRules(savedText)));
  } catch (err) {
    // Do not show an empty box over rules that still exist on disk, and do
    // not let Save overwrite them. Keep trying until storage answers.
    console.warn('[Mail Layout] could not read rules', err);
    setEnabled(false);
    setStatus(
      'Safari could not read extension storage (Disk I/O error). Retrying; your rules are still on disk.',
      true,
    );
    setTimeout(load, 5000);
  }
}

async function save() {
  const text = area.value;
  if (text === savedText) {
    setStatus(`saved - ${describe(countRules(text))}`);
    return;
  }
  setStatus('saving…');
  try {
    await writeStoredRules(text);
    savedText = text;
    setStatus(`saved - ${describe(countRules(text))}`);
  } catch (err) {
    console.warn('[Mail Layout] could not save rules', err);
    setStatus(
      'not saved - Safari reported a Disk I/O error. Your text is still here; try Save again.',
      true,
    );
  }
}

document.getElementById('save').addEventListener('click', save);

// Same three messages the manifest commands send through the service worker,
// for anyone who would rather click than remember a combination - and for
// Safari, where the shortcut field starts empty until the user records one.
async function send(type, { commitRules = false } = {}) {
  if (commitRules && area.value !== savedText) {
    // Saving first matters for the picker: it appends to what is already in
    // storage, so unsaved edits here would be overwritten by the new rule.
    // If Safari refuses the write, do not open the picker - it would append
    // to the stale text on disk and lose these edits.
    try {
      await writeStoredRules(area.value);
      savedText = area.value;
    } catch (err) {
      console.warn('[Mail Layout] could not commit rules before picking', err);
      setStatus(
        'not saved - Safari reported a Disk I/O error. Try again before picking.',
        true,
      );
      return;
    }
  }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || '')) {
    setStatus('open a Gmail tab first, then try again');
    return;
  }
  try {
    await api.tabs.sendMessage(tab.id, { type });
    window.close();
  } catch {
    setStatus('no response from Gmail - reload the tab and try again');
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
  setStatus(describe(countRules(area.value)));
});

load();
