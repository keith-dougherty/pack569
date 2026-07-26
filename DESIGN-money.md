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

The plan. Mirrors 510-278, with one addition this pack needs: a pack event is priced **per head,
and a scout brings a parent**, so a single event carries two rates.

```js
{ id, category,                  // 'registration'|'charter'|'advancement'|'recognition'
                                 // |'events'|'activities'|'camp'|'materials'|'training'
                                 // |'uniforms'|'reserve'|'other'|'income'
  name,
  basis: 'per-head'|'flat',
  scoutRateCents,                // what one scout costs
  adultRateCents,                // what one accompanying adult costs (0 = adults free)
  flatCents,                     // used when basis === 'flat'
  eventId,                       // optional link to an Event
  payer: 'pack'|'family'|'council' }
```

**`payer` is load-bearing** and replaces the old `familyPays` boolean:

| `payer` | Money moves | In the pack's books? | Example |
|---|---|---|---|
| `pack` | pack pays, nobody is charged | yes — expense only | charter fee, awards, program materials |
| `family` | pack pays the vendor, families reimburse | yes — expense **and** charges | Blue & Gold, pack campout |
| `council` | **family pays council directly** | **no** — informational only | day camp, resident camp |

`council` lines never touch the ledger and never produce a pack charge. They exist so the
committee can see the true cost of the year to a family, and so the event still appears on the
calendar — but a council camp fee is not the pack's money and must never move the pack's balance.
Today's model has no way to express that, so those costs either distort the budget or go
unrecorded.

`planned = flatCents`, or `scoutRateCents × scouts + adultRateCents × adults`.
**Planned never moves on its own** — that's the point of a plan. `actualCents` is *gone*; actual is
derived from the ledger.

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

A `payer: 'family'` line raises **two charges per attending scout** — one for the scout, one for
the accompanying adult — because that is how the cost is actually incurred.

```js
charge = { id, scoutId, lineId, who: 'scout'|'adult',
           amountCents, date, waivedBy }        // waivedBy = reward tier id
```

**This pack's rule, expressed exactly:**

> Until a scout reaches a fundraising tier, the family covers **both** the scout and the parent.
> Once the tier is reached, the family covers **only the parent** — the scout's share is paid from
> fundraising.

So a reward tier waives **`who: 'scout'` charges only**. The adult charge always stands. In the
model that is a one-line rule, and it is the entire feature:

```js
waived = (charge.who === 'scout') && scoutReachedTier(charge.scoutId, line)
```

**Where this sits relative to the two models Scouting America describes.** The unit budgeting
guidelines offer a choice:

- **Full funding** — *"all money goes to the unit and all activities are paid for all Scouts,"*
  with fundraising incentivised only by prize programs. What a family pays is unrelated to what
  their scout sold, so there is nothing to stop free-riding.
- **Scout Accounts** — a share of **net** proceeds credited to the individual scout, commonly
  60/40 to the unit. This is the model that carries IRS direct-benefit exposure, which is why the
  guidance caps it by percentage and forbids ever paying a Scout or family.

This pack's rule is a third option and avoids the weakness of each. There are **no individual
account balances**, so there is no direct-benefit surface to manage — but crossing a threshold
buys the scout's own seat, so effort still changes the outcome. Threshold-based rather than
proportional-credit-based.

It also sits comfortably with *"plan on raising the money you need, rather than asking your
families to pay out for each event"*: the family charge is what happens **until** fundraising
covers it, not instead of fundraising. The adult charge remaining is the part that was never a
scout's to earn.

- Payments are ledger entries carrying a `scoutId`.
- **Waived is recorded, not absent.** A waived charge still exists, marked with the tier that
  waived it — so the ledger shows what the pack absorbed, per scout, per event. That is auditable,
  and it makes the Scout Account boundary *measurable*: total waived vs total net proceeds.
- Family balance = `Σ unwaived charges − Σ payments`.

Attendance now lands cleanly: it decides **which charges are raised**, not what the pack spent —
because what the pack spent is whatever the ledger says. And `council` lines raise no charges at
all, since that money never passes through the pack.

#### Worked example

Blue & Gold, `scoutRate $15`, `adultRate $15`, 10 scouts + 10 adults attending, 3 scouts past the
tier. Pack pays the hall $340.

```
Ledger  OUT  $340.00   Blue & Gold — venue          → line "Blue & Gold"
Charges      20 raised: 10 scout @ $15, 10 adult @ $15   = $300.00
             3 scout charges waived by tier "Dues covered" = −$45.00
             families owe $255.00
Ledger  IN   $255.00 as families pay (one entry each, scoutId set)

Line result: planned $300 · actual $340 · recovered $255 · pack absorbed $85
             ($45 tier-waived + $40 overspend)
```

Every one of those numbers is a stored record, not a derivation. That is what makes it a book.

---

## 4. How today's features map on

| Today | Becomes |
|---|---|
| `budget.activities[]` | one Event + one budget line, linked by `eventId` |
| `budget.expenses[]` | budget lines with no `eventId` |
| `activity.actualCents × roster` | Σ ledger entries on that line |
| `collected[key][scoutId] = true` | a charge + a payment ledger entry |
| reward tier `covers[]` | tier threshold waives `who: 'scout'` charges |
| `familyPays` boolean | `payer: 'pack'\|'family'\|'council'` |
| camp fees in the pack budget | `payer: 'council'` — visible, outside the books |
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

**Phase 0 — the ledger, and bank reconciliation.** Add `state.ledger = []`, a Money · Ledger
section with entry, filtering and a running balance, plus a **reconcile** view: tick entries
against a bank statement, enter the statement closing balance, see the difference. Nothing else
changes — `computeBudget` still works exactly as today, so the app keeps functioning while the
Treasurer starts keeping the real book alongside it.

*This is now the load-bearing phase.* Everything after it is about removing the duplicate,
derived version of numbers the ledger already holds.

**Phase 1 — derive actual from the ledger.** For each budget line with `actualCents > 0`, write
one ledger entry (date = event date, else program-year end, description = line name). Then
`actual = Σ ledger`, and `actualCents` is deleted. Totals must be **identical before and after** —
that is the migration test, and it should be a test in `test/harness.mjs`, not a spot-check.

**Phase 2 — split events out.** Create `state.events[]` from `meetings[]` + the calendar half of
`budget.activities[]`. Repoint the seven calendar readers. Budget lines keep `eventId`. Delete the
calendar fields from budget lines.

**Phase 3 — payer, charges and family accounts.** Introduce `payer`, migrating `familyPays: true`
→ `'family'` and `false` → `'pack'` (nothing becomes `'council'` automatically — that is a
judgement call per line, prompted once). Add `scoutRate`/`adultRate`. Generate charges from
`collected[]` history, waived where a tier covered them. Rework Dues & fees onto charges. The
attendance/RSVP question (decision 5) is answered here.

**Phase 4 — categories and the funding summary.** Adopt the 510-278 category list, defaulting
existing lines to `other`. Add the `A − B = C` fundraising-need summary and the derived per-scout
popcorn goal — replacing today's hand-entered Trail's End goal with one computed from the plan.

Each phase is shippable and reversible on its own. **Phases 0 and 1 alone make the balance real**
and are worth doing even if the rest waits.

---

## 6. What deliberately does not change

- Single file, no build step, no dependencies.
- `version: 1`; every change additive in `normalizeState`.
- Popcorn: storefronts, shifts, standings, tiers, inventory, Trail's End import.
- Advancement, derby, roster, jobs, sync, roles, parent view.
- Close-out and archives — though the archive gains real actuals.

---

## 7. Decisions

**Settled (owner, 2026-07-26):**

1. **The Treasurer keeps the full books in this app.** Not categorised spending — a real ledger
   that reconciles to the bank statement. This raises Phase 0 from "nice register" to the
   foundation everything else sits on.
2. **Families are billed per event, per head** — scout and accompanying parent both.
3. **A fundraising tier waives the scout's share only.** The adult share always stands.
4. **Council events are paid by families directly to council** and never enter the pack's books —
   `payer: 'council'`, on the calendar, costed for families, invisible to the balance.

**Still open:**

5. **Attendance → charges.** Raise a charge for everyone on the roster, for RSVP-yes, or only for
   those who actually attended? *(This is the question that started all of this. It now clearly
   belongs to the charges layer, not the budget.)* Leaning: **RSVP-yes raises the charge**, since
   that's the point at which the pack commits money per head — with a way to void a charge when
   someone genuinely couldn't come.
6. **Adults per scout.** Always exactly one accompanying adult, or a count per family per event?
   One is simpler and matches the storefront rule; a count handles both parents plus siblings.
7. **Scout Account ceiling.** Should the app warn when total tier-waived value gets large relative
   to net fundraising proceeds? No individual balances exist here, so the direct-benefit risk is
   low — but the number is worth seeing.
8. **Categories.** Adopt 510-278's list verbatim, or a shorter pack-specific one?
