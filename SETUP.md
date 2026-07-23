# Ideal Year of Scouting — Setup Guide

`index.html` is the entire app: one self-contained file, no build step, no dependencies.
Open it in a browser and it works **device-only** — everything is saved in that browser's
local storage. Nothing below is required to use the app.

The optional pieces below turn on **shared sync** (several leaders share one live ledger)
and, on top of that, **accounts & roles** (Google sign-in so some leaders can view-only).

- **Part A** — turn on shared sync (Firebase).
- **Part B** — the baseline Firestore security rules (lets everyone with the passphrase edit).
- **Part C** — *(optional)* accounts & roles: Google sign-in, one admin, view-only members.

---

## Part A — Turn on shared sync (optional)

1. Go to <https://console.firebase.google.com> and create a free project.
2. **Build → Authentication → Sign-in method → enable "Anonymous".**
3. **Build → Firestore Database → Create database** (Production mode is fine — you'll paste
   rules in Part B).
4. **Project settings → Your apps → add a Web app**, then copy the config object
   (`apiKey`, `authDomain`, `projectId`, …).
5. In `index.html`, find `var FIREBASE_CONFIG = { … }` near the top of the `<script>` and
   paste your config in place of the existing one.
6. Every leader opens the page and, on the **Pack** tab → **Shared sync**, types the *same*
   passphrase. They now share one live ledger.

The passphrase selects which shared copy you're on — its SHA-256 hash is the Firestore
document id (`packs/{sha256(passphrase)}`). It never leaves the device except as that hash.
Leave `FIREBASE_CONFIG` as `null` for pure device-only mode.

---

## Part B — Baseline security rules

In **Firestore Database → Rules**, publish this. It lets any signed-in user (the app signs
everyone in anonymously) read and write the shared ledger — i.e. **anyone with the
passphrase can view and edit**. This is the default, and all you need if you're not using
Part C.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /packs/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```

---

## Part C — Turn on accounts & roles (optional)

This adds **Google sign-in** on top of the shared ledger so you can give some leaders
**view-only** access while others can edit. It's purely additive: the ledger, the
passphrase, and device-only mode all keep working exactly as before.

How it works:

- A leader taps **Sign in with Google** on the Pack tab (a passphrase must be set first —
  it picks which pack they're joining).
- **The first person to sign in becomes the pack admin** (owner). The app records this as an
  immutable `packmeta/{sha256(passphrase)}` document holding their user id.
- **Everyone else who signs in lands as "pending"** and can't edit until the admin approves
  them. On the Pack tab → **Members**, the admin approves each pending person as **Editor**
  (can edit) or **Viewer** (read-only), and can change or remove members later.
- **Roles:** `admin` and `editor` can edit; `viewer` and `pending` are **read-only** — the
  app hides the add/import/close-out controls for them, refuses to save or sync their
  changes, and shows a "Read-only" banner. The security rules below are what make view-only
  *genuinely* enforced: a viewer physically cannot write to the ledger, not just in the UI.
- There's always **at least one admin** — the app won't let the last admin be removed or
  demoted.

### 1. Enable Google sign-in in the Firebase console

1. **Build → Authentication → Sign-in method → Add new provider → Google → Enable → Save.**
2. Set a support email if prompted.
3. **Authentication → Settings → Authorized domains** — make sure the domain you serve the
   page from is listed (for GitHub Pages that's `<your-user>.github.io`; `localhost` is
   already allowed for testing).

Keep **Anonymous** enabled too (Part A) — leaders who don't sign in still sync anonymously.

### 2. Publish the accounts security rules

Replace the Part B rules with these in **Firestore Database → Rules → Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /packmeta/{doc} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.data.owner == request.auth.uid;
      allow update, delete: if false;
    }
    match /packs/{doc} {
      function memberDoc() {
        return get(/databases/$(database)/documents/packs/$(doc)/members/$(request.auth.uid)).data;
      }
      function isMember() {
        return request.auth != null
          && exists(/databases/$(database)/documents/packs/$(doc)/members/$(request.auth.uid));
      }
      function myRole() { return isMember() ? memberDoc().role : 'none'; }
      function ownerUid() {
        return get(/databases/$(database)/documents/packmeta/$(doc)).data.owner;
      }
      allow read:  if isMember();
      allow write: if myRole() == 'admin' || myRole() == 'editor';
      match /members/{uid} {
        allow read: if isMember();
        allow create: if request.auth.uid == uid
          && ( request.resource.data.role == 'pending' || ownerUid() == request.auth.uid );
        allow update, delete: if myRole() == 'admin';
        allow update: if request.auth.uid == uid
          && request.resource.data.role == resource.data.role;
        // The pack owner can always rewrite their OWN member doc (e.g. restore themselves
        // to admin if another admin ever demoted them). Owners can't touch anyone else's.
        allow update: if request.auth.uid == uid
          && ownerUid() == request.auth.uid;
      }
    }
  }
}
```

What these rules guarantee:

- **The first signer becomes admin.** `packmeta` can only be *created* (never updated or
  deleted), and only by a user writing their own id as `owner`. Whoever creates it first
  wins and is the permanent owner/admin.
- **Everyone else starts as pending.** A user may create *only their own* member document,
  and only with `role: 'pending'` — unless they're the owner, who may write themselves
  `admin`. No one can self-promote.
- **View-only is real.** The ledger (`packs/{doc}`) is writable only when your member role is
  `admin` or `editor`. A **viewer's or pending user's writes are rejected by the server** — the
  read-only UI is a courtesy; this rule is the actual enforcement.
- **Only admins manage members.** Changing another person's role or removing them requires an
  `admin` role. (Exceptions: writing your own doc back with the same role, and the pack owner
  always being able to restore their own `admin` role — so a rogue co-admin can't lock you out.)

> **Share the passphrase only with trusted leaders — and become admin first.** The `packmeta`
> ownership claim is permanent: whoever signs in first with a given passphrase becomes the
> admin forever, and it can't be transferred or reset (short of moving the pack to a new
> passphrase). So publish these rules, then **sign in yourself before handing the passphrase
> to anyone else.** Anyone who knows the passphrase and signs in before you could otherwise
> claim admin.

### Order of operations & the safe default

**Until you publish the Part C rules, everyone with the passphrase still edits — that's the
safe default.** The app is built so it never breaks while the console is half-configured:

- If Google sign-in isn't enabled yet, the **Sign in with Google** button just shows a
  "Google sign-in isn't enabled yet — see the SETUP guide" note and the app stays in
  anonymous/passphrase mode.
- If the Part C rules aren't published yet, the accounts reads are denied, the app treats
  accounts as "not set up" (the Members card shows a setup hint), **roles are not enforced,
  and everyone keeps editing** — exactly like Part B.
- Once you publish the Part C rules, anonymous (not-signed-in) users lose ledger access —
  that's the deliberate flip that turns roles on. From then on, every leader signs in with
  Google, the first becomes admin, and the admin approves the rest as editors or viewers.

To turn accounts **off** again, re-publish the Part B rules; the app falls back to
"anyone with the passphrase edits" with no code changes.
