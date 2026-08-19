/* ============================================================
   Review layer — Siloa × HyperVend joint review
   Firestore backed, real time.

   A page opts in with <body data-page="proforma"> (or "placement").

   What this does beyond a sticky note:
     - a note anchors to a row, zone or section of the document, so it
       survives reflow, screen width and edits to the page
     - threads: a root note plus a flat list of replies, read in a side
       panel that never covers the thing under discussion
     - status: open / answered / resolved, so the page is an agenda
     - unread: what changed since you were last here
     - anchored rows carry a count, so you see where the argument is

   Firestore document (collection `notes`)
     page, author, x, y, text, ts      <- the six the rules require
     anchor, anchorLabel               <- null for a free-floating note
     status                            <- root notes only
     parentId                          <- set on replies
     updated
   Every write keeps the original six keys, so the published rules
   (hasAll on those six) accept it and older notes stay valid.
   ============================================================ */

import { db, isConfigured, PASSPHRASE_SHA256 } from "./firebase.js";
import {
  collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PAGE = document.body.dataset.page;

/* ---------- constants ---------- */
const DEBOUNCE   = 500;
const MAX_TEXT   = 2000;
const AUTHORS    = { siloa: "Siloa", hypervend: "HyperVend" };
const LEGACY     = { dane: "siloa", guillermo: "hypervend" };
const STATUS     = {
  open:     { label: "Open",     hint: "Needs a response" },
  answered: { label: "Answered", hint: "Replied to, not yet agreed" },
  resolved: { label: "Resolved", hint: "Closed — no further action" }
};
const GATE_KEY   = "siloa-notes-gate";
const AUTHOR_KEY = "siloa-notes-author";
const SEEN_KEY   = "siloa-notes-seen";      // last-visit stamp, per page

/* ---------- state ---------- */
const docs   = new Map();   // id -> data
let index    = null;        // doc-index.json
let author   = "siloa";
let armed    = false;
let openId   = null;        // thread showing in the panel
let openedAt = 0;           // when it was requested — a new note opens before its snapshot lands
let rendered = null;        // thread id currently built in the panel DOM
let filter   = "open";      // open | all | mine | unread
let lastSeen = 0;
let ui       = null;
let onUnlocked = () => {};

/* ============================================================
   boot
   ============================================================ */
async function boot() {
  try { author = localStorage.getItem(AUTHOR_KEY) || "siloa"; } catch (e) { /* private mode */ }
  author = LEGACY[author] || author;
  if (!AUTHORS[author]) author = "siloa";
  lastSeen = Number(local(SEEN_KEY + ":" + PAGE) || 0);

  try {
    const res = await fetch("assets/doc-index.json", { cache: "no-cache" });
    index = (await res.json())[PAGE] || [];
  } catch (e) {
    index = [];
    console.warn("[review] doc index unavailable — anchoring degraded", e);
  }

  ui = buildChrome();
  wireGate();
  onUnlocked = unlock;

  const gate = session(GATE_KEY);
  if (gate === "ok")             unlock();
  else if (gate === "dismissed") ui.unlock.classList.add("show");
  else                           openGate();
}

const session = (k, v) => {
  try { return v === undefined ? sessionStorage.getItem(k) : (sessionStorage.setItem(k, v), v); }
  catch (e) { return null; }
};
const local = (k, v) => {
  try { return v === undefined ? localStorage.getItem(k) : (localStorage.setItem(k, v), v); }
  catch (e) { return null; }
};

/* ---------- small helpers ---------- */
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const who = a => AUTHORS[LEGACY[a] || a] ? (LEGACY[a] || a) : "siloa";
const millis = d => (d && d.ts && d.ts.toMillis) ? d.ts.toMillis() : 0;
const isRoot = d => !d.parentId;
const statusOf = d => STATUS[d.status] ? d.status : "open";
let labelMap = null;                 // flat id -> label, used by the dashboard
const labelFor = anchor => {
  if (!anchor) return null;
  if (labelMap && labelMap.has(anchor)) return labelMap.get(anchor);
  if (!index) return null;
  for (const s of index) {
    if (s.id === anchor) return s.label;
    const r = s.rows.find(r => r.id === anchor);
    if (r) return r.label;
  }
  return null;
};
function when(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 6e4) return "just now";
  if (diff < 36e5) return Math.floor(diff / 6e4) + "m ago";
  if (diff < 864e5) return Math.floor(diff / 36e5) + "h ago";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* thread = root + its replies, oldest first */
const repliesOf = id => [...docs.entries()]
  .filter(([, d]) => d.parentId === id)
  .sort((a, b) => millis(a[1]) - millis(b[1]));
const roots = () => [...docs.entries()]
  .filter(([, d]) => isRoot(d))
  .sort((a, b) => millis(a[1]) - millis(b[1]));

function threadUnread(id, d) {
  if (millis(d) > lastSeen && who(d.author) !== author) return true;
  return repliesOf(id).some(([, r]) => millis(r) > lastSeen && who(r.author) !== author);
}

/* ============================================================
   chrome
   ============================================================ */
function buildChrome() {
  const mk = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const gate = mk("div", "sn-gate");
  gate.innerHTML =
    '<div class="box" role="dialog" aria-modal="true" aria-label="Review passphrase">' +
      "<h3>Shared review</h3>" +
      "<p>Enter the review passphrase to show notes and replies. The document itself stays readable either way.</p>" +
      '<input type="password" id="snPass" autocomplete="off" placeholder="Passphrase" aria-label="Passphrase">' +
      '<div class="err" id="snErr">That passphrase does not match.</div>' +
      '<div class="row"><button class="sn-b" id="snSkip">Not now</button>' +
      '<button class="sn-b pri" id="snGo">Show notes</button></div>' +
    "</div>";

  const unlock = mk("button", "sn-unlock", "&#128274; Review notes");

  const bar = mk("div", "sn-toolbar");
  bar.innerHTML =
    '<button class="sn-b" id="snPanelBtn"><span class="sn-open-n" id="snOpenN">0</span> open</button>' +
    '<span class="sn-who">' +
      '<button data-author="siloa">Siloa</button>' +
      '<button data-author="hypervend">HyperVend</button>' +
    "</span>" +
    '<button class="sn-b pri" id="snAdd">+ Add note</button>';

  const hint = mk("div", "sn-hint",
    "Click a row, zone or section to attach the note &nbsp;&middot;&nbsp; " +
    "anywhere else for a general note &nbsp;&middot;&nbsp; <b>Esc</b> to cancel");

  /* side panel — threads live here, never over the document */
  const panel = mk("aside", "sn-panel");
  panel.innerHTML =
    '<header class="sn-p-head">' +
      '<div class="sn-p-title"><b>Review notes</b><span class="sn-p-sub" id="snPSub"></span></div>' +
      '<button class="sn-x" id="snClose" aria-label="Close panel">&times;</button>' +
    "</header>" +
    '<nav class="sn-filters" id="snFilters">' +
      '<button data-f="open" class="on">Open</button>' +
      '<button data-f="unread">New</button>' +
      '<button data-f="mine">Mine</button>' +
      '<button data-f="all">All</button>' +
    "</nav>" +
    '<div class="sn-p-body" id="snBody"></div>' +
    '<footer class="sn-p-foot"><button class="sn-b" id="snExport">Export thread log</button></footer>';

  document.body.append(gate, unlock, bar, hint, panel);

  const refs = {
    gate, unlock, bar, hint, panel,
    pass: gate.querySelector("#snPass"), err: gate.querySelector("#snErr"),
    go: gate.querySelector("#snGo"), skip: gate.querySelector("#snSkip"),
    openN: bar.querySelector("#snOpenN"), add: bar.querySelector("#snAdd"),
    panelBtn: bar.querySelector("#snPanelBtn"),
    body: panel.querySelector("#snBody"), sub: panel.querySelector("#snPSub"),
    close: panel.querySelector("#snClose"), export: panel.querySelector("#snExport"),
    filters: [...panel.querySelectorAll("#snFilters button")],
    whoBtns: [...bar.querySelectorAll(".sn-who button")]
  };

  refs.whoBtns.forEach(b => b.addEventListener("click", () => setAuthor(b.dataset.author)));
  refs.add.addEventListener("click", () => (armed ? disarm() : arm()));
  refs.panelBtn.addEventListener("click", () => togglePanel());
  refs.close.addEventListener("click", () => closePanel());
  refs.export.addEventListener("click", exportLog);
  refs.filters.forEach(b => b.addEventListener("click", () => {
    filter = b.dataset.f;
    refs.filters.forEach(x => x.classList.toggle("on", x === b));
    openId = null;
    paintPanel();
  }));
  unlock.addEventListener("click", openGate);
  paintAuthor(refs);
  return refs;
}

const paintAuthor = (refs = ui) =>
  refs.whoBtns.forEach(b => b.classList.toggle("on", b.dataset.author === author));

function setAuthor(a) {
  if (!AUTHORS[a]) return;
  author = a;
  local(AUTHOR_KEY, a);
  paintAuthor();
  paintPanel();
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
  if (dismissed) { session(GATE_KEY, "dismissed"); ui.unlock.classList.add("show"); }
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
    else if (ui.panel.classList.contains("open")) closePanel();
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
  try { hash = await sha256hex(entered); }
  catch (e) {
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
  onUnlocked();
}

/* ============================================================
   unlock + sync
   ============================================================ */
function unlock() {
  ui.unlock.classList.remove("show");
  ui.bar.classList.add("show");
  document.body.classList.add("sn-live");   // reserves the badge gutter

  if (!isConfigured || !db) {
    ui.panelBtn.textContent = "Notes not connected";
    ui.add.disabled = ui.panelBtn.disabled = true;
    console.warn("[review] Firebase is not configured — see assets/firebase.js");
    return;
  }
  document.addEventListener("click", onPlaceClick, true);
  onSnapshot(query(collection(db, "notes"), where("page", "==", PAGE)),
    snap => {
      docs.clear();
      snap.forEach(d => docs.set(d.id, d.data()));
      paintBadges();
      paintPanel();
      paintCounts();
      openFromHash();
    },
    err => {
      console.error("[review] snapshot error:", err);
      ui.panelBtn.textContent = "Connection lost";
    });
}

function paintCounts() {
  const open = roots().filter(([, d]) => statusOf(d) === "open").length;
  const unread = roots().filter(([id, d]) => threadUnread(id, d)).length;
  ui.openN.textContent = String(open);
  ui.panelBtn.classList.toggle("has-new", unread > 0);
  ui.panelBtn.title = unread ? `${unread} thread${unread > 1 ? "s" : ""} with new activity` : "";
}

let hashDone = false;
function openFromHash() {
  if (hashDone) return;
  const want = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!want) { hashDone = true; return; }
  const byId = want.startsWith("note-") ? want.slice(5) : null;
  const hit = byId
    ? (docs.has(byId) ? [byId, docs.get(byId)] : null)
    : roots().find(([, d]) => d.anchor === want);
  hashDone = true;
  if (hit) { filter = "all"; ui.filters.forEach(x => x.classList.toggle("on", x.dataset.f === "all")); openThread(hit[0]); }
  else {
    const el = document.querySelector(`[data-anchor="${CSS.escape(want)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* ============================================================
   anchor badges on the document
   ============================================================ */
function paintBadges() {
  document.querySelectorAll(".sn-badge").forEach(b => b.remove());
  document.querySelectorAll("[data-anchor]").forEach(el => el.classList.remove("sn-has", "sn-lit"));

  const byAnchor = new Map();
  for (const [id, d] of roots()) {
    if (!d.anchor) continue;
    if (!byAnchor.has(d.anchor)) byAnchor.set(d.anchor, []);
    byAnchor.get(d.anchor).push([id, d]);
  }

  for (const [anchor, list] of byAnchor) {
    const el = document.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    if (!el) continue;
    el.classList.add("sn-has");
    const openN = list.filter(([, d]) => statusOf(d) === "open").length;
    const isNew = list.some(([id, d]) => threadUnread(id, d));
    const badge = document.createElement("button");
    badge.className = "sn-badge" + (openN ? " open" : " done") + (isNew ? " new" : "");
    badge.textContent = String(list.length);
    badge.title = `${list.length} note${list.length > 1 ? "s" : ""}` + (openN ? `, ${openN} open` : ", all resolved");
    badge.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      filter = "all";
      ui.filters.forEach(x => x.classList.toggle("on", x.dataset.f === "all"));
      openThread(list[0][0]);
    });
    /* table rows cannot host a positioned child; put it in the first cell */
    const host = el.tagName === "TR" ? el.querySelector("td") : el;
    if (host) { host.appendChild(badge); host.classList.add("sn-badge-host"); }
  }
}

/* ============================================================
   side panel
   ============================================================ */
function togglePanel() {
  if (ui.panel.classList.contains("open")) closePanel();
  else { ui.panel.classList.add("open"); document.body.classList.add("sn-panel-open"); paintPanel(); markSeen(); }
}
function closePanel() {
  ui.panel.classList.remove("open");
  document.body.classList.remove("sn-panel-open");
  openId = null;
  rendered = null;
  document.querySelectorAll(".sn-lit").forEach(e => e.classList.remove("sn-lit"));
}
function markSeen() {
  lastSeen = Date.now();
  local(SEEN_KEY + ":" + PAGE, String(lastSeen));
  setTimeout(() => { paintBadges(); paintCounts(); }, 1200);
}

function visibleRoots() {
  return roots().filter(([id, d]) => {
    if (filter === "all")    return true;
    if (filter === "open")   return statusOf(d) !== "resolved";
    if (filter === "mine")   return who(d.author) === author;
    if (filter === "unread") return threadUnread(id, d);
    return true;
  });
}

function paintPanel() {
  if (!ui.panel.classList.contains("open")) return;
  const list = visibleRoots();
  ui.sub.textContent = `${list.length} of ${roots().length} on this page`;

  if (openId) {
    if (docs.has(openId)) { paintThread(openId); return; }
    /* a note just created opens before its snapshot arrives — hold briefly */
    if (Date.now() - openedAt < 8000) {
      ui.body.innerHTML = '<p class="sn-empty">Opening thread&hellip;</p>';
      return;
    }
    openId = null;
  }

  rendered = null;
  if (!list.length) {
    ui.body.innerHTML = '<p class="sn-empty">Nothing here. Use <b>+ Add note</b> to start a thread, ' +
      "or switch to <b>All</b>.</p>";
    return;
  }
  ui.body.innerHTML = list.map(([id, d]) => {
    const n = repliesOf(id).length;
    const st = statusOf(d);
    const anchor = d.anchorLabel || labelFor(d.anchor);
    return `<article class="sn-card ${threadUnread(id, d) ? "new" : ""}" data-id="${id}">
      <div class="sn-card-top">
        <span class="sn-chip ${who(d.author)}">${AUTHORS[who(d.author)]}</span>
        <span class="sn-status ${st}">${STATUS[st].label}</span>
        <span class="sn-time">${when(millis(d))}</span>
      </div>
      ${anchor ? `<div class="sn-anchor">${esc(anchor)}</div>` : '<div class="sn-anchor gen">General note</div>'}
      <p class="sn-excerpt">${esc(String(d.text || "").slice(0, 190)) || "<i>empty</i>"}</p>
      <div class="sn-card-foot">${n ? `${n} repl${n > 1 ? "ies" : "y"}` : "No replies"} &nbsp;&rsaquo;</div>
    </article>`;
  }).join("");
  ui.body.querySelectorAll(".sn-card").forEach(c =>
    c.addEventListener("click", () => openThread(c.dataset.id)));
}

function openThread(id) {
  openId = id;
  openedAt = Date.now();
  rendered = null;                 // force a fresh build, and allow one scroll
  if (!ui.panel.classList.contains("open")) {
    ui.panel.classList.add("open");
    document.body.classList.add("sn-panel-open");
  }
  paintPanel();
  markSeen();
}

function paintThread(id) {
  const d = docs.get(id);
  if (!d) { openId = null; paintPanel(); return; }

  /* Already built? Patch in place. Rebuilding would destroy the element the
     user is typing in — the debounced save round-trips through onSnapshot,
     so a full re-render every keystroke-pause stole focus and re-scrolled. */
  if (rendered === id && ui.body.querySelector(".sn-thread")) { patchThread(id, d); return; }

  const st = statusOf(d);
  const anchor = d.anchorLabel || labelFor(d.anchor);
  const replies = repliesOf(id);

  /* highlight what this thread is about, and bring it into view — on open only */
  document.querySelectorAll(".sn-lit").forEach(e => e.classList.remove("sn-lit"));
  if (d.anchor) {
    const el = document.querySelector(`[data-anchor="${CSS.escape(d.anchor)}"]`);
    if (el) {
      el.classList.add("sn-lit");
      const r = el.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 40) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const msg = (mid, m, root) => `
    <div class="sn-msg ${root ? "root" : ""}" data-id="${mid}">
      <div class="sn-msg-top">
        <span class="sn-chip ${who(m.author)}">${AUTHORS[who(m.author)]}</span>
        <span class="sn-time">${when(millis(m))}</span>
        ${who(m.author) === author ? `<button class="sn-del" data-del="${mid}" title="Delete">&times;</button>` : ""}
      </div>
      <div class="sn-msg-body">${esc(m.text)}</div>
    </div>`;

  ui.body.innerHTML = `
    <button class="sn-back" id="snBack">&lsaquo; All threads</button>
    ${anchor ? `<div class="sn-anchor big">${esc(anchor)}</div>`
             : '<div class="sn-anchor big gen">General note</div>'}
    <div class="sn-statusbar">
      ${Object.entries(STATUS).map(([k, v]) =>
        `<button data-st="${k}" class="${k === st ? "on " + k : ""}" title="${v.hint}">${v.label}</button>`).join("")}
    </div>
    <div class="sn-thread">
      ${msg(id, d, true)}
      ${replies.map(([rid, r]) => msg(rid, r, false)).join("")}
    </div>
    <div class="sn-reply">
      <textarea id="snReply" maxlength="${MAX_TEXT}" rows="3"
        placeholder="Reply as ${AUTHORS[author]}…" aria-label="Reply"></textarea>
      <button class="sn-b pri" id="snSend">Reply</button>
    </div>`;

  ui.body.querySelector("#snBack").addEventListener("click", () => { openId = null; paintPanel(); });
  ui.body.querySelectorAll("[data-st]").forEach(b =>
    b.addEventListener("click", () => setStatus(id, b.dataset.st)));
  ui.body.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", () => removeNote(b.dataset.del, id)));

  const ta = ui.body.querySelector("#snReply");
  const send = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    postReply(id, text);
  };
  ui.body.querySelector("#snSend").addEventListener("click", send);
  ta.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });

  /* editing your own root note in place */
  const rootBody = ui.body.querySelector(".sn-msg.root .sn-msg-body");
  if (who(d.author) === author) {
    rootBody.contentEditable = "true";
    rootBody.classList.add("editable");
    let t = null;
    rootBody.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => write(id, { text: rootBody.innerText.slice(0, MAX_TEXT) }), DEBOUNCE);
    });
  }
  rendered = id;
}

/* Update an already-rendered thread without touching what has focus. */
function patchThread(id, d) {
  const st = statusOf(d);
  ui.body.querySelectorAll("[data-st]").forEach(b => {
    const on = b.dataset.st === st;
    b.classList.toggle("on", on);
    Object.keys(STATUS).forEach(k => b.classList.toggle(k, on && k === st));
  });

  const thread = ui.body.querySelector(".sn-thread");
  const setBody = (el, text) => {
    if (!el || el === document.activeElement || el.contains(document.activeElement)) return;
    if (el.textContent !== text) el.textContent = text;
  };
  setBody(thread.querySelector(".sn-msg.root .sn-msg-body"), String(d.text || ""));

  const live = repliesOf(id);
  const have = new Map([...thread.querySelectorAll(".sn-msg:not(.root)")].map(n => [n.dataset.id, n]));
  live.forEach(([rid, r]) => {
    const node = have.get(rid);
    if (node) { setBody(node.querySelector(".sn-msg-body"), String(r.text || "")); have.delete(rid); }
    else {
      const el = document.createElement("div");
      el.className = "sn-msg";
      el.dataset.id = rid;
      el.innerHTML =
        `<div class="sn-msg-top"><span class="sn-chip ${who(r.author)}">${AUTHORS[who(r.author)]}</span>` +
        `<span class="sn-time">${when(millis(r))}</span>` +
        (who(r.author) === author ? `<button class="sn-del" data-del="${rid}" title="Delete">&times;</button>` : "") +
        `</div><div class="sn-msg-body"></div>`;
      el.querySelector(".sn-msg-body").textContent = String(r.text || "");
      const del = el.querySelector("[data-del]");
      if (del) del.addEventListener("click", () => removeNote(rid, id));
      thread.appendChild(el);
    }
  });
  have.forEach(node => node.remove());   /* deleted elsewhere */
}

/* ============================================================
   writes — every one keeps the six required keys
   ============================================================ */
function base(extra) {
  return Object.assign({
    page: PAGE, author, x: 0, y: 0, text: "", ts: serverTimestamp(), updated: serverTimestamp()
  }, extra);
}
function write(id, patch) {
  updateDoc(doc(db, "notes", id), Object.assign({ updated: serverTimestamp() }, patch))
    .catch(e => console.error("[review] write failed:", e));
}
function setStatus(id, status) {
  if (!STATUS[status]) return;
  write(id, { status });
}
function postReply(rootId, text) {
  addDoc(collection(db, "notes"), base({
    text: text.slice(0, MAX_TEXT), parentId: rootId, anchor: null, anchorLabel: null, status: "open"
  })).then(() => {
    const cur = docs.get(rootId);
    /* a reply from the other side moves an open thread to answered */
    if (cur && statusOf(cur) === "open" && who(cur.author) !== author) setStatus(rootId, "answered");
  }).catch(e => {
    console.error("[review] reply failed:", e);
    alert("Could not post that reply. Check the connection and try again.");
  });
}
function removeNote(id, rootId) {
  const isRootNote = id === rootId;
  const n = isRootNote ? repliesOf(id).length : 0;
  if (!confirm(isRootNote
        ? `Delete this thread${n ? ` and its ${n} repl${n > 1 ? "ies" : "y"}` : ""}? This cannot be undone.`
        : "Delete this reply? This cannot be undone.")) return;
  const kill = [id].concat(isRootNote ? repliesOf(id).map(([rid]) => rid) : []);
  Promise.all(kill.map(k => deleteDoc(doc(db, "notes", k))))
    .then(() => { if (isRootNote) { openId = null; paintPanel(); } })
    .catch(e => console.error("[review] delete failed:", e));
}

/* ============================================================
   adding a note — click the document to attach it
   ============================================================ */
function arm() {
  armed = true;
  document.body.classList.add("sn-placing");
  ui.hint.classList.add("show");
  ui.add.classList.add("arm");
  ui.add.textContent = "Cancel";
  document.addEventListener("mousemove", onHoverTarget, true);
}
function disarm() {
  armed = false;
  document.body.classList.remove("sn-placing");
  ui.hint.classList.remove("show");
  ui.add.classList.remove("arm");
  ui.add.textContent = "+ Add note";
  document.removeEventListener("mousemove", onHoverTarget, true);
  document.querySelectorAll(".sn-target").forEach(e => e.classList.remove("sn-target"));
}
const anchorAt = node => (node && node.closest) ? node.closest("[data-anchor]") : null;

function onHoverTarget(e) {
  if (!armed) return;
  const el = anchorAt(e.target);
  document.querySelectorAll(".sn-target").forEach(x => { if (x !== el) x.classList.remove("sn-target"); });
  if (el && !el.closest(".sn-panel, .sn-toolbar")) el.classList.add("sn-target");
}

function onPlaceClick(e) {
  if (!armed) return;
  if (e.target.closest(".sn-toolbar, .sn-panel, .sn-gate, .sn-hint, .sn-unlock, .nav, .sn-badge")) return;
  e.preventDefault();
  e.stopPropagation();
  const el = anchorAt(e.target);
  const anchor = el ? el.dataset.anchor : null;
  disarm();
  addDoc(collection(db, "notes"), base({
    anchor, anchorLabel: anchor ? labelFor(anchor) : null, status: "open", parentId: null
  })).then(ref => openThread(ref.id))
    .catch(err => {
      console.error("[review] could not create note:", err);
      alert("Could not save that note. Check the connection and try again.");
    });
}

/* ============================================================
   export — the record, grouped by what it is about
   ============================================================ */
const PAGE_TITLE = { proforma: "Pro Forma", placement: "Placement Matrix" };

function exportLog() {
  const order = new Map();
  (index || []).forEach(s => {
    order.set(s.id, order.size);
    s.rows.forEach(r => order.set(r.id, order.size));
  });
  const rank = d => (d.anchor && order.has(d.anchor)) ? order.get(d.anchor) : 1e6;

  const list = roots().sort((a, b) => rank(a[1]) - rank(b[1]) || millis(a[1]) - millis(b[1]));
  const counts = { open: 0, answered: 0, resolved: 0 };
  list.forEach(([, d]) => counts[statusOf(d)]++);

  const out = [
    "Siloa × HyperVend — Joint Review",
    (PAGE_TITLE[PAGE] || PAGE) + " — thread log",
    "Exported: " + new Date().toLocaleString(),
    `Threads: ${list.length}   Open: ${counts.open}   Answered: ${counts.answered}   Resolved: ${counts.resolved}`,
    "", "".padEnd(64, "=")
  ];

  let section = null;
  list.forEach(([id, d], i) => {
    const anchor = d.anchorLabel || labelFor(d.anchor) || "General";
    if (anchor !== section) {
      section = anchor;
      out.push("", "-- " + section + " " + "".padEnd(Math.max(0, 60 - section.length), "-"));
    }
    const stamp = m => millis(m) ? new Date(millis(m)).toLocaleString() : "unsent";
    out.push("",
      `[${i + 1}] ${STATUS[statusOf(d)].label.toUpperCase()} — ${AUTHORS[who(d.author)]} — ${stamp(d)}`,
      ...String(d.text || "(empty)").split("\n").map(l => "    " + l));
    repliesOf(id).forEach(([, r]) => out.push(
      `      ↳ ${AUTHORS[who(r.author)]} — ${stamp(r)}`,
      ...String(r.text || "(empty)").split("\n").map(l => "        " + l)));
  });

  const blob = new Blob([out.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `siloa-hypervend-${PAGE}-threads.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   landing dashboard — state of the review across both documents
   ============================================================ */
const PAGES = [
  { key: "proforma",  title: "Unit Economics Pro Forma", href: "proforma.html" },
  { key: "placement", title: "In-Building Placement Matrix", href: "placement.html" }
];

async function bootLanding() {
  try { author = localStorage.getItem(AUTHOR_KEY) || "siloa"; } catch (e) { /* private mode */ }
  author = LEGACY[author] || author;
  if (!AUTHORS[author]) author = "siloa";

  const host = document.getElementById("snDash");
  if (!host) return;

  if (!ui) { ui = buildChrome(); wireGate(); }
  onUnlocked = () => bootLanding();

  if (session(GATE_KEY) !== "ok") {
    host.innerHTML = '<div class="dash-locked"><p>Enter the review passphrase to see open items and recent activity ' +
      'across both documents.</p><button class="sn-b pri" id="dashUnlock">Show review status</button></div>';
    host.querySelector("#dashUnlock").addEventListener("click", openGate);
    if (!session(GATE_KEY)) openGate();
    return;
  }

  if (!isConfigured || !db) {
    host.innerHTML = '<p class="dash-msg">Notes are not connected yet.</p>';
    return;
  }

  host.innerHTML = '<p class="dash-msg">Loading review status&hellip;</p>';
  try {
    const full = await (await fetch("assets/doc-index.json", { cache: "no-cache" })).json();
    labelMap = new Map();
    Object.values(full).forEach(secs => secs.forEach(sec => {
      labelMap.set(sec.id, sec.label);
      sec.rows.forEach(r => labelMap.set(r.id, r.label));
    }));
  } catch (e) { console.warn("[review] doc index unavailable on dashboard", e); }
  onSnapshot(collection(db, "notes"), snap => {
    const all = [];
    snap.forEach(d => all.push([d.id, d.data()]));
    paintDash(host, all);
  }, err => {
    console.error("[review] dashboard error:", err);
    host.innerHTML = '<p class="dash-msg">Could not load review status.</p>';
  });
}

function paintDash(host, all) {
  const rootsAll = all.filter(([, d]) => !d.parentId);
  const repliesFor = id => all.filter(([, d]) => d.parentId === id);
  const cards = PAGES.map(p => {
    const mine = rootsAll.filter(([, d]) => d.page === p.key);
    const c = { open: 0, answered: 0, resolved: 0 };
    mine.forEach(([, d]) => c[statusOf(d)]++);
    const seen = Number(local(SEEN_KEY + ":" + p.key) || 0);
    const activity = all.filter(([, d]) => d.page === p.key).map(([, d]) => millis(d));
    const last = activity.length ? Math.max(...activity) : 0;
    const fresh = all.filter(([, d]) => d.page === p.key && millis(d) > seen && who(d.author) !== author).length;
    const openList = mine.filter(([, d]) => statusOf(d) === "open")
      .sort((a, b) => millis(a[1]) - millis(b[1]));
    return { p, c, last, fresh, openList, repliesFor, total: mine.length };
  });

  host.innerHTML = cards.map(({ p, c, last, fresh, openList, total }) => `
    <section class="dash-card">
      <header class="dash-head">
        <div>
          <a class="dash-title" href="${p.href}">${p.title}</a>
          <div class="dash-sub">${total} thread${total === 1 ? "" : "s"}${last ? " · last activity " + when(last) : ""}</div>
        </div>
        ${fresh ? `<span class="dash-new">${fresh} new</span>` : ""}
      </header>
      <div class="dash-pills">
        <span class="sn-status open">${c.open} open</span>
        <span class="sn-status answered">${c.answered} answered</span>
        <span class="sn-status resolved">${c.resolved} resolved</span>
      </div>
      ${openList.length ? `<ul class="dash-list">${openList.map(([id, d]) => `
        <li><a href="${p.href}#${encodeURIComponent(d.anchor || "note-" + id)}">
          <span class="sn-chip ${who(d.author)}">${AUTHORS[who(d.author)]}</span>
          <b>${esc(d.anchorLabel || labelFor(d.anchor) || "General note")}</b>
          <span class="dash-ex">${esc(String(d.text || "").slice(0, 110))}</span>
        </a></li>`).join("")}</ul>`
        : (total ? '<p class="dash-none">Every thread on this document is closed.</p>'
                 : '<p class="dash-msg">No notes on this document yet.</p>')}
    </section>`).join("");
}

if (PAGE === "landing") bootLanding();
else if (PAGE) boot();
