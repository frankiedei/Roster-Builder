# Roster Builder

A custom Airtable extension for designing artist roster cards (one-sheets) from records in a base and exporting them to PDF — one card at a time or the whole roster in a single batch.

Built for music-label PR work: pull an artist's photo, bio, credits, and social/streaming links from Airtable, lay them out once on a reusable template, and generate a polished card for every artist on the roster.

---

## What it does

- A drag-and-drop **canvas editor** for laying out a card, with snapping guides and relative alignment.
- Elements bind to **Airtable fields**, so one layout renders a card for every record.
- Export a **single card** or **bulk-export the entire (filtered, sorted) roster** to PDF, with real clickable links preserved.
- Layouts persist per workspace and can be saved as a reusable **template**.

---

## Features

**Elements**
- Static text, record-field text, attachment images, clickable icons, dynamic stacks (rows/columns), shapes (rectangle, line), and uploaded static images.
- **Clickable icons** for common services (Spotify, Apple Music, Instagram, YouTube, SoundCloud, TikTok, generic link) plus custom icon upload. Links come from a bound field and are preserved as real hyperlinks in the exported PDF.
- **Auto-fit text** — a toggle that shrinks long text (bios, names) to fit its box, re-fitting live as you resize.
- **Blur-fill images** — show the whole photo (letterboxed) over a blurred, zoomed copy of itself filling the empty space, instead of cropping to fill.

**Editing**
- Multi-select (Shift / Cmd / Ctrl-click), with **align** (left/center/right, top/middle/bottom) and **distribute** (horizontal/vertical) relative to the selection, plus group drag.
- **Undo / redo** for element changes (buttons + keyboard).
- Duplicate, delete, and arrow-key nudging.
- Per-element fonts plus a page-level **base font** with one-click "apply to all," from a curated set of modern typefaces.
- Resizable page, configurable background (solid color, gradient, or uploaded image).

**Roster control**
- **Sort** the roster by any field (artist name, date, number, etc.).
- Keyword **filters** across fields.
- A persisted, value-based **roster filter** (e.g. only show records whose status is `Shortlist` or `Ready`). This setting persists across templates.

**Export**
- Single-card export (high-resolution PNG pages).
- Bulk export of the full roster to one multi-page PDF (compressed JPEG pages for size), with the same sort/filter as the editor.

---

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)
- The Airtable Blocks CLI: `npm install -g @airtable/blocks-cli`
- A development account/base set up for the extension in Airtable

### Install
```bash
git clone https://github.com/frankiedei/Roster-Builder.git
cd Roster-Builder
npm install
```

### Run locally (development)
```bash
block run
```
Then open your base in Airtable, add the extension in development mode, and point it at the local server.

### Release (publish to your base)
```bash
block release
```

> **Note:** Pushing to GitHub and releasing the extension are separate steps. `git push` updates the source; `block release` deploys the running extension. Do both when you want the live extension updated.

---

## Using the editor

1. **Pick a table** in the toolbar — this is the roster source.
2. **Add elements** from the sidebar (text, field, stack, shape, image) and drag/resize them on the canvas.
3. **Bind fields** — select a field element and choose the Airtable field plus a display mode (text, image, icon).
4. **Navigate records** with the arrows in the toolbar to preview the card for each artist.
5. **Export** a single card, or **Export All** for the whole roster.

Selecting an element opens its editor in the sidebar. Selecting two or more shows alignment and distribution tools.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Undo | `Cmd/Ctrl + Z` |
| Redo | `Cmd/Ctrl + Shift + Z` or `Ctrl + Y` |
| Duplicate selection | `Cmd/Ctrl + D` |
| Delete selection | `Delete` / `Backspace` |
| Nudge selection | Arrow keys (1px) |
| Nudge faster | `Shift +` arrow keys (10px) |
| Deselect | `Escape` |
| Add to selection | `Shift` / `Cmd` / `Ctrl + click` |

(Shortcuts are ignored while typing in a text field.)

---

## Templates

The current layout (elements + page style) is saved automatically to the workspace. You can also:
- **Save as Default Template** — used as the starting point for new installs of the extension in the workspace.
- **Export template.json** — download the layout to commit into the repo as the bundled fallback (`frontend/template.json`).
- **Load** — restore the saved default or the bundled `template.json`.

Field bindings are matched by field ID, so a template loaded into a different base keeps any fields it recognizes and clears the rest for re-mapping.

The **roster filter** is intentionally *not* part of templates — it persists separately so loading a template doesn't change which records show.

---

## Exporting to PDF

- **Single card:** renders the current record at high resolution.
- **Bulk (Export All):** renders one page per record in the current sort/filter order, into a single PDF. Pages are stored as compressed JPEG to keep large rosters within browser memory limits.
- Clickable elements (icons/links) are added as real PDF hyperlinks.

Render quality/speed is controlled by `EXPORT_SCALE` (single) and `BULK_EXPORT_SCALE` (bulk) near the top of the PDF logic — raise for sharper output, lower for faster/smaller exports.

---

## Project structure

```
frontend/
  index.js        # The entire app (UI, editor, rendering, PDF export)
  template.json   # Bundled default layout/fallback
block.json        # Airtable extension config
package.json
```

The app is intentionally a single React component file. Major regions inside `frontend/index.js`: constants/helpers, the `AutoFitText` and `ErrorBoundary` components, the main `UpgradedPageDesigner` component (state, element/PDF logic), and the render tree (sidebar editor + canvas).

---

## Notes & known limitations

- Built on the `@airtable/blocks` SDK; layout and settings are stored in the extension's **globalConfig**, which is shared across the workspace and has a storage size limit. Uploaded images (page background and static images) are automatically downscaled to stay within it, but many large images on one card can still approach the cap.
- Undo/redo covers **element** changes, not page background, fonts, or the roster filter.
- Bulk export rasterizes each card (text is not selectable in the PDF) — this keeps rendering consistent across fonts, images, and effects.
- The blurred backdrop for blur-fill is generated with a canvas blur (CSS `filter` is ignored by the export renderer), so it appears once the source image is cached.
- The extension runs in Airtable's modern browser environment; some niceties (e.g. blur generation, live resize re-fitting) rely on current browser APIs.

---

## Tech stack

- **React** (via the Airtable Blocks SDK)
- **@airtable/blocks** — base data, UI components, persistence
- **react-draggable** — element dragging
- **html2canvas** — render cards to canvas
- **jsPDF** — assemble the PDF
