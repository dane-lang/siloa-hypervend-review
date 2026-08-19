/* ============================================================
   Shared sticky notes — Firestore backed, real time.
   Siloa × HyperVend joint review site.

   A page opts in by setting  <body data-page="proforma">  (or
   "placement"). Pages without data-page get no notes layer.

   Collection: notes
     { page, author, x, y, text, ts }

   Behaviour: bottom-right toolbar, author toggle, click-to-place
   add (Esc cancels), draggable notes, delete, export to text.
   Text edits and drag-end positions are debounced 500 ms before
   they are written. An onSnapshot listener filtered by `page`
   keeps every open tab live.
   ============================================================ */

import { db, isConfigured, PASSPHRASE_SHA256 } from "./firebase.js";
import {
  collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PAGE = document.body.dataset.page;

/* ---------- constants ---------- */
const DEBOUNCE   = 500;
const MAX_TEXT   = 2000;
const NOTE_W     = 216;
const AUTHORS    = { siloa: "Siloa", hypervend: "HyperVend" };
/* notes written before the rename carried personal names */
const LEGACY     = { dane: "siloa", guillermo: "hypervend" };
const GATE_KEY   = "siloa-notes-gate";
const AUTHOR_KEY = "siloa-notes-author";

/* ---------- module state ---------- */
const notes = new Map();          // id -> { el, ta, data, textTimer, posTimer, dragging }
let author  = "siloa";
let armed   = false;
let ui      = null;               // built DOM refs
let focusNext = null;             // doc id to focus once it arrives

/* ============================================================
   boot
   ============================================================ */
function boot() {
  try { author = localStorage.getItem(AUTHOR_KEY) || "siloa"; } catch (e) { /* private mode */ }
  author = LEGACY[author] || author;
  if (!AUTHORS[author]) author = "siloa";

  ui = buildChrome();
  wireGate();

  const gate = session(GATE_KEY);
  if (gate === "ok")             unlock();
  else if (gate === "dismissed") ui.unlock.classList.add("show");
  else                           openGate();
}

function session(k, v) {
  try { return v === undefined ? sessionStorage.getItem(k) : (sessionStorage.setItem(k, v), v); }
  catch (e) { return null; }
}

/* ============================================================
   chrome
   ============================================================ */
function buildChrome() {
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* passphrase gate */
  const gate = el("div", "sn-gate");
  gate.innerHTML =
    '<div class="box" role="dialog" aria-modal="true" aria-label="Notes passphrase">' +
      '<h3>Shared notes</h3>' +
      '<p>Enter the review passphrase to show the note layer. The document itself stays readable either way.</p>' +
      '<input type="password" id="snPass" autocomplete="off" placeholder="Passphrase" aria-label="Passphrase">' +
      '<div class="err" id="snErr">That passphrase does not match.</div>' +
      '<div class="row">' +
        '<button class="sn-b" id="snSkip">Not now</button>' +
        '<button class="sn-b pri" id="snGo">Show notes</button>' +
      '</div>' +
    '</div>';

  /* unlock chip (shown when the gate was dismissed) */
  const unlock = el("button", "sn-unlock", "&#128274; Notes");

  /* toolbar */
  const bar = el("div", "sn-toolbar");
  bar.innerHTML =
    '<span class="sn-label">Notes</span>' +
    '<span class="sn-count" id="snCount">0</span>' +
    '<span class="sn-who">' +
      '<button data-author="siloa">Siloa</button>' +
      '<button data-author="hypervend">HyperVend</button>' +
    '</span>' +
    '<button class="sn-b pri" id="snAdd">+ Add note</button>' +
    '<button class="sn-b" id="snExport">Export</button>';

  const hint = el("div", "sn-hint", "Click anywhere to place the note &nbsp;&middot;&nbsp; <b>Esc</b> to cancel");

  document.body.append(gate, unlock, bar, hint);

  const refs = {
    gate, unlock, bar, hint,
    pass:   gate.querySelector("#snPass"),
    err:    gate.querySelector("#snErr"),
    go:     gate.querySelector("#snGo"),
    skip:   gate.querySelector("#snSkip"),
    count:  bar.querySelector("#snCount"),
    add:    bar.querySelector("#snAdd"),
    export: bar.querySelector("#snExport"),
    who:    [...bar.querySelectorAll(".sn-who button")]
  };

  refs.who.forEach(b => b.addEventListener("click", () => setAuthor(b.dataset.author)));
  refs.add.addEventListener("click", () => (armed ? disarm() : arm()));
  refs.export.addEventListener("click", exportNotes);
  unlock.addEventListener("click", openGate);
  paintAuthor(refs);
  return refs;
}

function paintAuthor(refs = ui) {
  refs.who.forEach(b => b.classList.toggle("on", b.dataset.author === author));
}

function setAuthor(a) {
  if (!AUTHORS[a]) return;
  author = a;
  try { localStorage.setItem(AUTHOR_KEY, a); } catch (e) { /* ignore */ }
  paintAuthor();
}

/* ============================================================
   passphrase gate
   ============================================================ */
function openGate() {
  ui.unlock.classList.remove("show");
  ui.err.classList.remove("show");
  ui.gate.classList.add("show");
  setTimeout(() => ui.pass.focus(), 30);
}

function closeGate(dismissed) {
  ui.gate.classList.remove("show");
  ui.pass.value = "";
  if (dismissed) {
    session(GATE_KEY, "dismissed");
    ui.unlock.classList.add("show");
  }
}

function wireGate() {
  ui.go.addEventListener("click", tryPass);
  ui.skip.addEventListener("click", () => closeGate(true));
  ui.pass.addEventListener("keydown", e => { if (e.key === "Enter") tryPass(); });
  ui.gate.addEventListener("click", e => { if (e.target === ui.gate) closeGate(true); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (ui.gate.classList.contains("show")) closeGate(true);
    else if (armed) disarm();
  });
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function tryPass() {
  const entered = ui.pass.value.trim();
  if (!entered) return;
  let hash;
  try {
    hash = await sha256hex(entered);
  } catch (e) {
    ui.err.textContent = "This browser cannot check the passphrase (needs an https page).";
    ui.err.classList.add("show");
    return;
  }
  if (hash !== PASSPHRASE_SHA256) {
    ui.err.textContent = "That passphrase does not match.";
    ui.err.classList.add("show");
    ui.pass.select();
    return;
  }
  session(GATE_KEY, "ok");
  closeGate(false);
  unlock();
}

/* ============================================================
   unlock — show the layer and start syncing
   ============================================================ */
function unlock() {
  ui.unlock.classList.remove("show");
  ui.bar.classList.add("show");

  if (!isConfigured || !db) {
    ui.bar.querySelector(".sn-label").textContent = "Notes — not connected";
    ui.add.disabled = true;
    ui.export.disabled = true;
    ui.count.textContent = "!";
    ui.count.title = "Paste the firebaseConfig object into assets/firebase.js";
    console.warn("[siloa-notes] Firebase is not configured — see assets/firebase.js");
    return;
  }

  document.addEventListener("click", onPlaceClick, true);
  listen();
}

/* ============================================================
   live sync
   ============================================================ */
function listen() {
  const q = query(collection(db, "notes"), where("page", "==", PAGE));
  onSnapshot(q,
    snap => {
      const seen = new Set();
      snap.forEach(d => { seen.add(d.id); upsert(d.id, d.data()); });
      for (const id of [...notes.keys()]) if (!seen.has(id)) drop(id);
      recount();
    },
    err => {
      console.error("[siloa-notes] snapshot error:", err);
      ui.count.textContent = "!";
      ui.count.title = "Lost connection to the notes database.";
    }
  );
}

function recount() { ui.count.textContent = String(notes.size); }

function upsert(id, data) {
  let n = notes.get(id);
  if (!n) {
    n = render(id, data);
    notes.set(id, n);
  }
  n.data = data;

  /* author can change only by re-creation, but keep it honest */
  const who0 = LEGACY[data.author] || data.author;
  const who = AUTHORS[who0] ? who0 : "siloa";
  n.el.dataset.author = who;
  n.el.querySelector(".sn-name").textContent = AUTHORS[who];

  /* do not fight the local user: skip fields with a write in flight */
  if (!n.dragging && !n.posTimer) place(n.el, data.x, data.y);
  if (!n.textTimer && document.activeElement !== n.ta) {
    const t = String(data.text || "");
    if (n.ta.value !== t) { n.ta.value = t; autosize(n.ta); }
  }

  if (focusNext === id) {
    focusNext = null;
    n.ta.focus();
  }
}

function drop(id) {
  const n = notes.get(id);
  if (!n) return;
  clearTimeout(n.textTimer);
  clearTimeout(n.posTimer);
  n.el.remove();
  notes.delete(id);
}

function place(el, x, y) {
  const maxX = Math.max(0, document.documentElement.scrollWidth - NOTE_W - 8);
  el.style.left = Math.min(Math.max(0, Number(x) || 0), maxX) + "px";
  el.style.top  = Math.max(0, Number(y) || 0) + "px";
}

/* ============================================================
   note DOM
   ============================================================ */
function render(id, data) {
  const el = document.createElement("div");
  el.className = "sn-note";
  el.dataset.id = id;
  el.innerHTML =
    '<div class="sn-bar"><span class="sn-name"></span>' +
    '<button class="sn-del" title="Delete note" aria-label="Delete note">&times;</button></div>' +
    '<textarea maxlength="' + MAX_TEXT + '" placeholder="Type a note…" aria-label="Note text"></textarea>';
  document.body.appendChild(el);

  const n = { el, ta: el.querySelector("textarea"), data, textTimer: null, posTimer: null, dragging: false };

  n.ta.addEventListener("input", () => {
    autosize(n.ta);
    clearTimeout(n.textTimer);
    n.textTimer = setTimeout(() => { n.textTimer = null; flushText(id, n); }, DEBOUNCE);
  });
  n.ta.addEventListener("blur", () => {
    if (!n.textTimer) return;
    clearTimeout(n.textTimer); n.textTimer = null;
    flushText(id, n);
  });

  el.querySelector(".sn-del").addEventListener("click", () => remove(id));
  dragify(id, n);
  return n;
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.max(84, ta.scrollHeight) + "px";
}

function flushText(id, n) {
  write(id, { text: n.ta.value.slice(0, MAX_TEXT) });
}

function write(id, patch) {
  updateDoc(doc(db, "notes", id), patch)
    .catch(err => console.error("[siloa-notes] write failed:", err));
}

function remove(id) {
  const n = notes.get(id);
  if (n) { clearTimeout(n.textTimer); clearTimeout(n.posTimer); n.textTimer = n.posTimer = null; }
  deleteDoc(doc(db, "notes", id))
    .catch(err => console.error("[siloa-notes] delete failed:", err));
}

/* ---------- dragging ---------- */
function dragify(id, n) {
  const handle = n.el.querySelector(".sn-bar");
  let dx = 0, dy = 0;

  handle.addEventListener("pointerdown", e => {
    if (e.target.closest(".sn-del")) return;
    e.preventDefault();
    n.dragging = true;
    dx = e.pageX - parseFloat(n.el.style.left || 0);
    dy = e.pageY - parseFloat(n.el.style.top  || 0);
    n.el.classList.add("drag");
    handle.classList.add("grabbing");
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", e => {
    if (!n.dragging) return;
    n.el.style.left = Math.max(0, e.pageX - dx) + "px";
    n.el.style.top  = Math.max(0, e.pageY - dy) + "px";
  });

  const end = e => {
    if (!n.dragging) return;
    n.dragging = false;
    n.el.classList.remove("drag");
    handle.classList.remove("grabbing");
    try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    const x = Math.round(parseFloat(n.el.style.left) || 0);
    const y = Math.round(parseFloat(n.el.style.top)  || 0);
    clearTimeout(n.posTimer);
    n.posTimer = setTimeout(() => { n.posTimer = null; write(id, { x, y }); }, DEBOUNCE);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* ============================================================
   add a note — click to place
   ============================================================ */
function arm() {
  armed = true;
  document.body.classList.add("sn-placing");
  ui.hint.classList.add("show");
  ui.add.classList.add("arm");
  ui.add.textContent = "Cancel";
}

function disarm() {
  armed = false;
  document.body.classList.remove("sn-placing");
  ui.hint.classList.remove("show");
  ui.add.classList.remove("arm");
  ui.add.textContent = "+ Add note";
}

function onPlaceClick(e) {
  if (!armed) return;
  if (e.target.closest(".sn-toolbar, .sn-note, .sn-gate, .sn-hint, .sn-unlock, .nav")) return;
  e.preventDefault();
  e.stopPropagation();
  const x = Math.round(e.pageX - 12);
  const y = Math.round(e.pageY - 10);
  disarm();
  addDoc(collection(db, "notes"), {
    page: PAGE, author, x: Math.max(0, x), y: Math.max(0, y), text: "", ts: serverTimestamp()
  })
    .then(ref => {
      /* the snapshot can land before this resolves — focus either way */
      const n = notes.get(ref.id);
      if (n) n.ta.focus(); else focusNext = ref.id;
    })
    .catch(err => {
      console.error("[siloa-notes] could not create note:", err);
      alert("Could not save that note. Check the connection and try again.");
    });
}

/* ============================================================
   export
   ============================================================ */
const PAGE_TITLE = { proforma: "Pro Forma", placement: "Placement Matrix" };

function exportNotes() {
  const rows = [...notes.entries()]
    .map(([id, n]) => ({
      author: AUTHORS[n.data.author] || n.data.author || "Unknown",
      page:   n.data.page || PAGE,
      text:   n.ta.value,
      when:   n.data.ts && n.data.ts.toDate ? n.data.ts.toDate() : null,
      y:      Number(n.data.y) || 0
    }))
    .sort((a, b) => a.y - b.y);

  const stamp = new Date();
  const lines = [
    "Siloa × HyperVend — Joint Review Notes",
    "Page: " + (PAGE_TITLE[PAGE] || PAGE) + " (" + PAGE + ")",
    "Exported: " + stamp.toLocaleString(),
    "Notes: " + rows.length,
    "",
    "".padEnd(58, "=")
  ];
  rows.forEach((r, i) => {
    lines.push(
      "",
      (i + 1) + ". " + r.author + "  —  page: " + r.page +
        (r.when ? "  —  " + r.when.toLocaleString() : ""),
      ...(r.text.trim() ? r.text.trim().split("\n").map(l => "   " + l) : ["   (empty)"])
    );
  });

  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "siloa-hypervend-notes-" + PAGE + ".txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   go — after every const above is initialised
   ============================================================ */
if (PAGE) boot();
