/*
  Gmail Content Filter - content script.

  Rules, one per line, edited from the toolbar popup:

      att: LENTERIA LEDGER.pdf        hide the attachment card
      hide: Please see attached       remove the whole block carrying the phrase
      redact: 4419-0021               bar over the words, keep the layout
      css: div.aQH                    hide everything matching a selector
      from: @updates.example          every message from that address or domain

  # begins a comment.

  Inside Gmail: Control-Option-H picks something to hide, Control-Option-E
  picks something to edit, Control-Option-V shows everything the rules have
  hidden (press it again, or click the red marker, to hide it again), and E
  while picking switches the click between the two. The same three
  combinations are declared in the manifest as commands, so Safari
  Settings > Extensions > Mail Layout > Shortcuts lists them and lets them be
  rebound.

  WHY PHRASES AND NOT SELECTORS. Gmail rebuilds the thread DOM on every refresh,
  label change and thread switch, and reissues ids like ":1ad" and ":1af" each
  time. Those ids are therefore worthless as anchors - the visible text is the
  only thing that survives. Gmail does sanitise received HTML, but it preserves
  <font>, <span class="gmail_default"> and inline styles exactly as sent, and
  gives none of them a stable class, so text is the only handle available.

  WHY OWNERSHIP TAGS. This runs in every frame, and the top frame also reaches
  into the message-body iframes. Both can therefore touch the same document, so
  each marks what it hid and only clears its own marks - otherwise the two
  passes would undo each other on every tick and the text would flicker.
*/

(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const KEY = 'rules';
  const ATTR = 'data-gh-hide';
  const PEEK = 'data-gh-peek';
  const BAR = 'gh-bar';
  const OWNER = window.top === window.self ? 't' : 'f';

  const DEFAULTS = [
    'att: LENTERIA LEDGER.pdf',
    'hide: Please see attached',
    'from: @updates.example',
    'css: div[data-card-id$=":kopisummary"]',
  ].join('\n');

  // Gmail stamps each AI Overview card with a per-message data-card-id, so the
  // exact id is gone on the next refresh. Match the stable suffix instead.
  // This is applied in addition to the saved rules, so the card stays hidden
  // even when Safari's storage is stale or the saved list was overwritten.
  const BUILTIN_CSS = ['div[data-card-id$=":kopisummary"]'];

  // Safari's extension storage is database backed and intermittently rejects
  // a read or a write with "Disk I/O error" (seen on Safari 18.5 and 26/27,
  // and reported by other extensions too). The failure is temporary, so every
  // access is retried instead of being treated as "nothing saved" - that old
  // fallback is what made saved rules silently disappear from the page.
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

  const STYLE_TEXT =
    `[${ATTR}] { display: none !important; }`
    + `.${BAR} { background:#202124; color:transparent; border-radius:2px;`
    + ` user-select:none; -webkit-user-select:none; }`
    + `.gh-peek { position:fixed; z-index:2147483646; pointer-events:none;`
    + ` border:2px solid #1a73e8; background:rgba(26,115,232,.12); border-radius:3px;`
    + ` outline:1px solid rgba(255,255,255,.6); }`
    + `.gh-tag { position:fixed; z-index:2147483647; pointer-events:none;`
    + ` background:#1a73e8; color:#fff; border-radius:3px; padding:2px 6px;`
    + ` font:11px/1.3 ui-monospace,Menlo,monospace; max-width:520px;`
    + ` overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`
    + `.gh-banner { position:fixed; top:12px; left:50%; transform:translateX(-50%);`
    + ` z-index:2147483647; background:#202124; color:#fff; border-radius:20px;`
    + ` padding:8px 18px; font:13px/1.4 -apple-system,sans-serif;`
    + ` box-shadow:0 4px 16px rgba(0,0,0,.35); }`
    + `.gh-flag { position:fixed; bottom:14px; left:14px; z-index:2147483647;`
    + ` cursor:pointer; background:#b31e00; color:#fff; border-radius:14px;`
    + ` padding:5px 14px; font:12px/1.4 -apple-system,sans-serif;`
    + ` box-shadow:0 2px 10px rgba(0,0,0,.3); }`
    + `.gh-edit { outline:2px dashed #1a73e8 !important; outline-offset:2px;`
    + ` background:rgba(26,115,232,.06); }`
    + `.gh-dlg { position:fixed; top:96px; right:24px; z-index:2147483647; width:460px;`
    + ` background:#fff; color:#202124; border:1px solid #dadce0; border-radius:8px;`
    + ` box-shadow:0 8px 24px rgba(0,0,0,.25); padding:14px;`
    + ` font:13px/1.5 -apple-system,sans-serif; }`
    + `.gh-dlg textarea { box-sizing:border-box; width:100%; height:64px;`
    + ` font:12px/1.4 ui-monospace,Menlo,monospace; margin:6px 0 10px;`
    + ` border:1px solid #dadce0; border-radius:5px; padding:6px; }`
    + `.gh-dlg input[type="text"] { box-sizing:border-box; width:100%;`
    + ` font:12px/1.4 ui-monospace,Menlo,monospace; margin:6px 0 10px;`
    + ` border:1px solid #dadce0; border-radius:5px; padding:6px; }`
    + `.gh-dlg button { margin-right:8px; }`
    + `.gh-dlg .gh-muted { margin:0 0 10px; color:#5f6368; font-size:12px; }`
    + `.gh-dlg label { display:block; margin-bottom:4px; }`;

  // ------------------------------------------------------------------ rules

  let RULES = { att: [], hide: [], redact: [], css: [], from: [] };
  let RULES_TEXT = '';
  let rulesLoaded = false;

  function parse(text) {
    const out = { att: [], hide: [], redact: [], css: [], from: [] };
    for (const line of (text || '').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf(':');
      if (i < 1) continue;
      const kind = t.slice(0, i).trim().toLowerCase();
      const value = t.slice(i + 1).trim();
      if (value && out[kind]) out[kind].push(value);
    }
    return out;
  }

  let rulesRetry = null;

  async function loadRules() {
    try {
      const stored = await readStoredRules();
      RULES_TEXT = stored[KEY] === undefined ? DEFAULTS : String(stored[KEY]);
      RULES = parse(RULES_TEXT);
      rulesLoaded = true;
      apply();
      watchFrames();
      return true;
    } catch (err) {
      // Keep the rules already in memory. Substituting DEFAULTS here would
      // make every hidden element reappear just because one read failed.
      console.warn('[Mail Layout] could not read rules; retrying', err);
      if (!rulesRetry) {
        rulesRetry = setTimeout(() => {
          rulesRetry = null;
          loadRules();
        }, 4000);
      }
      return false;
    }
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Whitespace in Gmail HTML is unpredictable: &nbsp;, soft breaks, words split
  // across runs. A phrase compiles to "word \s+ word" rather than being
  // compared literally, which is what makes the rules survive re-renders.
  function looseRe(phrase, flags) {
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return /(?!)/;
    return new RegExp(words.map(escapeRe).join('\\s+'), flags || 'i');
  }

  // --------------------------------------------------------------- documents

  // The message body is a srcdoc iframe: same origin, so reachable from the
  // top frame via contentDocument. Reaching it this way means body-content
  // rules still work in a build where per-frame injection does not fire.
  function documents() {
    const docs = [];
    const seen = new Set();
    const walk = (doc) => {
      if (!doc || !doc.documentElement || seen.has(doc)) return;
      seen.add(doc);
      docs.push(doc);
      let frames = [];
      try {
        frames = doc.querySelectorAll('iframe');
      } catch {
        frames = [];
      }
      for (const frame of frames) {
        let inner = null;
        try {
          inner = frame.contentDocument;
        } catch {
          inner = null;
        }
        walk(inner);
      }
    };
    walk(document);
    return docs;
  }

  function paintStyle(doc) {
    if (doc.querySelector('style[data-gh]')) return;
    const host = doc.head || doc.documentElement;
    if (!host) return;
    const s = doc.createElement('style');
    s.setAttribute('data-gh', '');
    s.textContent = STYLE_TEXT;
    host.appendChild(s);
  }

  const owns = (el) => el.getAttribute(ATTR) === OWNER;
  const hide = (el) => el.setAttribute(ATTR, OWNER);

  // -------------------------------------------------------------- text rules

  function textNodes(doc) {
    if (!doc.body) return [];
    const out = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeValue && n.nodeValue.trim()) out.push(n);
    }
    return out;
  }

  // Climb only while the ancestor adds no other text, and stop at the message
  // container. Without the stop, a one-line email would hide its own bubble,
  // and climbing into the body wrapper would blank the entire message.
  function smallestBlock(node) {
    let el = node.parentElement;
    if (!el) return null;
    const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
    for (let depth = 0; depth < 8 && el.parentElement; depth += 1) {
      const parent = el.parentElement;
      if (parent.matches('[role="article"], .adn, .a3s, .gmail_quote, body')) break;
      if (flat(parent.textContent) !== flat(el.textContent)) break;
      el = parent;
    }
    return el;
  }

  function runHide(doc, phrases) {
    const nodes = textNodes(doc);
    for (const phrase of phrases) {
      const re = looseRe(phrase);
      for (const node of nodes) {
        if (!re.test(node.nodeValue)) continue;
        const block = smallestBlock(node);
        if (block) hide(block);
      }
    }
  }

  function runRedact(doc, phrases) {
    const nodes = textNodes(doc);
    for (const phrase of phrases) {
      const re = looseRe(phrase, 'gi');
      for (const node of nodes) {
        if (!node.parentNode) continue;
        re.lastIndex = 0;
        if (!re.test(node.nodeValue)) continue;

        const frag = doc.createDocumentFragment();
        let last = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(node.nodeValue)) !== null) {
          frag.appendChild(doc.createTextNode(node.nodeValue.slice(last, m.index)));
          const bar = doc.createElement('span');
          bar.className = BAR;
          bar.dataset.ghBy = OWNER;
          bar.dataset.raw = m[0];
          bar.textContent = '#'.repeat(Math.min(Math.max(m[0].length, 4), 28));
          frag.appendChild(bar);
          last = m.index + m[0].length;
          if (m[0].length === 0) re.lastIndex += 1;
        }
        frag.appendChild(doc.createTextNode(node.nodeValue.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  function restoreBars(doc) {
    let bars = [];
    try {
      bars = doc.querySelectorAll(`.${BAR}[data-gh-by="${OWNER}"]`);
    } catch {
      return;
    }
    for (const bar of bars) {
      const parent = bar.parentNode;
      if (!parent) continue;
      parent.replaceChild(doc.createTextNode(bar.dataset.raw || ''), bar);
      parent.normalize();
    }
  }

  // ------------------------------------------------------------ attachments

  const CARD = 'div.aQH';
  const SECTION = 'div.hq';
  // The inbox row chip is a different component from the open-message card.
  // data-is-smartmail + title are attributes Gmail has kept across redesigns,
  // while .brc/.brd are obfuscated class names that will not survive the next
  // one, so the attributes lead and the classes are the fallback.
  const CHIP = 'div[data-is-smartmail], div.brc[title]';
  const CHIP_ROW = 'div.brd';

  function runAttachments(list) {
    const cards = new Set();
    const hits = document.querySelectorAll(
      'a[href*="view=att"], img[src*="view=snatt"], span.aV3, ' + CARD
    );
    for (const el of hits) {
      const card = el.closest(CARD);
      if (card) cards.add(card);
    }

    const hidden = new Set();
    if (list.length) {
      for (const card of cards) {
        const labels = [...card.querySelectorAll('[aria-label]')]
          .map((n) => n.getAttribute('aria-label')).join(' ');
        const hay = `${card.textContent} ${labels}`;
        if (list.some((name) => looseRe(name).test(hay))) hidden.add(card);
      }
    }
    for (const card of hidden) hide(card);

    // If nothing in the section survives, hide the section too. Otherwise
    // "One attachment - Scanned by Gmail" and the "Added to Drive" chip remain
    // behind and announce that something was taken out.
    for (const section of document.querySelectorAll(SECTION)) {
      const inner = [...section.querySelectorAll(CARD)];
      if (inner.length && inner.every((c) => hidden.has(c))) hide(section);
    }

    // The bulk control would hand the file straight back.
    for (const el of byTextLoose(document, 'Download all attachments')) {
      const scope = el.closest('div[role="article"]') || el.parentElement;
      const inner = scope ? [...scope.querySelectorAll(CARD)] : [];
      if (inner.length && inner.every((c) => hidden.has(c))) hide(el);
    }
  }

  // Inbox rows: "Attachment: LENTERIA LEDGER.pdf" chips, which the card pass
  // above never sees because a collapsed conversation has no card.
  function runListChips(list) {
    if (!list.length) return;
    const rows = new Map();

    for (const chip of document.querySelectorAll(CHIP)) {
      const labels = [...chip.querySelectorAll('[aria-label]')]
        .map((n) => n.getAttribute('aria-label')).join(' ');
      const hay = `${chip.getAttribute('title') || ''} ${chip.textContent} ${labels}`;
      const matched = list.some((name) => looseRe(name).test(hay));
      if (matched) hide(chip);

      const row = chip.closest(CHIP_ROW) || chip.parentElement;
      if (!row) continue;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(matched);
    }

    // A row holding several attachments only goes entirely if every chip in it
    // matched; otherwise one blank gap would advertise the others.
    for (const [row, results] of rows) {
      if (results.every(Boolean)) hide(row);
    }
  }

  // ---------------------------------------------------------------- senders

  // A message names its sender in attributes Gmail has kept for years:
  // span[email] in the conversation list, [data-sender] in an open header.
  // Those are the anchors, not the row classes. A mailto: link is deliberately
  // not one of them: it appears in signatures and unsubscribe lines, where it
  // names someone who is not writing to you.
  //
  // This runs only over the top document on purpose. A quoted reply or a
  // signature inside the message body carries the same address, and matching
  // there would hide a piece of the email instead of the email.
  const ADDRESS = '[email], [data-sender]';
  const ADDRESS_HINT = '[email], [data-sender], a[href^="mailto:"]';
  // role=article is one whole message. The header wrapper sits inside it, and
  // closest() returns the nearest match, so the two cannot share a selector -
  // matching them together would hide the sender line and leave the body.
  const ARTICLE = '[role="article"]';
  const HEADER = '.adn';
  const ROW = 'tr, [role="listitem"], div.zA, div.zbw, div[data-uniqueid]';

  // A bare domain gets a boundary, so @homecredit.ph cannot also claim
  // @homecredit.ph.spoof.example. A * in the rule is a wildcard.
  function fromRe(value) {
    const body = value.split('*').map(escapeRe).join('[^\\s]*');
    const tail = value.startsWith('@') ? '(?![\\w.\\-])' : '';
    return new RegExp(`${body}${tail}`, 'i');
  }

  function addressOf(el) {
    const href = (el.getAttribute('href') || '').replace(/^mailto:/i, '');
    return (el.getAttribute('email') || el.getAttribute('data-sender')
      || href.split('?')[0] || '').trim();
  }

  function messageScope(el) {
    // The article wins over the row: in an open thread each message is its own
    // bubble, and a stray tr in the header table would hide one line of it.
    const msg = el.closest(ARTICLE);
    if (msg) return msg;
    const row = el.closest(ROW);
    if (row) return row.closest('tr') || row;
    // Comfortable density nests the row div inside a tr; stopping at the div
    // would leave a blank strip that still looks and clicks like a message.
    const head = el.closest(HEADER);
    if (head) return head;
    return el.parentElement;
  }

  function runFrom(list) {
    const patterns = list.map(fromRe);
    for (const el of document.querySelectorAll(ADDRESS)) {
      const hay = [
        addressOf(el),
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        (el.children.length ? '' : el.textContent || ''),
      ].join(' ').trim();
      if (!hay || !patterns.some((re) => re.test(hay))) continue;
      const scope = messageScope(el);
      if (!scope || scope === document.body || scope === document.documentElement) continue;
      hide(scope);
    }
  }

  // The sender of the message an element belongs to, or null when it is not
  // part of one. Searching a loose element's own subtree would offer the first
  // sender on the page as though it were the one under the cursor.
  function senderOf(el) {
    const scope = el.closest(`${ROW}, ${ARTICLE}, ${HEADER}`);
    if (scope) {
      const hit = scope.matches(ADDRESS_HINT) ? scope : scope.querySelector(ADDRESS_HINT);
      if (hit && addressOf(hit)) return hit;
    }
    const near = el.matches(ADDRESS_HINT) ? el : el.closest(ADDRESS_HINT);
    return near && addressOf(near) ? near : null;
  }

  function byTextLoose(doc, phrase) {
    const out = [];
    const re = looseRe(phrase);
    try {
      const first = JSON.stringify(phrase.trim().split(/\s+/)[0]);
      const path = `//*[self::a or self::span][contains(normalize-space(.), ${first})]`;
      const it = doc.evaluate(path, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < it.snapshotLength; i += 1) {
        const el = it.snapshotItem(i);
        if (re.test(el.textContent)) out.push(el);
      }
    } catch {
      /* XPath unavailable */
    }
    return out;
  }

  function runCss(doc, selectors) {
    for (const sel of selectors) {
      try {
        doc.querySelectorAll(sel).forEach(hide);
      } catch {
        /* ignore a selector this document rejects */
      }
    }
  }

  // ------------------------------------------------------------------ driver

  // Revealing is done by not hiding, never by overriding display: the elements
  // Gmail gives us are inline-block, table cells and flex children, and a
  // blanket "display:block !important" would bring them back in the wrong
  // shape. The rules stay loaded and re-applied the moment peeking ends.
  //
  // The state is written into every reachable document rather than kept in a
  // variable, because the message-body iframes run their own copy of this
  // script and would otherwise keep hiding while the inbox was revealed. The
  // attribute is what they check.
  let peekFlag = null;

  const isPeeked = (doc) => doc.documentElement
    && doc.documentElement.hasAttribute(PEEK);

  // Gmail owns document.body and prunes it freely, so the marker is checked on
  // every pass rather than assumed to still be there.
  function ensureFlag() {
    if (!document.body) return;
    if (peekFlag && peekFlag.isConnected) return;
    if (peekFlag) peekFlag.remove();
    peekFlag = document.createElement('div');
    peekFlag.className = 'gh-flag';
    peekFlag.textContent
      = 'hidden content is visible  ·  Control-Option-V or click to hide it again';
    peekFlag.title = 'Hide it again';
    peekFlag.addEventListener('click', () => setPeek(false));
    document.body.appendChild(peekFlag);
  }

  function setPeek(on) {
    for (const doc of documents()) {
      if (!doc.documentElement) continue;
      if (on) doc.documentElement.setAttribute(PEEK, '1');
      else doc.documentElement.removeAttribute(PEEK);
    }
    if (on) {
      ensureFlag();
    } else if (peekFlag) {
      peekFlag.remove();
      peekFlag = null;
    }
    apply();
  }

  function apply() {
    const r = RULES;
    const docs = documents();

    // Clear, then repaint. This is one synchronous task, so nothing paints
    // in between and editing the rules does not strobe the page.
    for (const doc of docs) {
      paintStyle(doc);
      try {
        doc.querySelectorAll(`[${ATTR}="${OWNER}"]`)
          .forEach((el) => el.removeAttribute(ATTR));
      } catch { /* detached document */ }
      restoreBars(doc);
    }

    if (isPeeked(document)) {
      if (OWNER === 't') ensureFlag();
      return;
    }

    const empty = !r.att.length && !r.hide.length && !r.redact.length
      && !r.css.length && !r.from.length;
    if (empty && !BUILTIN_CSS.length) return;

    for (const doc of docs) {
      if (r.hide.length) runHide(doc, r.hide);
      if (r.redact.length) runRedact(doc, r.redact);
      if (r.css.length) runCss(doc, r.css);
      if (BUILTIN_CSS.length) runCss(doc, BUILTIN_CSS);
    }
    if (OWNER === 't') {
      if (r.from.length) runFrom(r.from);
      if (r.att.length) {
        runAttachments(r.att);
        runListChips(r.att);
      }
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      apply();
      watchFrames();
    }, 300);
  }

  // A message body iframe appears only after the thread renders, and it is a
  // separate document, so its own later mutations need their own observer.
  let watched = new WeakSet();
  function watchFrames() {
    if (OWNER !== 't') return;
    // A message frame opened while peeking is on has no mark of its own yet.
    const revealing = isPeeked(document);
    for (const doc of documents()) {
      if (revealing && doc.documentElement) doc.documentElement.setAttribute(PEEK, '1');
      if (!doc.body || !doc.documentElement || watched.has(doc)) continue;
      watched.add(doc);
      new MutationObserver(schedule).observe(doc.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  // ---------------------------------------------------------------- picker

  // What makes a picked element worth saving. Gmail's class names (.brd, .aQH)
  // and its ids (":2i") are regenerated on every deploy, so a selector built
  // from either rots within weeks and fails silently. Candidates are ordered by
  // durability: a sender address when there is one, then a distinguishing
  // attribute, then the element's own visible words, and only last a structural
  // path.

  const SKIP_ATTRS = new Set(['class', 'style', 'jsname', 'jscontroller',
    'jsaction', 'jslog', 'data-idom-class', 'id']);

  const cssValue = (v) => `"${v.replace(/["\\]/g, '\\$&').replace(/\s+/g, ' ').trim()}"`;

  // A picked element is one element, so a proposed selector that also matches
  // six unrelated ones is not a candidate - it is a trap. Gmail is full of
  // attributes that look specific and are not: role="img", data-index="0",
  // href*="view=att" all hit every attachment in the thread.
  const MAX_MATCHES = 4;

  function matchCount(doc, sel) {
    try {
      return doc.querySelectorAll(sel).length;
    } catch {
      return -1;
    }
  }

  function attrSelector(el) {
    if (!el || el.nodeType !== 1 || !el.attributes) return null;
    const doc = el.ownerDocument || document;
    const tag = el.tagName.toLowerCase();
    for (const a of el.attributes) {
      if (SKIP_ATTRS.has(a.name)) continue;
      const useful = a.name.startsWith('data-') || a.name === 'title'
        || a.name === 'aria-label' || a.name === 'href' || a.name === 'src'
        || a.name === 'name';
      if (!useful || !a.value || a.value.length > 90) continue;

      let sel;
      if (a.name === 'href' || a.name === 'src') {
        // Gmail's attachment URLs carry per-session ik/th tokens, so match on
        // the parameter that identifies the kind of thing, not the whole URL.
        const marker = a.value.match(/[?&](view|disp|ui)=([^&]+)/);
        sel = marker
          ? `[${a.name}*=${cssValue(marker[0].slice(1))}]`
          : `[${a.name}*=${cssValue(a.value.slice(0, 60))}]`;
      } else {
        sel = `[${a.name}=${cssValue(a.value)}]`;
      }

      const count = matchCount(doc, `${tag}${sel}`);
      if (count > 0 && count <= MAX_MATCHES) return sel;
    }
    return null;
  }

  function pathSelector(el) {
    const doc = el.ownerDocument || document;
    const parts = [];
    let node = el;
    for (let hop = 0; hop < 4 && node && node.nodeType === 1; hop += 1) {
      const attr = attrSelector(node);
      if (attr) {
        parts.unshift(`${node.tagName.toLowerCase()}${attr}`);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(node.tagName.toLowerCase());
        break;
      }
      const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
      const index = [...parent.children].indexOf(node) + 1;
      parts.unshift(sameTag.length > 1
        ? `${node.tagName.toLowerCase()}:nth-child(${index})`
        : node.tagName.toLowerCase());
      node = parent;
    }
    const sel = parts.join(' > ');
    return matchCount(doc, sel) > MAX_MATCHES ? null : sel;
  }

  function candidates(el) {
    const out = [];

    // A sender is the one thing Gmail always labels with an address, so when
    // the picked element belongs to one, the durable rule is available and
    // goes first: the address itself, then the domain, which is broader.
    const sender = senderOf(el);
    const address = sender ? addressOf(sender) : '';
    if (address.includes('@')) {
      out.push({ kind: 'from', value: address });
      const domain = `@${address.split('@').pop()}`;
      if (address !== domain) out.push({ kind: 'from', value: domain });
    }

    const attr = attrSelector(el);
    const sel = attr ? `${el.tagName.toLowerCase()}${attr}` : pathSelector(el);
    if (sel && sel.length < 200) out.push({ kind: 'css', value: sel });

    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 3) {
      const phrase = text.length > 58 ? text.slice(0, 58).trim() : text;
      out.push({ kind: 'hide', value: phrase });
      if (text.length <= 76) out.push({ kind: 'redact', value: phrase });
    }
    return out;
  }

  let picking = false;
  let pickMode = 'hide';
  let depth = 0;
  let rawTarget = null;
  let hoverEl = null;
  let pickerBanner = null;
  const pickerOff = [];

  const HINT = {
    hide: 'Hover the thing to hide  ·  click to choose  ·  ↑ ↓ change scope'
      + '  ·  E edit instead  ·  Esc cancel',
    edit: 'EDIT MODE  ·  hover the thing to change  ·  click to open its fields'
      + '  ·  ↑ ↓ change scope  ·  E hide instead  ·  Esc cancel',
  };

  const climb = (el, levels) => {
    let node = el;
    for (let i = 0; i < levels && node && node.parentElement; i += 1) node = node.parentElement;
    return node;
  };

  function preview(doc) {
    if (!hoverEl || !hoverEl.isConnected) return;
    const rect = hoverEl.getBoundingClientRect();
    boxIn(doc, 'gh-peek', rect);
    const text = (hoverEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 46);
    boxIn(doc, 'gh-tag', {
      left: rect.left, top: Math.max(0, rect.top - 20), width: 'auto', height: 'auto',
    }, `${hoverEl.tagName.toLowerCase()}  ${text}`);
  }

  function boxIn(doc, cls, rect, label) {
    let box = doc.querySelector(`.${cls}`);
    if (!box) {
      box = doc.createElement('div');
      box.className = cls;
      doc.body.appendChild(box);
    }
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${Math.max(rect.width, 2)}px`;
    box.style.height = `${Math.max(rect.height, 2)}px`;
    if (label !== undefined) box.textContent = label;
    return box;
  }

  function choose(el) {
    const mode = pickMode;
    endPicker();
    if (mode === 'edit') openEditDialog(el); else openRuleDialog(el);
  }

  function installPicker(doc) {
    paintStyle(doc);
    if (!doc.body) return;
    const view = doc.defaultView || window;

    const onMove = (ev) => {
      const t = ev.target;
      if (!t || (t.closest && t.closest('.gh-peek,.gh-tag,.gh-banner,.gh-dlg'))) return;
      rawTarget = t.nodeType === 1 ? t : t.parentElement;
      if (!rawTarget) return;
      hoverEl = climb(rawTarget, depth);
      preview(doc);
    };

    // Blocks selection and drag while picking. Named, and removed on teardown:
    // a leftover preventDefault on mousedown would silently break every click
    // in Gmail for the rest of the session.
    const onDown = (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.gh-dlg')) return;
      ev.preventDefault();
    };

    const onClick = (ev) => {
      const t = ev.target;
      if (t && t.closest && t.closest('.gh-dlg')) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const chosen = hoverEl || rawTarget;
      if (chosen) choose(chosen);
    };

    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        endPicker();
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        depth = ev.key === 'ArrowUp' ? depth + 1 : Math.max(0, depth - 1);
        if (rawTarget) {
          hoverEl = climb(rawTarget, depth);
          preview(doc);
        }
      } else if (ev.key.toLowerCase() === 'e' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        pickMode = pickMode === 'hide' ? 'edit' : 'hide';
        if (pickerBanner) pickerBanner.textContent = HINT[pickMode];
      } else if (ev.key === 'Enter' && hoverEl) {
        ev.preventDefault();
        choose(hoverEl);
      }
    };

    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('click', onClick, true);
    view.addEventListener('keydown', onKey, true);

    pickerOff.push(() => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('click', onClick, true);
      view.removeEventListener('keydown', onKey, true);
      for (const cls of ['gh-peek', 'gh-tag']) {
        doc.querySelectorAll(`.${cls}`).forEach((n) => n.remove());
      }
    });
  }

  function startPicker(mode) {
    if (picking) return;
    stopEditing();
    picking = true;
    pickMode = mode === 'edit' ? 'edit' : 'hide';
    depth = 0;
    rawTarget = null;
    hoverEl = null;

    // Every accessible document, so an element inside a message body iframe is
    // just as pickable as one in the inbox list.
    for (const doc of documents()) installPicker(doc);

    const banner = document.createElement('div');
    banner.className = 'gh-banner';
    banner.textContent = HINT[pickMode];
    document.body.appendChild(banner);
    pickerBanner = banner;
    pickerOff.push(() => {
      banner.remove();
      if (pickerBanner === banner) pickerBanner = null;
    });
  }

  function endPicker() {
    if (!picking) return;
    picking = false;
    while (pickerOff.length) {
      try {
        pickerOff.pop()();
      } catch { /* frame already gone */ }
    }
    hoverEl = null;
    rawTarget = null;
  }

  async function appendRule(line) {
    const hadRules = rulesLoaded;
    let text = RULES_TEXT;
    try {
      const stored = await readStoredRules();
      text = stored[KEY] === undefined ? DEFAULTS : String(stored[KEY]);
      RULES_TEXT = text;
      rulesLoaded = true;
    } catch (err) {
      // A failed read must not cost the user the line: fall back to the copy
      // already in memory and let the write attempt do its best.
      console.warn('[Mail Layout] could not read rules before appending', err);
    }

    const existing = text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (existing.includes(line.trim())) return true;

    const next = `${text.replace(/\s+$/, '')}\n${line}`;
    // Apply before persisting: the element disappears now even if Safari
    // refuses the write for a moment.
    RULES_TEXT = next;
    RULES = parse(next);
    apply();

    // Never write a guess over rules that were never read. Doing so could
    // replace the real list with DEFAULTS plus this one line.
    if (!hadRules && !rulesLoaded) return false;

    try {
      await writeStoredRules(next);
      return true;
    } catch (err) {
      console.warn('[Mail Layout] could not save the new rule', err);
      return false;
    }
  }

  function openRuleDialog(el) {
    document.querySelectorAll('.gh-dlg').forEach((n) => n.remove());

    const opts = candidates(el);
    if (!opts.length) return;

    const dlg = document.createElement('div');
    dlg.className = 'gh-dlg';

    const title = document.createElement('b');
    title.textContent = 'Hide this element';

    const note = document.createElement('p');
    note.style.cssText = 'margin:6px 0 10px;color:#5f6368';
    note.textContent = 'Choose how it is matched. Attributes and visible words survive a Gmail redesign; a class-based selector usually does not.';

    const input = document.createElement('textarea');
    input.value = `${opts[0].kind}: ${opts[0].value}`;

    const list = document.createElement('div');
    opts.forEach((opt, i) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gh-rule';
      radio.value = `${opt.kind}: ${opt.value}`;
      radio.checked = i === 0;
      const span = document.createElement('span');
      span.style.cssText = 'font:12px ui-monospace,Menlo,monospace';
      span.textContent = `  ${opt.kind}: ${opt.value}`;
      radio.addEventListener('change', () => { input.value = radio.value; });
      label.append(radio, span);
      list.appendChild(label);
    });

    const status = document.createElement('p');
    status.style.cssText = 'margin:0 0 8px;color:#5f6368;font-size:12px;min-height:14px';

    const save = document.createElement('button');
    save.textContent = 'Hide it';
    save.onclick = async () => {
      const line = input.value.trim();
      if (!/^(att|hide|redact|css|from):/i.test(line)) {
        status.textContent = 'A rule must start with att:, hide:, redact:, css: or from:';
        return;
      }
      try {
        const saved = await appendRule(line);
        status.textContent = saved
          ? 'saved'
          : 'hidden now, but Safari would not save it (disk error). Try again before reloading.';
        if (saved) setTimeout(() => dlg.remove(), 350);
      } catch {
        status.textContent = 'Could not save the rule. Try again.';
      }
      apply();
    };

    // Same element, different intent: reach for this when the text is wrong
    // rather than unwanted, since a rule cannot fix a typo.
    const edit = document.createElement('button');
    edit.textContent = 'Edit it';
    edit.onclick = () => {
      dlg.remove();
      openEditDialog(el);
    };

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => dlg.remove();

    const row = document.createElement('div');
    row.append(save, edit, cancel);

    dlg.append(title, note, list, input, status, row);
    document.body.appendChild(dlg);
    input.focus();
  }

  // ------------------------------------------------------------------ editor

  // A rule is durable and this is not: writing here changes the document Gmail
  // has rendered right now, and the next thread switch or refresh rebuilds it
  // back. That is still the fastest way to fix a wrong word, a date or a colour
  // in a message you only need to read correctly once.

  let editingEl = null;

  function stopEditing() {
    if (!editingEl) return;
    const doc = editingEl.ownerDocument || document;
    editingEl.removeAttribute('contenteditable');
    editingEl.classList.remove('gh-edit');
    // The picked node usually lives in a message-body iframe, so the top
    // document's activeElement is that frame element, not the text being edited.
    const focused = doc.activeElement;
    if (focused && (focused === editingEl || editingEl.contains(focused))) {
      editingEl.blur();
    }
    editingEl = null;
  }

  // textContent can only be written into a node that holds nothing but text;
  // on a wrapper it would take the markup inside it with it. Our own redaction
  // bars are not a destination either - a block whose only children are bars is
  // still one run of text as far as editing goes, since writing replaces them.
  function editTarget(el) {
    const bars = [...el.children].filter((n) => n.classList.contains(BAR));
    if (!el.children.length || bars.length === el.children.length) {
      return { node: el, writable: true };
    }
    const leaf = [...el.querySelectorAll('span, b, i, u, font, a, p, div, li, td')]
      .find((n) => !n.children.length && !n.classList.contains(BAR)
        && (n.textContent || '').trim().length > 1);
    return leaf ? { node: leaf, writable: true } : { node: el, writable: false };
  }

  // The '#' bars are not the message's text either. Reading a redacted run back
  // through the original keeps the field showing what the sender wrote rather
  // than what we painted over it.
  function readText(el) {
    if (el.classList.contains(BAR)) return el.dataset.raw || '';
    if (!el.querySelector(`.${BAR}[data-raw]`)) return (el.textContent || '').trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`.${BAR}[data-raw]`).forEach((b) => {
      b.textContent = '';
      b.appendChild(el.ownerDocument.createTextNode(b.dataset.raw));
    });
    return (clone.textContent || '').trim();
  }

  function field(caption, control) {
    const label = document.createElement('label');
    const cap = document.createElement('span');
    cap.textContent = caption;
    label.append(cap, control);
    return label;
  }

  function openEditDialog(el) {
    document.querySelectorAll('.gh-dlg').forEach((n) => n.remove());
    stopEditing();

    const { node: target, writable } = editTarget(el);

    const dlg = document.createElement('div');
    dlg.className = 'gh-dlg';

    const title = document.createElement('b');
    title.textContent = 'Edit this element';

    const note = document.createElement('p');
    note.className = 'gh-muted';
    note.textContent = 'Applies to the message as it is on screen. Nothing is saved, and a Gmail rebuild puts the original back.';

    const where = document.createElement('p');
    where.className = 'gh-muted';
    where.textContent = `text and style go on <${target.tagName.toLowerCase()}>`
      + (target === el ? '' : '  ·  ↑ ↓ before clicking to choose another node');

    const text = document.createElement('textarea');
    text.value = readText(target);
    if (writable) {
      text.placeholder = 'the words as they should read';
    } else {
      text.disabled = true;
      text.placeholder = 'this element holds other markup - use "Edit in place"';
    }

    const style = document.createElement('input');
    style.type = 'text';
    style.placeholder = 'color:#d93025; font-weight:bold';
    style.value = target.style.cssText;

    const status = document.createElement('p');
    status.className = 'gh-muted';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.onclick = () => {
      // Whatever was typed directly into the message wins over this field,
      // which has not been refreshed while the page itself was being edited.
      if (editingEl === target) text.value = readText(target);
      else if (writable) {
        target.textContent = text.value;
        // Rewriting a redacted run makes it an ordinary element again; leaving
        // the bar class on would keep the new words invisible under the block.
        target.classList.remove(BAR);
      }
      target.style.cssText = style.value.trim();
      stopEditing();
      status.textContent = 'applied to this render only';
      setTimeout(() => dlg.remove(), 900);
    };

    const live = document.createElement('button');
    live.textContent = 'Edit in place';
    live.onclick = () => {
      stopEditing();
      editingEl = target;
      target.setAttribute('contenteditable', 'true');
      target.classList.add('gh-edit');
      target.focus();
      status.textContent = 'type in the message  ·  Apply or Cancel finishes';
    };

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => {
      stopEditing();
      dlg.remove();
    };

    const row = document.createElement('div');
    row.append(applyBtn, live, cancel);

    dlg.append(title, note, where,
      field('Text', text), field('Inline style', style), status, row);
    document.body.appendChild(dlg);
    (writable ? text : style).focus();
  }

  // Only the top frame answers. It reaches into the message-body iframes
  // itself, so the picker works there too and its dialog stays in the main
  // window instead of being clipped inside a small frame, and letting every
  // frame reply would install the listeners twice.
  //
  // A shortcut can also arrive from the browser's own command handler, which
  // is how a key rebound in Safari Settings or chrome://extensions/shortcuts
  // reaches the page. On a browser that fires the command and still lets the
  // page see the keydown, both paths would toggle the same action twice, so
  // the keydown ignores what has just come through as a command.
  let fromCommand = 0;

  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (OWNER !== 't' || !msg || !msg.type) return false;
    if (msg.type === 'gh:pick' || msg.type === 'gh:edit') {
      fromCommand = Date.now();
      startPicker(msg.type === 'gh:edit' ? 'edit' : 'hide');
      respond({ ok: true });
    } else if (msg.type === 'gh:peek') {
      fromCommand = Date.now();
      setPeek(!isPeeked(document));
      respond({ ok: true });
    }
    return false;
  });

  // Safari only shows the popup if the extension tile has been dragged into the
  // toolbar, and that is easy to lose. The picker, the editor and the reveal
  // toggle are the things worth reaching for, so all three work from a key
  // inside Gmail itself, without any browser setting at all.
  //
  // The same three are declared as manifest commands, which is what puts them
  // in Safari Settings > Extensions > Mail Layout > Shortcuts and lets the
  // combinations be rebound. The in-page listener stays because that command
  // path is the newer and less certain one - Safari only gained the shortcut
  // settings in version 26, and a command that has not been recorded in that
  // pane may never fire - and because a command has to come back through the
  // service worker round trip above before anything happens on the page.
  //
  // Control-Option, not Command: macOS and Safari claim the Command and
  // Command-Shift combinations long before the page ever sees the keydown, so
  // a Command-based trigger silently opens some system window instead.
  //
  // ev.code, not the letter in ev.key: Option composes these very keys into
  // characters (⌥H is "Á", ⌥V is "√"), so testing ev.key === 'h' never fires,
  // and a different keyboard layout would move the letter anyway. code stays
  // "KeyH" whatever the modifier or layout does to the character.
  const hotKey = (ev, code, letter) => ev.ctrlKey && ev.altKey && !ev.metaKey
    && (ev.code === code || (ev.key || '').toLowerCase() === letter);

  function hotAction(ev) {
    if (hotKey(ev, 'KeyH', 'h')) return 'pick';
    if (hotKey(ev, 'KeyE', 'e')) return 'edit';
    if (hotKey(ev, 'KeyV', 'v')) return 'peek';
    return null;
  }

  function onHotkey(ev) {
    const action = hotAction(ev);
    if (!action || Date.now() - fromCommand < 500) return;
    ev.preventDefault();

    if (OWNER !== 't') {
      // Only the top frame can mark every document or lay a picker over all
      // of them, so a frame forwards what it cannot serve. Message bodies and
      // compose windows are same-origin srcdoc frames, so the combination can
      // be re-dispatched on the top window - which is what makes the keys work
      // with the caret inside a message instead of in the list.
      try {
        const top = window.top;
        top.dispatchEvent(new top.KeyboardEvent('keydown', {
          key: ev.key, code: ev.code, ctrlKey: true, altKey: true, bubbles: true,
        }));
      } catch { /* a frame that is not same-origin after all */ }
      return;
    }

    if (action === 'pick') {
      if (picking) endPicker(); else startPicker('hide');
    } else if (action === 'edit') {
      if (picking) endPicker(); else startPicker('edit');
    } else {
      setPeek(!isPeeked(document));
    }
  }

  window.addEventListener('keydown', onHotkey, true);

  // documentElement, not body: at document_start there is no body yet, and this
  // still catches every node Gmail injects afterwards, including after a
  // refresh, which is the whole point.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('focus', schedule);

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(KEY in changes)) return;
    RULES_TEXT = changes[KEY].newValue === undefined
      ? DEFAULTS
      : String(changes[KEY].newValue);
    RULES = parse(RULES_TEXT);
    rulesLoaded = true;
    schedule();
  });

  // Paint and start watching immediately. loadRules applies the saved rules
  // itself as soon as a read succeeds, and keeps retrying if Safari's storage
  // is momentarily unavailable.
  apply();
  watchFrames();
  loadRules();
})();
