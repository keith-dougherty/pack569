# Design — separating the plan, the money, and the calendar

**Status:** proposal, not built. Written 2026-07-26.
**Problem:** budgeting and spending are the same record, so neither can be done properly.

---

## 1. The problem, concretely

One record does three unrelated jobs:

```js
activity = { id, slot, date, time, endTime, location, note, sourceUid,  // a calendar event
             estCents, actualCents,                                      // a budget line
             perScout, familyPays }                                      // a billing rule
```

`state.budget.activities` is read by **14 functions, and half of them are calendar code**:

| Calendar readers | Money readers |
|---|---|
| `dayEventsForMonth` · `nextUpEvents` · `monthAgendaCard` · `renderCalendarTab` · `buildICS` · `monthlyDigest` · `buildParentView` | `renderBudget` · `computeBudget` · `homeTasks` · `packFlow` · `seedStandardYear` · `activitiesInSlot` · `buildSeasonArchive` |

That single fact is the whole design problem. An activity is two records that happen to share a row.

### What it costs us today

| Symptom | Root cause |
|---|---|
| Importing a BAND calendar writes **budget rows** | event and budget line are one record |
| `$42 actual × 10 scouts` even if 6 attended | `actualCents` is a *rate*, not a transaction |
| Can't record two receipts against one line | one `actualCents` field per line |
| Can't reconcile to the bank statement | **there are no transactions at all** |
| Reward-tier coverage needed special-casing inside `computeBudget` | no family-account layer to credit |
| "Is this line per-scout?" answers three questions at once | `perScout` = unit of measure *and* who owes *and* (proposed) attendance |

`bud.balance` is a **model output**, not a reconciled cash position. It is computed as
`startingBalance + commission + retainedCash + feesCollected + otherFundraisers − actual`.
Every term is derived from another subsystem. Nothing in the app can be checked against a bank
statement, which is what a treasurer is actually accountable for.

---

## 2. What Scouting America actually prescribes

**The budget worksheet is planning only.** The [Pack Operating Budget (510-278)](https://filestore.scouting.org/filestore/pdf/510-278_wb.pdf)
is every line as `cost per person × number of people = total`, in fixed categories, totalling to:

```
A) Total budgeted program expenses
B) Income subtotal  (annual dues · prior-year surplus · other parent payments)
C) Total fundraising need = A − B      →  C ÷ commission% = pack popcorn goal
                                       →  pack goal ÷ scouts = per-scout goal
```

There is **no "actual spent" column anywhere on it.**

**Actuals live in a separate ledger.** Per the [unit budgeting guidelines](https://lhcscouting.org/wp-content/uploads/2021/09/unit-budgeting-guidelines.pdf),
the treasurer must *"enter all income and expenditures **under the proper budget item** in the
finance section of the Pack Record Book"* and *"check all disbursements **against budget
allowances**."* Two records: a plan, and transactions posted against it.

**Two principles that shape the design:**

- *"Plan to pay for everything… even if you don't end up paying for all of them. Your budget
  should reflect the **true cost** of Scouting."* → Planned is deliberately generous. Variance is
  normal and expected; the app should present it, not hide it.
- *"A Scout pays his own way"* means **plan on raising the money**, not billing families per
  event. Per-event family billing is a real thing packs do, but it is the exception in the
  official model — so it belongs in its own subsystem, not woven through the budget.

**Scout accounts have a legal boundary.** Per-scout fundraising credit is a Scout Account, subject
to IRS direct-benefit limits — commonly 60/40 with the majority of *net* proceeds to the unit, and
[never a payment to a Scout or family](https://blog.scoutingmagazine.org/2014/12/03/individual-scout-accounts/).
Our reward tiers cover *pack charges*, which is on the right side of that line, but the boundary
should be visible in the model.

---

## 3. The proposed model — four records

```
EVENT            what the pack is doing        (Program)
  ↓ referenced by
BUDGET LINE      what we plan it to cost       (Money · Budget)
  ↓ posted against by
LEDGER ENTRY     what actually moved           (Money · Ledger)          ← new
  ↓ charges raised onto
FAMILY ACCOUNT   what each family owes/paid    (Money · Dues & fees)     ← reworked
```

### 3.1 Event — `state.events[]`

Pure calendar. No money.

```js
{ id, kind: 'pack'|'den'|'activity'|'storefront', den, name,
  date, time, endTime, location, note, slot, sourceUid }
```

Absorbs today's `meetings[]` and the calendar half of `budget.activities[]`. `sourceUid`
round-trips ICS. RSVP and attendance key off `event.id` — one mechanism instead of today's split
between `attendance[meetingId]` (meetings only) and `rsvps['act:'+id]` (activities only).

### 3.2 Budget line — `state.budget.lines[]`

The plan. Mirrors 510-278.

```js
{ id, category,                  // 'registration'|'charter'|'advancement'|'recognition'
                                 // |'events'|'activities'|'camp'|'materials'|'training'
                                 // |'uniforms'|'reserve'|'other'|'income'
  name,
  basis: 'per-scout'|'per-adult'|'flat',
  costPerCents,                  // the rate
  count,                         // 0 = "use the live roster count"
  eventId,                       // optional link to an Event
  familyPays }                   // does this raise a family charge?
```

`planned = costPerCents × (count || rosterCount(basis))`. **Planned never moves on its own** —
that's the point of a plan. `actualCents` is *gone*; actual is derived from the ledger.

### 3.3 Ledger entry — `state.ledger[]` *(new)*

What actually moved. This is the record that makes the app reconcilable.

```js
{ id, date, description,
  amountCents,                   // always positive
  direction: 'in'|'out',
  lineId,                        // which budget line it posts against ('' = uncategorised)
  method: 'check'|'cash'|'card'|'transfer'|'',
  ref,                           // check number / receipt
  scoutId }                      // set when it's a family payment
```

Then:

- **Actual for a line** = `Σ ledger where lineId = line.id`
- **Balance** = `startingBalance + Σ in − Σ out` — a real cash position that can be compared to a
  bank statement, which is the whole point
- **Budget vs actual** = per line, per category, and in total — with variance

Popcorn commission, cash donations and other fundraisers become *ledger entries* (posted to
income lines) rather than figures the budget recomputes from three other subsystems. The Popcorn
workspace still computes what it's owed; the Kernel or Treasurer posts it once, on the day the
council cheque clears — which is when it's actually true.

### 3.4 Family account — `state.charges[]` and payments in the ledger

```js
charge = { id, scoutId, lineId, amountCents, date, waivedBy }   // waivedBy = reward tier id
```

- A `familyPays` budget line **raises a charge per scout** — optionally only for attendees.
- Payments are ledger entries with a `scoutId`.
- **Reward-tier coverage becomes `waivedBy`** — a charge that exists and is explicitly waived,
  rather than a scout silently missing from a collect grid. That's auditable, and it makes the
  Scout Account boundary measurable: total waived vs total net proceeds.
- Balance per family = `Σ charges − Σ payments`.

Attendance now lands cleanly: it decides **which charges are raised**, not what the pack spent —
because what the pack spent is whatever the ledger says.

---

## 4. How today's features map on

| Today | Becomes |
|---|---|
| `budget.activities[]` | one Event + one budget line, linked by `eventId` |
| `budget.expenses[]` | budget lines with no `eventId` |
| `activity.actualCents × roster` | Σ ledger entries on that line |
| `collected[key][scoutId] = true` | a charge + a payment ledger entry |
| reward tier `covers[]` | charges with `waivedBy = tierId` |
| `computeBudget().commission` | an income ledger entry, posted when it lands |
| `meetings[]` + `attendance[]` | Events + attendance keyed on `event.id` |
| storefront `salesCents`/`donationsCents` | unchanged — popcorn keeps its own subsystem |

Popcorn stays as it is. It is a *fundraiser* with its own per-scout credit model; it feeds the
ledger at one seam (commission received, cash deposited) rather than being wired into the budget's
internals.

---

## 5. Migration

Non-negotiable: **`version` stays `1`**, migration is in `normalizeState`, and no ledger is ever
destroyed. There is precedent — `cashInCommission`/`cashInGoal` were migrated and deleted in place.

**Phase 0 — ledger alongside.** Add `state.ledger = []`, a Money · Ledger section, and manual
entry. Nothing else changes; `computeBudget` still works exactly as today. Immediately useful on
its own: a real cheque register.

**Phase 1 — derive actual from the ledger.** For each budget line with `actualCents > 0`, write one
ledger entry (date = event date, else program-year end, description = line name). Then
`actual = Σ ledger`, and `actualCents` is deleted. Totals must be **identical before and after** —
that's the migration test.

**Phase 2 — split events out.** Create `state.events[]` from `meetings[]` + the calendar half of
`budget.activities[]`. Repoint the seven calendar readers. Budget lines keep `eventId`. Delete the
calendar fields from budget lines.

**Phase 3 — charges and family accounts.** Generate charges from `collected[]` history, waived
where a reward tier covered them. Rework Dues & fees onto charges. Attendance-driven charging
becomes available here.

**Phase 4 — categories.** Adopt the 510-278 category list, defaulting existing lines to `other`.
Add the A − B = C fundraising-need summary and the derived per-scout popcorn goal.

Each phase is shippable and reversible on its own. Phase 0 and 1 are worth doing even if we stop
there — they're what make the balance real.

---

## 6. What deliberately does not change

- Single file, no build step, no dependencies.
- `version: 1`; every change additive in `normalizeState`.
- Popcorn: storefronts, shifts, standings, tiers, inventory, Trail's End import.
- Advancement, derby, roster, jobs, sync, roles, parent view.
- Close-out and archives — though the archive gains real actuals.

---

## 7. Open decisions

1. **Does the pack bill families per event, or fundraise to cover?** If mostly the latter, family
   accounts stay a small side-ledger and Phase 3 can wait.
2. **How real does the ledger need to be?** Categorised spending only, or true reconciliation
   against monthly bank statements (BSA assumes the latter, with a quarterly audit)?
3. **Attendance → charges.** Raise a charge only for attendees, for RSVP-yes, or for the whole
   roster? *(This is the question that started this — it belongs here, not in the budget.)*
4. **Scout Account ceiling.** Should the app warn when total tier-waived value approaches a share
   of net proceeds? Common guidance is 60/40 to the unit.
5. **Categories.** Adopt 510-278's list verbatim, or a shorter pack-specific one?
