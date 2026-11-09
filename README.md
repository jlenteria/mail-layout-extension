# Mail Layout

A Chrome and Safari extension to customize how Gmail looks. Hide attachments,
text blocks, and messages by sender; visually redact phrases; or temporarily
edit text and styles. Reveal hidden content whenever you need it.

Changes only affect your browser view. Original messages and attachments stay
unchanged. Redaction is visual and does not remove the underlying text.

## Install

**Chrome:** Open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked**, and select `gmail-content-filter/`. Reload Gmail.

**Safari:** Open `Mail Layout/Mail Layout.xcodeproj` in Xcode, configure signing
for both targets, then build and run **Mail Layout**. Enable the extension in
Safari Settings and allow access to Gmail. The app currently targets macOS 27.0.

## Use

Open the extension popup, enter one rule per line, and click **Save**:

```text
att: invoice.pdf
hide: Please see attached
redact: 4419-0021
from: sender@example.com
from: @example.com
css: div.aQH
```

Use **Hide an element…** to pick something on the page, **Edit an element…**
for temporary edits, or **Show hidden** to reveal content. Edits disappear when
Gmail rebuilds the view or reloads. Saved rules stay in local extension storage.
Review the included sample rules before use. Gmail AI Overview cards are also
hidden by a built-in rule, even if you remove that rule from the popup.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+H` | Pick an element to hide |
| `Ctrl+Alt+E` | Pick an element to edit |
| `Ctrl+Alt+V` | Toggle hidden content |

On Mac, **Alt** is **Option**. While picking, use **↑ / ↓** to adjust the
selection, **Enter** or click to choose, and **Esc** to cancel.

## Development

`gmail-content-filter/` contains the shared extension source. `Mail Layout/`
contains the macOS app and Safari extension wrapper. No JavaScript dependencies
or bundling step are required.

After changing the source, reload the extension in Chrome or rebuild the Safari
app, then reload Gmail.
