# Camping — a page per campout, published to parents

*Owner ask, 2026-08-02: "research fall and spring family camping trips for Cub Scouts (Scoutland
in fall and Camp Rainy Mountain in spring) and add a tab for camping with sub-tabs for each trip
(option to add additional pack camping trips as well). Included should be details pertaining to
what to expect, how to prepare, what to bring, etc. This should be editable depending on
permissions and exposed to parents."*

---

## 1. What it is

A `Camping` workspace between Program and Scouts, with **one sub-tab per campout**. Two are
seeded with real, researched content; a leader can add more, and each new one gets its own tab.
Leaders with edit rights write the pages; everyone else — including every approved parent — reads
them.

It is the first part of this app that is **prose rather than arithmetic**, and that shapes most
of the decisions below.

## 2. Shape

```js
state.camping = {
  trips: [{
    id, name, where, address, when, arrive, depart, cost, url, intro,
    sections: [{ id, title, body }]     // ordered, free-form
  }]
}
```

A small fixed header (the things a parent checks on the way out of the door) plus an **ordered
list of free-form sections**. Not fixed "what to bring" / "what to expect" fields: what a pack
needs to say differs from camp to camp, and the first time somebody wanted to add "how to get
there" a fixed schema would have been wrong.

### The workspace whose sections are data

`WORKSPACES` is a literal array of literal sections everywhere else. Camping declares
`dynamic: 'camping'` and an **empty** `sections: []`, and `sectionsOf(w)` supplies the real list
at render time. The empty literal is load-bearing: `SECTION_HOME` is built from it, and a trip id
must never become a route — ids are generated per trip and mean nothing across devices.

`gotoNav` gained one clause for this. A `sectionId` that `SECTION_HOME` has never heard of, on a
workspace that exists, is now accepted and passed through; `curSection()` re-validates it against
`sectionsOf()`, so a stale or bogus id falls back to the first section instead of rendering
nothing. Previously such an id was silently dropped, which would have made "add a trip and land
on it" impossible without a bare `ui.tab =` assignment — the exact thing the harness forbids.

## 3. Permissions

| Who | Sees | Can edit |
|---|---|---|
| Anonymous / legacy / accounts unavailable | Everything | Yes (`canEdit()` is true — today's behaviour) |
| admin, editor | Everything | Yes |
| viewer (read-only leader) | The same page, rendered as prose | No |
| parent | The published copy, same render | No |
| pending | Nothing | No |

The read-only view is **the same renderer**, not a second one. A separate read-only page would
drift, and the drift would be invisible to whoever was editing.

Every camping action re-checks `canEdit()` even though a viewer never sees the buttons — the
handler is reachable from a stale DOM after a role change mid-session.

## 4. Published to parents

Each trip is rebuilt **field by field** into `packs/{docId}/public/view`, never spread, so a field
added to a trip in some later wave cannot ride along unnoticed. Sections carry `title` and `body`
and nothing else.

This is the one part of the published view that is **verbatim authored text** rather than a
projection of pack data. Two consequences, both handled:

1. **The editor says so, on the page.** *"Everything on this page is published to parents."*
   Somebody will otherwise type a phone number or a family's situation into a section body, and
   there is no unpublish.
2. **A blank trip is not published.** `freshTrip()` leaves the name **empty** on purpose. A
   placeholder like `'New campout'` would be truthy and would sail through the publish filter, so
   the moment a leader added a tab every parent in the pack would get an empty page called "New
   campout". Blank means the filter skips it until somebody writes something, and the editor says
   as much while it is unnamed.

`campText()` escapes first and then adds the small amount of structure people actually use —
blank line for a paragraph, a run of `- ` lines for a list. Nothing else. It can only emit tags it
built itself, which matters more here than anywhere else in the app: a section body is authored on
one device and rendered on every parent's.

The parent Camping tab appears only when the published payload has at least one trip, the same
rule Standings has always followed.

### A bug this turned up

`parent-tab` hard-coded its own tab list:

```js
ui.parentTab = el.dataset.tab === 'standings' ? 'standings' : 'schedule';
```

A third tab was accepted by the strip, rendered by the app, and then **silently swallowed by the
click handler** — every tap on Camping went to Schedule. Now it accepts any tab
`parentTabDefs()` is actually offering.

## 5. The seeded content

Two trips, written as a BALOO-trained leader would brief a new family, and researched rather than
invented. Everything is editable — the seed is a starting draft, not a fact the app insists on.

**Dates and prices go stale every year** and are labelled with the year they came from, so a
leader can see at a glance what needs updating. The fall figures are last-published 2025; the
spring ones are 2026.

| | Fall | Spring |
|---|---|---|
| Camp | Scoutland, Lake Lanier | Camp Rainey Mountain, Clayton |
| Address | 3685 Looper Lake Road, Gainesville GA 30506 | 1494 Rainey Mountain Road, Clayton GA 30525 |
| Size | 140 acres | ~500 acres |
| Typical dates | mid-October | late April |
| Cost | $35/family (2025) | $36–$50/family (2026, three steps) |

Note the spelling: **Rainey**, not Rainy. Getting it wrong sends a family to the wrong search
result.

### What the seed must keep saying

Eight statements are pinned by a harness test. They are not style — they are the things a BALOO
course exists to make sure somebody on the trip knows, and a rewrite that drops them turns the
page into a packing list with a reassuring tone, which is worse than nothing.

- **BALOO** — at least one adult on a pack overnighter must be BALOO-trained.
- **Hazardous Weather** training is required of adults taking the pack camping.
- **Medical form parts A and B** for every participant, youth and adult (under 72 hours: no
  doctor's signature).
- **Shooting sports are not approved unit activities** — BB guns, archery and slingshots are
  permitted only at council-run events and camps, with a certified range master. This is *why* a
  pack drives to a council camp instead of finding a campground, and it is the single most useful
  thing on the page for a leader who has not been told it.
- **No adult shares a tent with a youth who is not their own child.** Parents, guardians and
  siblings share as a family; otherwise a Scout tents with a youth within two years of their age
  and of the same gender.
- **Safeguarding Youth** — the current name for Youth Protection training.
- **Lions do not shoot BB guns** (archery and size-appropriate slingshots only).
- **Fire building is Webelos and up**; Tigers, Wolves and Bears watch.

Two more that are current and easy to get wrong from memory: the **Whittling Chip is gone** — a
Cub Scout now earns the **knife safety Adventure for their rank** and recertifies each year — and
on the water, **Lions and Tigers are passengers only** while Wolves and Bears may paddle.

### Sources

- Scoutland — <https://www.nega-bsa.org/Scoutland> (facilities, acreage, address)
- NEGA family camping — <https://www.nega-bsa.org/family-camp> (spring dates, cost, rules, meals)
- Spring Family Camping 2026 — <https://www.nega-bsa.org/spring-camping>
- Age Appropriate Guidelines for Scouting Activities —
  <https://filestore.scouting.org/filestore/HealthSafety/pdf/680-685.pdf> (the ranks table:
  camping, ranges, knives, fire, paddle sports)
- Pack overnight camping requirements — <https://www.sacscouting.org/PackCamping>
- BALOO — <https://ncacscouting.org/training/baloo/>
- Guide to Safe Scouting, Camping — <https://www.scouting.org/health-and-safety/gss/gss03/>

Weather normals used for the sleeping-bag advice: Gainesville GA averages an October low near
53F; Clayton GA averages an April low near 44F, and the camp sits above the town — which is why
the spring page leads with "they pack for Georgia in April and then sleep in the mountains in
April".

## 6. What deliberately does not happen

- **Rollover does not clear it.** A campout page is reference content that carries across years;
  only the dates change, and those are edited in place.
- **No RSVP, no attendance, no cost line.** A trip page is *information*. The pack's money for a
  campout is a budget line on Money · Budget, and the event is on the calendar. Joining them up
  would mean a trip page could silently change the budget, which is not what anybody asked for.
- **No section reordering.** New sections append. If a pack needs to shuffle them this is the
  first thing to add.
- **One trip means no sub-tab strip** — the app hides a strip with fewer than two items, and the
  trip name is the card heading anyway.
