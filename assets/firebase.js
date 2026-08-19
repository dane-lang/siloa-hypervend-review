/* ============================================================
   Firebase init — Siloa × HyperVend joint review notes
   Firestore project: siloa-review-notes
   Modular v10 CDN imports.

   Config below is live, from web app siloa-review-notes-web.
   Firestore: (default) database, Native mode, location nam5.
   If the values are ever replaced with PASTE_ placeholders again,
   the pages still render and the notes layer reports that it is
   not connected rather than erroring.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const firebaseConfig = {
  apiKey:            "AIzaSyCentpfoX2f8PRm3YVxphOHVeVVW-WfU6A",
  authDomain:        "siloa-review-notes.firebaseapp.com",
  projectId:         "siloa-review-notes",
  storageBucket:     "siloa-review-notes.firebasestorage.app",
  messagingSenderId: "74984759139",
  appId:             "1:74984759139:web:4a91e36829cb035511bd56"
};

/* SHA-256 of the shared notes passphrase. Placeholder below is the
   hash of "SILOA-HV-2026". To change the passphrase, run:
     printf 'NEW-PASSPHRASE' | sha256sum
   and paste the hex digest here. */
export const PASSPHRASE_SHA256 =
  "7cf06636424c4cef55bab49164c6df7acba8393ada345f71b01d055e17ac7c27";

/* True once real credentials are in place. */
export const isConfigured =
  Object.values(firebaseConfig).every(v => typeof v === "string" && !v.startsWith("PASTE_"));

let _db = null;
if (isConfigured) {
  try {
    _db = getFirestore(initializeApp(firebaseConfig));
  } catch (err) {
    console.error("[siloa-notes] Firebase init failed:", err);
  }
}

export const db = _db;
