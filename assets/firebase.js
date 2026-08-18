/* ============================================================
   Firebase init — Siloa × HyperVend joint review notes
   Firestore project: siloa-review-notes
   Modular v10 CDN imports.

   >>> ACTION REQUIRED <<<
   Replace the placeholder values below with the firebaseConfig
   object from the Firebase console:
     Project settings -> General -> Your apps -> Web app -> SDK setup
   Nothing else in this file needs to change. Until real values are
   pasted, the pages render normally and the notes layer reports
   that it is not yet connected instead of erroring.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const firebaseConfig = {
  apiKey:            "PASTE_API_KEY",
  authDomain:        "siloa-review-notes.firebaseapp.com",
  projectId:         "siloa-review-notes",
  storageBucket:     "siloa-review-notes.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId:             "PASTE_APP_ID"
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
