# Ideal Year of Scouting — Setup Guide

`index.html` is the entire app: one self-contained file, no build step, no dependencies.
Open it in a browser and it works **device-only** — everything is saved in that browser's
local storage. Nothing below is required to use the app.

The optional pieces below turn on **shared sync** (several leaders share one live ledger)
and, on top of that, **accounts & roles** (Google sign-in, so some leaders are view-only and
parents can get a schedule-only dashboard).

- **Part A** — turn on shared sync (Firebase).
- **Part B** — the baseline Firestore security rules (lets everyone with the passphrase edit).
  **Passphrase mode only** — never use these with Part D.
- **Part C** — accounts & roles: Google sign-in, one admin, view-only leaders,
  **parents** who only ever see the schedule and standings, and a **self-serve sign-up link**
  you can blast to every family without knowing their email addresses.
- **Part D** — *(recommended, once C is live)* **single-pack mode**: bake the pack id into the
  page so **nobody ever types a passphrase again**. Leaders open the link, sign in with
  Google, and the admin approves them.

---

## Do it in this order

If you're setting this up from scratch, this is the whole path. **The order is not
cosmetic — steps 2 and 5 are the security-critical ones, in that order.**

| # | Step | Where |
|---|------|-------|
| 1 | **Part A** — create the Firebase project and paste `FIREBASE_CONFIG` into `index.html` | Firebase console + the file |
| 2 | **Part C rules** — enable Google sign-in and **publish the Part C security rules** | Firebase console |
| 3 | **Sign in with Google yourself and claim admin** — you're the first signer, so you're the owner | the app, Pack tab |
| 4 | **Copy the Pack ID** from the Pack tab → Shared sync → *Pack ID* | the app, Pack tab |
| 5 | **Part D** — paste it into `var PACK_DOC_ID` in `index.html` and redeploy | the file |
| — | The passphrase is now gone forever. Approve everyone else from the Members card. | the app |

**Why the order matters.** Until the Part C rules exist, the *only* thing guarding your
pack's data is that its Firestore document id is the SHA-256 hash of a passphrase nobody
outside the pack knows. Part D publishes that id inside a public web page. Doing step 5
before step 2 would therefore hand every visitor on the internet read **and write** access
to your ledger.

The app enforces this rather than trusting you to remember it: with `PACK_DOC_ID` set, it
signs nobody in anonymously, subscribes to nothing and writes nothing until a Google
sign-in has resolved a member role *without* a permission error. If the strict rules aren't
published it shows a full-screen "**This pack needs its security rules published before it
can sync — see SETUP.md Part C**" screen and stays device-only. You can't accidentally
expose the pack by doing it backwards; you'll just get a page that refuses to sync.

Step 4 is self-enforcing too: the **Pack ID** line only ever renders for a signed-in
**admin**, so by the time you can read the id, the ownership claim in step 3 has already
happened and no stranger can claim admin on your pack.

You can stop after Part C and keep using passphrases — everything below Part D is optional.

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

> **Part B is for passphrase mode only.** These rules let *any* signed-in user read and write
> the ledger, and the app signs everyone in anonymously — so the pack is protected purely by
> the document id being an unguessable hash. **Never run these with `PACK_DOC_ID` set**
> (Part D), which publishes that id on a public page. If you go to Part D, publish the Part C
> rules and leave them published.

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

## Part C — Turn on accounts & roles

This adds **Google sign-in** on top of the shared ledger so you can give some leaders
**view-only** access, and hand **parents** a link that shows the pack calendar and standings
and *nothing else*. It's purely additive: the ledger, the passphrase, and device-only mode
all keep working exactly as before. It is also the prerequisite for Part D — publish these
rules **before** you bake the pack id into the page.

How it works:

- A leader taps **Sign in with Google** on the Pack tab. In passphrase mode a passphrase must
  be set first (it picks which pack they're joining); in single-pack mode (Part D) there's
  nothing to type — the page already knows the pack. Parents arriving on the sign-up link
  skip it either way: the link itself says which pack.
- **The first person to sign in becomes the pack admin** (owner). The app records this as an
  immutable `packmeta/{sha256(passphrase)}` document holding their user id.
- **Everyone else who signs in lands as "pending"** and can't edit until the admin approves
  them. On the Pack tab → **Members**, the admin approves each pending person as **Editor**,
  **Viewer** or **Parent**, and can change or remove members later.
- **Or invite them ahead of time.** In the Members card, **Invite someone** takes an email
  address and a role. When that person signs in with Google using that address, they land
  *straight* in the invited role — no approval step, no pending limbo. Outstanding invites
  are listed underneath with a two-tap ✕ to revoke. (Nothing is emailed from the app; send
  them the page link yourself.)
- **Or hand out one self-serve link.** If you don't know every parent's email address, the
  **Parent sign-up link** card (Pack tab, admins only) gives you a single URL you can post to
  the pack's group chat. A family opens it, taps *Sign in with Google*, and — depending on
  the mode you picked — either lands straight in the view-only parent app or waits for you to
  approve them. **Parents never need the passphrase.** See *The parent sign-up link* below.

### The four roles

| Role | Can edit? | What they can see |
|------|-----------|-------------------|
| `admin` | yes | Everything, plus member management, invites and the sign-up link |
| `editor` | yes | Everything |
| `viewer` | no | Everything (the whole ledger), read-only |
| `parent` | no | **Only** the schedule and standings — see below |
| `pending` | no | **Nothing** — a "waiting for approval" screen and a sign-out button |

> **`pending` means waiting.** A not-yet-approved person sees no pack content at all: no
> calendar, no standings, no ledger. Their browser subscribes to nothing. That's what makes
> approval actually gate something. (In earlier versions `pending` saw the parent view; if
> you're upgrading, anyone sitting at `pending` will drop to the waiting screen until an
> admin approves them.)

- `admin` and `editor` can edit; `viewer` is read-only — the app hides the
  add/import/close-out controls, refuses to save or sync their changes, and shows a
  "Read-only" banner. The security rules below are what make view-only *genuinely*
  enforced: a viewer physically cannot write to the ledger, not just in the UI.
- There's always **at least one admin** — the app won't let the last admin be removed or
  demoted.

### What a parent sees (and what they can't)

Firestore security rules can allow or deny a **whole document** — they can't hide *parts*
of one. The ledger is a single document holding the entire pack, so "let parents see the
calendar but not the money" is impossible to do by permission alone. Instead the app keeps a
**second, sanitized document** and gives parents *only* that one:

- `packs/{doc}/public/view` — a derived copy regenerated by leaders' devices after each
  successful save (and once when a leader connects). It contains **only**: the pack name and
  program year, the season's events (storefront dates with their shift windows, den/pack
  meetings with time and location note, dated activities by name), the scout standings
  (name, den, total raised, goal %), the pack goal bars, and the derby winners and design
  awards.
- It **never** contains: the budget, activity costs or expenses, dues or who has paid,
  reward-tier amounts, inventory (products, cases, prices, hand-outs), the leader roster
  (names, phones, emails, training dates, notes), past-season archives, scout notes or den
  labels, RSVP/attendance detail, or the ledger in any raw form.
- Parents and pending users are **denied the ledger document outright** by the rules below,
  so this isn't a UI choice — the pack's finances never reach their browser at all.
- In the app, a parent gets a stripped-down two-tab view (**Schedule** and **Standings**).
  The Pack tab, Members card, Budget, Inventory, Scouts, Advancement and Derby tabs aren't
  rendered for them at all.

**Calendar-only mode.** If you'd rather not publish scout names and totals to a widely-shared
link, untick **Include scout standings in the parent view** in the *Parent sign-up link* card.
The `standings`, `goals` and `derby` keys are then left out of `packs/{doc}/public/view`
**entirely** — not merely hidden in the UI — and parents see only the Schedule tab. Tick it
again and the next leader save republishes them. It's on by default, so a pack that never
touches this behaves exactly as before.

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
      function invitedRole() {
        return get(/databases/$(database)/documents/packs/$(doc)/invites/$(request.auth.token.email)).data.role;
      }
      function joinCfg() {
        return get(/databases/$(database)/documents/packs/$(doc)/public/join).data;
      }
      // Leaders only — parents and not-yet-approved users never receive the ledger.
      allow read:  if myRole() in ['admin', 'editor', 'viewer'];
      allow write: if myRole() in ['admin', 'editor'];

      // The self-serve sign-up switch. Deliberately readable by ANY signed-in user (not just
      // members) so a link visitor can check open/mode/code before creating their own member
      // doc. It holds no pack data — only the on/off switch, the mode and the code, and the
      // code is already in the link they arrived with.
      match /public/join {
        allow read: if request.auth != null;
        allow write: if myRole() in ['admin'];
      }
      // Sanitized, derived copy every member (including parents) may read.
      match /public/{d} {
        allow read:  if isMember();
        allow write: if myRole() in ['admin', 'editor'];
      }
      match /members/{uid} {
        allow read: if isMember();
        allow create: if request.auth.uid == uid
          && ( request.resource.data.role == 'pending'
               || ownerUid() == request.auth.uid
               || request.resource.data.role == invitedRole()
               || ( joinCfg().open == true
                    && request.resource.data.joinCode == joinCfg().code
                    && request.resource.data.role == 'pending' ) );
        allow update, delete: if myRole() == 'admin';
        allow update: if request.auth.uid == uid
          && request.resource.data.role == resource.data.role;
        allow update: if request.auth.uid == uid
          && ownerUid() == request.auth.uid;
      }
      match /invites/{email} {
        allow read: if isMember() || (request.auth != null && request.auth.token.email == email);
        allow create, update, delete: if myRole() == 'admin'
          || (request.auth != null && request.auth.token.email == email);  // consumed on first sign-in
      }
    }
  }
}
```

What these rules guarantee:

- **The first signer becomes admin.** `packmeta` can only be *created* (never updated or
  deleted), and only by a user writing their own id as `owner`. Whoever creates it first
  wins and is the permanent owner/admin.
- **Everyone else starts as pending** — unless an admin invited their email, in which case
  they may create their own member doc with *exactly* the role in that invite. A user may
  create only their **own** member document, so no one can self-promote: the role has to
  match `'pending'`, the owner claim, an invite an admin wrote, or the self-serve join
  config below.
- **The self-serve link can only ever create a `pending` request — never access.** A link
  visitor may create their own member doc **only** when `packs/{doc}/public/join` says
  `open: true` and the `joinCode` they write matches the code in that document, and the rule
  pins the role to `'pending'` outright. So a link plus a Google account gets someone into
  the approval queue and nothing more: an admin still has to accept them and choose Editor,
  Viewer or Parent. There is deliberately **no** auto-approve path, in the app or the rules.
  The client checks the same thing first, but the rule is what actually holds: rotating the
  code (or switching the toggle off) makes every previously-shared link stop working
  immediately, because the server stops matching it.
- **The join document is world-readable to signed-in users, on purpose.** A visitor has to
  read `open`/`mode`/`code` *before* they're a member of anything. It contains no pack data —
  no names, no dates, no money — and the code in it is the same code that was in their link.
  Everything else under `public/` still requires membership.
- **Parents and pending users never receive the ledger.** `packs/{doc}` is readable only by
  `admin`, `editor` and `viewer`. This is the load-bearing line of the whole parent feature:
  the pack's budget, dues, inventory and leader contact details are not filtered out of their
  copy — their browser is never sent a copy at all.
- **The parent view is a separate, leader-written document.** `packs/{doc}/public/view` is
  readable by any member and writable only by `admin`/`editor`. It's regenerated from the
  ledger by a leader's device, so a parent can never make it say something else.
- **View-only is real.** The ledger is writable only when your member role is `admin` or
  `editor`. A **viewer's, parent's or pending user's writes are rejected by the server** —
  the read-only UI is a courtesy; this rule is the actual enforcement.
- **Only admins manage members and invites.** Changing another person's role or removing them
  requires an `admin` role. (Exceptions: writing your own doc back with the same role, and the
  pack owner always being able to restore their own `admin` role — so a rogue co-admin can't
  lock you out.) An invite may also be read and deleted by the invitee themselves, which is
  how it's consumed on their first sign-in.

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
  and everyone keeps editing** — exactly like Part B. *(This "keep editing" fallback is safe
  only because the passphrase is still secret. In single-pack mode — Part D — there is no
  secret left, so the same denial instead stops sync dead and shows the setup screen.)*
- Once you publish the Part C rules, anonymous (not-signed-in) users lose ledger access —
  that's the deliberate flip that turns roles on. From then on, every leader signs in with
  Google, the first becomes admin, and the admin approves the rest as editors, viewers or
  parents.

**Already running an earlier version of the Part C rules?** Re-publishing the block above
changes three things, all deliberate: (1) `pending` members lose ledger access and now see a
"waiting for approval" screen with no pack content until an admin approves them, (2) the
`public/` and `invites/` subcollections start working, and (3) the self-serve sign-up link
becomes available (it stays **off** until an admin turns it on). Nothing else moves — existing
admins, editors, viewers and parents are untouched.

**The parent view appears on its own.** The first time a leader opens the app after the
rules are published, their device publishes `packs/{doc}/public/view`, and it's refreshed
after every save from then on. If parents report an empty screen, have a leader open the
page once. (If *no* leader has the app open, nothing regenerates — that's by design: only
`admin`/`editor` may write it.)

### The sign-up link — the recommended way

One link for **everyone**, leaders and families alike. Use it when you don't know (or don't
want to collect) every email address. Nobody sees the passphrase, so it stays a leaders-only
secret.

1. Pack tab → **Parent sign-up link** (admins only).
2. Tick **Let people request access with a link**.
3. Copy the link and send it out.

**The link never grants access by itself.** Whoever opens it signs in with Google, lands on a
"waiting for approval" screen with no pack content at all, and appears as `pending` in your
Members card. You then accept them as **Editor**, **Viewer** or **Parent** (or ignore them) —
so the same link works to onboard a new den leader and a new family; you decide which they
are at the moment you accept. This is enforced by the security rules, not just the interface:
there is no auto-approve mode in the app *or* the rules.
4. **Copy link** and post it wherever your families already are — group chat, pack email,
   a QR code on a flyer. It looks like
   `https://…/pack569/?pack=<pack id>&join=<code>` — or, in single-pack mode (Part D), just
   `https://…/pack569/?join=<code>`, because the page already knows which pack it is.
5. If the link gets forwarded somewhere you didn't intend, tap **New code** (two taps to
   confirm). A fresh code is written and **every previously-shared link stops working
   immediately** — including for people who haven't opened theirs yet. Anyone who *already*
   joined keeps their access; re-share the new link with everyone else.

What the visitor experiences: the page opens on a small welcome screen with the pack's fleur
mark, one line about what they'll get, and a **Sign in with Google** button. The `pack` and
`join` parameters are copied into that browser's own storage and then **stripped from the
address bar**, so the code isn't left sitting in a screenshot or a shared tab. A refresh or a
return visit still works — the browser remembers the pack it joined.

> **Anyone who receives this link can see the pack calendar and scout standings** — first
> names, dens, totals — **including which store the pack will be at and when.** Treat it as
> public. If that's more than you want to publish, untick *Include scout standings in the
> parent view* for a calendar-only page, and rotate the code whenever the audience changes.

A leader's own device is completely unaffected by any of this: if a passphrase is set, a
stray `?pack=…` parameter is ignored outright — the passphrase always decides which pack that
device is on. In single-pack mode the baked-in `PACK_DOC_ID` decides, and a `?pack=…`
parameter is ignored on *every* device (and scrubbed from the address bar), so a forwarded
link from some other pack can never re-point the page.

### Inviting one specific parent by email

1. Members card → **Invite someone** → their email → role **parent** → *Send invite*.
2. Send them the page link. If you have the sign-up link turned on — or you're in single-pack
   mode — send **that** URL and they never need a passphrase; in passphrase mode without the
   sign-up link, you'd have to send the plain page URL plus the passphrase.
3. They tap **Sign in with Google** with that address and land on a two-tab, view-only
   Schedule + Standings screen. They never see the money.

> **If a parent has to type the passphrase** (i.e. you're not using the sign-up link), it is
> no longer a secret shared only among leaders — so **don't revert to the Part B rules once
> parents have it**, because under Part B anyone holding the passphrase can edit the whole
> ledger again. If you ever need to go back, change the passphrase first (Pack tab → Shared
> sync) and re-share the new one with leaders only. The sign-up link avoids this problem
> entirely, which is why it's the recommended route.

To turn accounts **off** again, re-publish the Part B rules; the app falls back to
"anyone with the passphrase edits" with no code changes. Turn the sign-up link toggle **off**
first, and read the passphrase warning above if parents already know it. **If you're in
single-pack mode (Part D), set `PACK_DOC_ID` back to `null` and redeploy *before* you touch
the rules** — otherwise you'd be publishing the pack id under Part B rules, which is exactly
the combination that exposes the ledger. (The app will refuse to sync and show the setup
screen rather than let that happen, but don't rely on it: put the constant back first.)

---

## Part D — Single-pack mode: retire the passphrase (recommended)

Once Part C is live, the passphrase isn't protecting anything any more — Google sign-in plus
the admin's approval is what decides who gets in. It's just one more thing to explain, mistype
and leak. Part D removes it entirely: you bake this pack's document id into the page, and from
then on **nobody ever types a passphrase**. A leader opens the link, taps *Sign in with
Google*, and waits for you to approve them in the Members card.

> **Publish the Part C rules first. This step makes your pack's document id public.**
> Under the Part B rules the id *is* the password. Read *Do it in this order* at the top of
> this guide before you continue.

> **One thing the app can't detect for you: Firestore "test mode" rules.** The safety gate
> works by noticing that the accounts reads were *denied*. Rules that allow everything
> (`allow read, write: if true`, which is what "Start in test mode" publishes, and what
> expires after 30 days) deny nothing, so the app can't tell them apart from the real Part C
> rules — and with a public pack id those rules mean anyone can read and edit your pack.
> Before Part D, open **Firestore Database → Rules** and confirm the text there is the Part C
> block, character for character.

### 1. Claim admin (if you haven't already)

Open the page with the passphrase set, tap **Sign in with Google**, and confirm the Pack tab →
**Members** card shows you as `admin`. Whoever signs in first becomes the permanent owner, so
do this before handing the passphrase (or the page) to anyone else.

### 2. Copy the Pack ID

Pack tab → **Shared sync** → **Pack ID**. It's a 64-character hex string, with a **Copy**
button next to it. Only a signed-in **admin** sees this line — which is the point: the id is
the SHA-256 of the passphrase, so only a device that already knows the passphrase can compute
it, and only the admin is shown it.

### 3. Paste it into `index.html`

Near the top of the `<script>`, just below `FIREBASE_CONFIG`:

```js
var PACK_DOC_ID = null;                 // before
var PACK_DOC_ID = '3f8a…64 hex chars';  // after
```

Redeploy the page (for GitHub Pages: commit and push). That's the whole change.

If the value isn't a 64-character lowercase hex string, the app ignores it completely, logs a
one-line warning to the browser console, and stays in passphrase mode — it never half-applies
a bad id and lands you on the wrong pack.

### 4. What changes

- **The passphrase field is gone** from the Pack tab. So is every mention of typing one.
- **Everyone signs in with Google.** Signed-out visitors get the welcome screen with a single
  *Sign in with Google* button; a new signer lands as `pending` and waits for an admin.
- **The sign-up link loses its `?pack=` parameter** — it's now just
  `https://…/pack569/?join=<code>`. The code, rotation and the standings toggle all work
  exactly as before, and it still only ever creates a `pending` request. Old two-parameter
  links still work.
- **The pack id wins over everything.** A leftover passphrase in some leader's browser, or a
  forwarded `?pack=…` link from another pack, changes nothing: the page is pinned to this pack.
- **No anonymous sessions.** In passphrase mode the app signs everyone in anonymously; in
  single-pack mode it never does, and it ignores a stale anonymous session left over from
  before the switch. An anonymous visitor has no member document, so the Part C rules would
  deny them anyway — this just means they never even ask.
- **Everything else is untouched:** the ledger format, `localStorage`, device-only mode,
  roles, invites, the parent view, backups.

### 5. If something's wrong

| What you see | What it means |
|---|---|
| "This pack needs its security rules published before it can sync — see SETUP.md Part C" | `PACK_DOC_ID` is set but the Part C rules aren't published (or aren't published *correctly*). The app is refusing to sync **on purpose** and is device-only until you fix it. Publish the rules from Part C, then reload. |
| The welcome / sign-in screen when you expected the app | You're signed out. Single-pack mode has no anonymous fallback — sign in with Google. |
| "Waiting for approval" | You signed in but no admin has approved you yet. |
| Console warning about `PACK_DOC_ID` | The value isn't a valid 64-hex id; the app fell back to passphrase mode. Re-copy it from the Pack tab. |

To go back to passphrase mode, set `PACK_DOC_ID = null`, redeploy, and type the passphrase on
each leader's device again. Nothing in the cloud has to change — it's the same pack, the same
document, the same members.
