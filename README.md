# Mail Layout

A browser extension that rewrites what Gmail **shows** in one browser: hide an
attachment card, strip a boilerplate paragraph, black out an account number,
silence every message from a sender. Nothing is deleted, unsent, or changed for
anyone else — the words stay in the message, in the Gmail apps, and in Drive.

Manifest V3, one codebase, two products: loaded unpacked in Chrome, or wrapped
by the Xcode target here into a Safari Web Extension app.

```
gmail-content-filter/            the extension (shared verbatim by both browsers)
  manifest.json                  permissions, content-script scope, shortcut commands
  content.js                     rule engine, picker, editor, reveal toggle
  background.js                  seeds the first-run rules, relays shortcut commands
  popup/                         the rules editor
Mail Layout/                     the Xcode project that wraps it for Safari
```

## Rules

One per line in the popup. `#` starts a comment. Re-applied on every Gmail
re-render, because Gmail throws the thread DOM away constantly.

| Rule | Effect |
| --- | --- |
| `att: invoice.pdf` | Hide that attachment card, and the `Attachment:` chip on collapsed rows |
| `hide: Please see attached` | Remove the whole block that carries the phrase |
| `redact: 4419-0021` | Bar over the characters, keep the layout intact |
| `css: div.aQH` | Hide everything matching a selector, for when text is not enough |
| `from: a@b.com` | Hide every message from that address |
| `from: @b.com` | Hide the whole domain, and only the whole domain |

`*` works as a wildcard inside `from:`. A bare domain is matched with a
boundary, so `@news.example` cannot also claim `@news.example.spoof.test`.

## Keys, inside Gmail

| Key | Action |
| --- | --- |
| `Ctrl+Option+H` | Pick something to hide |
| `Ctrl+Option+E` | Pick something to edit |
| `Ctrl+Option+V` | Show everything the rules hide; press again, or click the red marker, to hide it again |
| `E` while picking | Switch the click between hiding and editing |
| `↑` / `↓` while picking | Widen or narrow the element |
| `Enter` / `Esc` | Choose / cancel |

The three combinations are also declared as manifest `commands`, so Safari
lists them under Settings → Extensions → Mail Layout → Shortcuts and
`chrome://extensions/shortcuts` lets them be rebound. The in-page handler works
whether or not anything is recorded there.

Picking is a click-through overlay: hover highlights, the tag line shows the
selector the rule will store, `Enter` writes the rule to storage. Editing is
for one-off text in the open message — it changes the live DOM, is never saved,
and is gone when Gmail reloads.

## How it works

**Text is the only durable anchor.** Gmail reissues ids like `:1ad` and `:1af`
on every refresh, label change, and thread switch, so those are worthless as
anchors while visible text survives. Phrases match across whitespace, and a
match climbs to the smallest enclosing block rather than the text node, so
removing a line does not leave an empty shell.

**Rules run in every frame.** Message bodies are same-origin `srcdoc` iframes
that each run their own copy of the script, and the top frame reaches into them
too. Every hidden node carries an ownership tag (`t` or `f`) so the two passes
clear only their own marks instead of flickering each other's work. A shortcut
pressed with the caret inside a message is forwarded to the top frame, which is
the only instance that can mark every document or lay a picker over all of them.

**Revealing is done by not hiding.** Gmail lays out with inline-block, table
cells, and flex children, so a revealed node has to return to the flow rather
be flipped back to `display: initial`. The state lives in a `data-gh-peek`
attribute on every document, which is what the frame copies read.

**Senders are anchored on `[email]` / `[data-sender]`.** Those attributes are
durable; the row classes around them are obfuscated and rotate. `mailto:` links
are deliberately not hidden, because they live in footers that would take the
whole message with them.

## Install

**Chrome** — `chrome://extensions` → Developer mode → Load unpacked →
select `gmail-content-filter/`.

**Safari** — build the wrapper app, then enable it:

```sh
xcodebuild -project "Mail Layout/Mail Layout.xcodeproj" \
  -scheme "Mail Layout" -configuration Release
```

Run the produced `Mail Layout.app`, then Safari → Settings → Extensions →
Mail Layout. Editing anything under `gmail-content-filter/` needs only a
rebuild and a relaunch — the Xcode target references those files in place.

## Limits

This changes presentation, not data. It is not a way to keep a secret: anyone
with the account password, the Gmail mobile apps, a forwarding rule, or the
original `.eml` sees everything. Redaction bars are cosmetic overlays, not
removed text, so they will copy, search, and print as the real characters.
Rules are stored as plain text in `chrome.storage.local`.
