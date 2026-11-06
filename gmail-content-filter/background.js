/*
  Gmail Content Filter - service worker.

  Only seeds the default rules on install and mirrors them into storage so the
  popup has something to show before the first save. Hiding itself happens in
  content.js, because the rules have to be re-applied every time Gmail rebuilds
  the thread.

  It also relays the manifest "commands" shortcuts. Those are the only ones the
  user can rebind - Safari lists them under Settings > Extensions > Mail Layout
  > Shortcuts, and Chrome under chrome://extensions/shortcuts - and they work
  whatever has focus, whereas the in-page keys only reach Gmail when Gmail is
  focused. The shortcut lives here and the behaviour lives there, so this just
  forwards the name.
*/

const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULTS = [
  'att: Invoice.pdf',
  'hide: Please see attached',
  'from: @updates.example',
].join('\n');

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get('rules');
  if (stored.rules === undefined) {
    await api.storage.local.set({ rules: DEFAULTS });
  }
});

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (name) => {
    if (!['pick', 'edit', 'peek'].includes(name)) return;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || '')) return;
    try {
      await api.tabs.sendMessage(tab.id, { type: `gh:${name}` });
    } catch {
      /* no content script in this tab yet - it needs a reload */
    }
  });
}
