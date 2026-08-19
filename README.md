# Siloa × HyperVend — Joint Review Site

A three-page GitHub Pages site carrying the two working documents for the
Siloa × HyperVend review, with a shared sticky-note layer that syncs live
across everyone who has the link.

| Page | File | Notes layer |
|---|---|---|
| Landing | `index.html` | — |
| Unit Economics Pro Forma | `proforma.html` | `page: "proforma"` |
| In-Building Placement Matrix | `placement.html` | `page: "placement"` |

```
/
├── index.html          landing — Siloa header + two document cards
├── proforma.html       unit economics pro forma v2.0
├── placement.html      in-building placement matrix (vendor-safe)
├── assets/
│   ├── site.css        shared visual system
│   ├── notes.js        sticky-note module (Firestore backed)
│   └── firebase.js     Firebase init + config + passphrase hash
└── README.md
```

Brand: Manrope (headings), Poppins (body), Caveat (margin notes),
accent `#1470AF`, steel `#8EB6DC`.

---

## Before this goes live — two values to paste in

Both live in `assets/firebase.js`. Nothing else needs to change.

**1. `firebaseConfig`** — from the Firebase console for project
`siloa-review-notes`: *Project settings → General → Your apps → Web app →
SDK setup and configuration*. Replace the `PASTE_…` placeholders. Until real
values are in, every page still renders normally and the notes toolbar
reports "Notes — not connected" instead of erroring.

**2. `PASSPHRASE_SHA256`** — currently the hash of the placeholder
passphrase `SILOA-HV-2026`. To change it:

```sh
printf 'YOUR-PASSPHRASE' | sha256sum
```

and paste the hex digest. The passphrase itself is never stored in the repo.

---

## How the notes work

* A page opts in with `<body data-page="proforma">`. Pages without that
  attribute (the landing page) get no note layer at all.
* On the first page of a browser session the passphrase dialog appears once.
  Accepting stores `ok` in `sessionStorage`, so it does not ask again that
  session; dismissing leaves a small **🔒 Notes** chip in the corner. Either
  way the document content stays fully readable — the gate covers only the
  note layer.
* Toolbar (bottom right): note count, **Siloa / HyperVend** author toggle,
  **+ Add note**, **Export**.
* **+ Add note** arms click-to-place — click anywhere on the page to drop
  the note there, `Esc` cancels.
* Notes drag by their coloured top bar and delete with the ×.
* **Export** downloads a `.txt` listing every note on the current page with
  its author, page and timestamp.
* Author colours: Siloa `#d6eafb` / `#9cc9ea`, HyperVend `#fef4c0` / `#f3d95a`.
  Notes are attributed by organisation, not by person — a note says which
  side of the table it came from, so more than one reader per side can use
  the same identity. `assets/notes.js` maps the earlier personal values
  (`dane`, `guillermo`) onto the new ones on read.

### Data model — collection `notes`

```js
{
  page:   "proforma" | "placement",  // notes are per page
  author: "siloa" | "hypervend",
  x:      number,                    // pageX offset
  y:      number,                    // pageY offset
  text:   string,                    // < 2000 chars
  ts:     serverTimestamp()
}
```

An `onSnapshot` listener filtered by `page` keeps every open tab live, so a
note created, moved, edited or deleted by any visitor appears for all of them
without a refresh. Text edits and drag-end positions are debounced 500 ms
before they are written, which keeps write volume trivial. A note being typed
in or dragged locally is never overwritten by an incoming snapshot. Document
IDs are auto-assigned; deleting a note deletes the document.

---

## Deployment

GitHub Pages, `main` branch, root — no build step, everything is static.
The Firebase SDK loads from the gstatic CDN as modular v10 ES modules, so the
pages must be served over HTTP(S); opening the files directly from disk will
not load the note layer (module CORS, and `crypto.subtle` needs a secure
context).

### Checking sync end to end

1. Open `proforma.html` in two different browser profiles.
2. Enter the passphrase in both.
3. Add a note in one — it should appear in the other within about two seconds.
4. Drag it, edit the text, then delete it, confirming each step propagates.
5. Repeat on `placement.html`, then confirm the two pages hold separate sets.

---

## Content rule for `placement.html`

`placement.html` is vendor-safe by construction. It carries the traffic ×
intent grid, the three timing stats, the all-shift surge note and the two
stated caveats — and nothing about internal site-selection strategy. Guard it
with:

```sh
grep -Eic 'cascade|deprioriti|warmth|auxiliary|beds|AHCA|CONFIDENTIAL' placement.html
```

which must return `0`. The document classification on this page reads
*Joint working document — Siloa × HyperVend*.
