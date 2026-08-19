# Siloa × HyperVend — Joint Review

A three-page GitHub Pages site carrying the two working documents for the
Siloa × HyperVend review, with an anchored review layer that syncs live
across everyone who has the link.

**Live:** https://dane-lang.github.io/siloa-hypervend-review/

| Page | File | Review layer |
|---|---|---|
| Landing — open items dashboard | `index.html` | `page: "landing"` (read-only) |
| Unit Economics Pro Forma | `proforma.html` | `page: "proforma"` |
| In-Building Placement Matrix | `placement.html` | `page: "placement"` |

```
/
├── index.html              landing — status of the review across both documents
├── proforma.html           unit economics pro forma v2.0
├── placement.html          in-building placement matrix (vendor-safe)
├── assets/
│   ├── site.css            shared visual system + review layer
│   ├── notes.js            review layer: anchors, threads, status, dashboard
│   ├── firebase.js         Firebase init, config, passphrase hash
│   └── doc-index.json      generated — the addressable map of both documents
├── tools/
│   └── build-anchors.py    generates the anchors and doc-index.json
└── README.md
```

Brand: Manrope (headings), Poppins (body), Caveat (margin notes),
accent `#1470AF`, steel `#8EB6DC`.

---

## The review layer

**Anchored notes.** `+ Add note`, then click the row, zone or section you are
commenting on — it highlights as you hover. The note attaches to that element,
so it stays with its subject at any screen width and on any device. Click
anywhere else for a general note. Anchored rows carry a count badge, so you can
see where the argument is without hunting.

**Threads.** A root note plus a flat list of replies. One level deep on
purpose — deeper nesting stops being readable. Threads open in a side panel
that never covers the document, so you can read the figure and the argument at
the same time.

**Status.** Open / Answered / Resolved on every thread. A reply from the other
side moves an open thread to Answered automatically; either side can mark it
Resolved. The landing page rolls this up into a live list of what is still
outstanding on each document.

**Unread.** Threads with activity you have not seen since your last visit are
flagged in the panel, on the badge and on the dashboard.

**Export.** A plain-text thread log grouped by line item, with status,
authors, timestamps and replies. This is the artifact for the record.

Notes are attributed by organisation — **Siloa** or **HyperVend** — not by
person, so more than one reader per side can post without a note landing under
someone else's name. `notes.js` maps the earlier personal values (`dane`,
`guillermo`) onto the current ones on read.

### Deep links

`proforma.html#<anchor-id>` scrolls to that element and opens its thread. The
dashboard's open-item list links this way.

---

## Anchors are generated, not hand-written

`tools/build-anchors.py` reads both documents, injects a `data-anchor` on every
section, table row, stat box, caveat and placement-grid zone, and writes
`assets/doc-index.json` — the map the review layer uses for labels, grouping
and the dashboard.

```sh
python3 tools/build-anchors.py           # regenerate after editing a document
python3 tools/build-anchors.py --check   # verify in sync; exit 1 if not
```

It is idempotent and it never touches content: no figure is read, rewritten or
derived. Presentation stays in the HTML. Run it after any edit to either
document so anchors track the text.

Anchor ids derive from heading and row text, so they survive edits that don't
rename things. Renaming a row orphans notes attached to it — they fall back to
their stored `anchorLabel` and keep working, but they stop highlighting.

---

## Data model — collection `notes`

```js
{
  page:   "proforma" | "placement",   // the six keys the published rules require
  author: "siloa" | "hypervend",
  x: 0, y: 0,                         // retained for rule compatibility
  text:   string,                     // < 2000 chars
  ts:     serverTimestamp(),

  anchor:      string | null,         // element id, null for a general note
  anchorLabel: string | null,         // human label, snapshotted at creation
  status:      "open" | "answered" | "resolved",   // root notes
  parentId:    string | null,         // set on replies
  updated:     serverTimestamp()
}
```

The published security rules gate `create` on `hasAll` of the original six
keys, so the added fields pass without a rules change and notes written before
this schema stay valid — missing fields default on read. **Every write must
keep those six keys present.**

An `onSnapshot` listener filtered by `page` keeps every tab live. Text edits
are debounced 500 ms.

---

## Before this goes live — two values in `assets/firebase.js`

**`firebaseConfig`** — live, from web app `siloa-review-notes-web`.

**`PASSPHRASE_SHA256`** — currently the hash of `SILOA-HV-2026`. To change:

```sh
printf 'YOUR-PASSPHRASE' | sha256sum
```

and paste the digest. The passphrase itself is never stored in the repo.

### What the passphrase does and does not do

It gates the review layer only — both documents stay fully readable without
it. It is a curtain, not a lock: the Firebase config is in page source and the
rules allow open read, update and delete with no authentication. Anyone with
the link who reads the source can reach the notes. **Export regularly** — there
is no history and no undo.

---

## Deployment

GitHub Pages, `main` branch, root. No build step at serve time; the anchor
tool runs at authoring time and its output is committed. The Firebase SDK loads
from the gstatic CDN as ES modules, so pages must be served over HTTP(S) —
opening files from disk will not load the review layer.

## Content rule for `placement.html`

Vendor-safe by construction. Guard with:

```sh
grep -Eic 'cascade|deprioriti|warmth|auxiliary|beds|AHCA|CONFIDENTIAL' placement.html
```

which must return `0`.
