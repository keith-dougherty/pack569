# Design — separating the plan, the money, and the calendar

**Status:** Written 2026-07-26. **Phases 0, 1, 2, 2b and 3a are built** (2026-07-26) — the
ledger, bank reconciliation, `actual = Σ ledger`, the calendar split out into `state.events[]`,
attendance as a head count, and per-head pricing with `fundedBy`/`paidDirectTo`. Phase 3b
(charges and family accounts) and Phase 4 remain proposal.
**Problem:** budgeting and spending are the same record, so neither can be done properly.

> **Naming note.** `state.ledger` is the transaction register described in §3.3. The word
> "ledger" used to mean *the saved pack document* throughout `index.html` (`subscribeLedger`,
> "the shared ledger"); that usage was renamed to **"the pack record"** / `subscribeDoc` when
> Phase 0 landed, so the word now means one thing. The localStorage key
> `pack-popcorn-ledger-v1` keeps its old name — it addresses data already in every leader's
> browser and must never change.

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

#### Attendance is a head count, not a tick

A scout does not arrive alone, and does not arrive with a predictable number of people. Both
parents often come; siblings usually do. So attendance per family is a small count, not a boolean:

```js
state.attendance[eventId][scoutId] = { scout: 0|1, adults: 0..n, siblings: 0..n }
```

Today's meeting attendance (`{ scoutId: true }`) migrates to `{ scout: 1, adults: 0, siblings: 0 }`
and keeps working unchanged — for a den meeting, heads other than the scout cost nothing and the
extra fields simply stay zero.

This one record does three jobs: who was there (program), how many heads to cost (budget), and
what to charge which family (accounts).

### 3.2 Budget line — `state.budget.lines[]`

The plan. Mirrors 510-278, with one addition this pack needs: a pack event is priced **per head**,
and the heads are not all the same kind or price.

```js
{ id, category,                  // 'registration'|'charter'|'advancement'|'recognition'
                                 // |'events'|'activities'|'camp'|'materials'|'training'
                                 // |'uniforms'|'reserve'|'other'|'income'
  name,
  basis: 'per-head'|'flat',
  scoutRateCents,                // per scout
  adultRateCents,                // per adult
  siblingRateCents,              // per sibling — often a child rate, sometimes 0
  flatCents,                     // used when basis === 'flat'
  eventId,                       // optional link to an Event
  fundedBy: 'pack'|'families',   // whose money it is in the end
  paidDirectTo }                 // '' = money flows through the pack
                                 // a name = families pay THEM directly, e.g. 'Council'
```

#### Two questions, two fields

The old `familyPays` boolean could not express a council camp at all. The obvious fix — a third
value, `'council'` — reads backwards: it sounds like the council is *paying for* the camp, when in
fact the council is the one *being paid*. That was a symptom, not a wording problem. **One field
was being asked two independent questions**, which is the same mistake this whole document is
about:

1. **Whose money is it, in the end?** → `fundedBy`
2. **Does it pass through the pack's bank account?** → `paidDirectTo`

Separated, both read correctly and three real arrangements fall out:

```
fundedBy: 'pack'         paidDirectTo: ''
    vendor  ←──────────  PACK
    One ledger entry, OUT. Nobody is billed.
    This is what fundraising exists to cover.

fundedBy: 'families'     paidDirectTo: ''
    vendor  ←──────────  PACK  ←────────  families
    Ledger OUT to the vendor, then ledger IN per family.
    The pack fronts the money and is made whole. Net cost ≈ 0,
    except what it waives or forgives.

fundedBy: 'families'     paidDirectTo: 'Council'
    Council  ←─────────────────────────  families
    NO ledger entries. The pack is not in this transaction at all.
```

| | Pack fronts it? | Families billed by us? | Touches our balance? | Example |
|---|---|---|---|---|
| pack | yes | no | yes — an expense | charter fee, awards, program materials |
| families, through us | yes | yes | yes — out, then back in | Blue & Gold, campout, dues |
| families, direct | **no** | **no** | **no** | day camp, resident camp |

The useful reading: **`fundedBy: 'pack'` is what popcorn has to cover.** Anything `families` is
theirs either way — `paidDirectTo` only says whether we are the ones handling it.

**`paidDirectTo` holds a name, not a flag**, which makes it both clearer and more general. Council
camps are the common case, but so are uniforms: 510-278 budgets *"every Cub Scout in full
uniform"*, and most packs have families buy those from the Scout Shop themselves. Same
arrangement, different payee, no new concept:

```
Cub day camp      fundedBy: families   paidDirectTo: 'Council'
Full uniforms     fundedBy: families   paidDirectTo: 'Scout Shop'
```

These lines exist so the committee can see the true cost of a year to a family, and so the event
still appears on the calendar — but that money is never the pack's and must never move the pack's
balance. Today's model cannot say this, so those costs either sit in the budget and overstate what
the pack spends, or get dropped and understate what Scouting costs a family.

`fundedBy: 'pack'` with a `paidDirectTo` is meaningless — if the pack is paying, it goes through
the pack's account — and the UI should not offer the combination.

#### Planning assumes; reality is entered afterwards

Parents are not going to RSVP in this app, at least not yet. So the plan cannot wait on them, and
**the planning head count is an assumption, stated openly**:

```js
plannedHeads = { scouts: activeScouts, adults: activeScouts × adultsPerScout, siblings: 0 }
                                                              // adultsPerScout defaults to 1
planned      = scoutRate × scouts + adultRate × adults + siblingRate × siblings
```

One adult per scout, no siblings, is the honest default for budgeting — it is the minimum the pack
will be on the hook for. `adultsPerScout` is editable per line for the events where two parents
always come. Nothing about this pretends to know who is coming; it is a planning figure.

**After the event, the Treasurer enters what actually happened** — the attendance head counts and
the real amount spent (as a ledger entry). From that point the line reports:

| | Source |
|---|---|
| **Planned** | roster assumption × rates — frozen, the number the committee agreed |
| **Expected heads** | the same assumption |
| **Actual heads** | entered attendance |
| **Actual cost** | Σ ledger entries on the line — what was really paid |
| **Charged** | rates × actual heads, per family, scout share waived where a tier applies |

Which is exactly the case that started this: *estimate $40 × 10 scouts, actual $42, but only six
turned up.* Planned stays $400 because that is what was budgeted; actual is whatever the ledger
says was paid; charges are raised against six families, not ten. Three different numbers, three
different records, none of them fighting.

**Planned never moves on its own** — that is the point of a plan. `actualCents` is *gone*; actual
is derived from the ledger.

### 3.3 Ledger entry — `state.ledger[]` *(new)*

What actually moved. This is the record that makes the app reconcilable.

```js
{ id, date, description,
  amountCents,                   // always positive
  direction: 'in'|'out',
  lineId,                        // which budget line it posts against ('' = uncategorised)
  method: 'check'|'cash'|'card'|'transfer'|'',
  ref,                           // check number / receipt
  scoutId,                       // set when it settles a charge
  source,                        // 'family'|'donation'|'fundraiser'|'commission'|'carryover'|''
  donor }                        // who gave it, when source === 'donation'
```

`source` is what lets income be read correctly. Two $80 entries that both settle Ben's dues are
very different events if one came from Ben's family and the other from the chartered organisation,
and the pack should be able to see and thank the second.

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

A `fundedBy: 'families'` line raises charges **from the recorded attendance head counts** — one per
head, because that is how the cost is actually incurred.

```js
charge = { id, scoutId, lineId, who: 'scout'|'adult'|'sibling',
           amountCents, date,
           waivedBy,                            // reward tier id — earned
           forgiven }                           // { date, by, reason } — granted
```

A family that brought the scout, both parents and a younger sibling gets four charges against that
scout's account: one `scout`, two `adult`, one `sibling`.

#### Four ways a charge is settled, and they are not interchangeable

A charge stops being outstanding four different ways. Collapsing any of them into "paid" or
"written off" would misstate the pack's position:

| Settled by | Money arrives? | Pack out of pocket? | Record |
|---|---|---|---|
| **Family pays** | yes, from the family | no | ledger `in`, `source: 'family'` |
| **Donation covers it** | **yes, from a third party** | **no** | ledger `in`, `source: 'donation'`, `donor` |
| **Waived** — scout reached a tier | no | yes, from fundraising | `charge.waivedBy = tierId` |
| **Forgiven** — committee granted it | no | yes, deliberately | `charge.forgiven = {date, by, reason}` |

The middle two look identical on a family's statement — *"you owe nothing"* — and are completely
different to the pack. **A donation leaves the pack whole; a waiver or forgiveness does not.**

- *Total waived* is what fundraising bought the families. It is the number that keeps the Scout
  Account boundary visible.
- *Total forgiven* is what the pack chose to absorb. A committee should see that deliberately, not
  discover it as a gap at year end.
- *Total donated* is what somebody else paid for, and it is **good news** — it should be visible,
  attributable, and thankable, not buried in the same bucket as a write-off.

**None of them delete the charge.** It was raised, it stands, and it carries a reason. An auditor
can read a marked charge; a missing one tells them nothing.

Forgiveness in particular is the practice the sample financial bylaws assume — the Treasurer is
told to *"sympathetically counsel with a family which may be financially unable to pay fees"* and
that *"no boy should be left out of activities due to inability to pay."* It is expected. It just
has to leave a trace.

Outstanding for a family = `Σ charges where !waivedBy && !forgiven` − `Σ payments (any source)`.

#### Donations — designated and pooled

Two patterns, and the app should handle both:

**Designated** — the chartered org covers Ben's camp fee specifically. One ledger entry does it:

```
IN  $80.00  "St Mark's — camp assistance for Ben"   line: Camp   scoutId: s1
            source: 'donation'   donor: "St Mark's Church"
```

That settles Ben's charge exactly as a family payment would, but is attributable to the donor.

**Pooled** — the chartered org gives $500 toward "whoever needs help". That is income to a
scholarship line, drawn down later per scout. Conveniently, 510-278 already has the line for it:
**Reserve fund (11) — registration scholarships**. Money in when it arrives; each later use is a
payment against a charge, tagged to that line, so the remaining balance is always visible.

> **Two compliance notes worth carrying in the UI, not just here.** Units *"are not permitted to
> solicit contributions for unit programs"* — accepting an offered gift is fine, asking is not.
> And *"gifts to units are almost never tax deductible"*, so the app must never generate anything
> that looks like a deductible-donation receipt. Recording a donor for a thank-you is the right
> amount of ceremony.

**This pack's rule, expressed exactly:**

> Until a scout reaches a fundraising tier, the family covers **the scout and everyone they bring**.
> Once the tier is reached, the family covers **only the people they bring** — the scout's own
> share is paid from fundraising.

So a reward tier waives **`who: 'scout'` charges only**. Adults and siblings always stand — a
scout's fundraising buys the scout's seat, not the family's. In the model that is a one-line rule,
and it is the entire feature:

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
because what the pack spent is whatever the ledger says. And lines with a `paidDirectTo` raise no charges at
all, since that money never passes through the pack.

#### Worked example

Blue & Gold. `scoutRate $15`, `adultRate $15`, `siblingRate $8`. Roster is 10 scouts.

**At planning time** — nobody has RSVP'd and nobody will:

```
plannedHeads  10 scouts + 10 adults (one each, the assumption) + 0 siblings
planned       10 × $15  +  10 × $15                              = $300.00
```

**After the event** — 8 scouts came, 13 adults, 5 siblings. Pack paid the hall $340. Three of the
eight scouts are past the tier.

```
Ledger  OUT   $340.00  Blue & Gold — venue                  → line "Blue & Gold"
Charges       8 scout  @ $15 = $120.00   (3 waived by "Dues covered"  −$45.00)
             13 adult  @ $15 = $195.00
              5 sibling @ $8 =  $40.00
              families owe                                       $310.00
Ledger  IN    $310.00 as families pay (one entry each, scoutId set)

Line result   planned $300 · actual $340 · charged $355 · waived $45
              recovered $310 · pack absorbed $30
```

The pack absorbed $30, and it is worth seeing where that comes from:

```
overspend against plan   $340 − $300  =  +$40
tier waivers                              +$45
extra heads paying           $355 − $300  =  −$55   (26 heads came; 20 were budgeted)
                                          ───────
pack absorbed                              $30
```

Two scouts stayed home but three extra adults and five siblings came, so charging followed 26
heads rather than the 20 assumed and brought in $55 more than the plan — which covered the
overspend and most of the waivers. **None of that is expressible today**, where planned and actual
are the same field multiplied by the roster.

Every number above is a stored record, not a derivation. That is what makes it a book.

### 3.5 Who enters what, and where

The event is where the two halves meet, and they are entered by different people in different
workspaces — which is exactly the split the jobs model already encodes.

| After an event | Who | Where | Record written |
|---|---|---|---|
| Head counts — scouts, adults, siblings | Cubmaster / Activities chair / Den leader | **Program · Calendar**, on the event | `attendance[eventId][scoutId]` |
| …or the same head counts | Treasurer, if nobody else did | **Money · Ledger**, while posting the spend | *the same record* |
| What it actually cost | Treasurer | **Money · Ledger**, posted to the line | ledger entry `out` |
| Charges raised | *automatic* | from head counts × rates | `charges[]` |
| Waiving a scout's share | *automatic* | from the reward tier | `charge.waivedBy` |
| Forgiving a charge | Treasurer / Committee Chair | **Money · Dues & fees** | `charge.forgiven` |
| Recording a family payment | Treasurer | **Money · Ledger** | ledger `in`, `source: 'family'` |
| Recording a donation that covers a scout | Treasurer | **Money · Ledger** | ledger `in`, `source: 'donation'`, `donor` |

Nobody has to be in two places. The person who ran the event says who came; the person with the
chequebook says what it cost. The charges fall out of the two meeting.

That also means **an event is not "closed" until both halves are in**, which is a genuinely useful
thing for Home to nag about — a past event with attendance but no spend, or spend but no
attendance, is an incomplete book and exactly the sort of item the Treasurer's queue should carry.

#### The Treasurer must never be blocked waiting on someone else

The division above is who *should* enter what, not a gate. In a small pack the Cubmaster may
simply not get to it, and the books cannot wait. So **the head count is editable from the ledger
side too**: posting the spend for an event shows its attendance inline, and lets the Treasurer
enter or correct it in the same motion.

If attendance is already recorded, it is shown as recorded — a summary with the counts, not an
empty form — so the Treasurer can see it is done and move on, or correct an obvious error
deliberately rather than silently overwriting somebody's work. **One record, two doors.**

There is one honest limitation to surface rather than hide:

| What is entered | Enough to… | Not enough to… |
|---|---|---|
| **Totals** — "8 scouts, 13 adults, 5 siblings came" | cost the line, compare to plan, close the books | raise family charges |
| **Per family** — the grid | all of the above, **plus** charge each family correctly | — |

For a `fundedBy: 'pack'` line, totals are the whole job and the grid is pointless. For a
`fundedBy: 'families'` line, totals get the accounting right but the app cannot know *whose* $40
it is. It should say exactly that — *"26 heads recorded. Add who came to raise family charges."* —
rather than quietly billing nobody, or worse, guessing.

That is also the graceful degradation path if the Cubmaster never adopts the head-count screen:
the Treasurer alone can keep a completely correct set of books, and only per-family billing needs
the extra detail.

---

## 3.6 A year in the life

How it actually works once built, in order, with the records each step writes.

### July — the committee plans the year

**Cubmaster and Activities chair** put the calendar together in **Program**. Fourteen events:
den meetings, pack meetings, Fall campout, Blue & Gold, derby, day camp. Each is an **Event** —
date, place, notes. No money anywhere yet.

**Treasurer** opens **Money · Budget** and builds the plan from the 510-278 categories, one line
per thing the pack will pay for. For each line: who pays, and at what rate.

```
Charter fee            flat    $100      fundedBy: pack
Awards & badges        flat    $350      fundedBy: pack
Fall campout           per-head  scout $40 · adult $40 · sibling $20   fundedBy: families  → Event
Blue & Gold            per-head  scout $15 · adult $15 · sibling $8    fundedBy: families  → Event
Cub day camp           per-head  scout $145        fundedBy: families  paidDirectTo: Council  → Event
Pack dues              per-head  scout $80                             fundedBy: families
```

Planned totals use the roster assumption — every active scout, one adult each. Ten scouts:

```
A) Budgeted expenses        $3,150      (paid-direct lines excluded — not the pack's money)
B) Income                     $420      carryover
C) Fundraising need         $2,730   ÷ 32% commission = $8,531 pack popcorn goal
                                                       ÷ 10  =   $853 per scout
```

**That last figure is currently typed in by hand.** After this it is derived from the plan, which
is the entire point of the 510-278 worksheet.

**Popcorn Kernel** sets the reward tiers in **Popcorn · Rewards** — tier 1 at $300 covers Pack
dues; tier 2 at $600 also covers Blue & Gold.

### September — popcorn

Storefronts, shifts, standings, Trail's End imports: **completely unchanged**. The Kernel works
exactly as they do today.

One thing changes at the end. When the council cheque clears, the Treasurer posts **one ledger
entry** rather than the app inferring commission from three subsystems:

```
IN  $2,730.00  "Trail's End commission"  line: Popcorn income  source: 'commission'
```

### October — the Fall campout

Planned at $800 (10 scouts + 10 adults × $40). What actually happens:

**After the event, the Cubmaster** opens the Event in **Program** and enters head counts — the
same screen where attendance is already taken, just with numbers instead of ticks:

```
Ben    scout 1 · adults 2 · siblings 1
Ivy    scout 1 · adults 1 · siblings 0
Mae    scout 0 · adults 0 · siblings 0     (didn't go)
…                                          8 scouts · 13 adults · 5 siblings
```

**The Treasurer** pays the campground and posts it in **Money · Ledger**:

```
OUT $1,020.00  "Fall campout — Camp Rainey"  line: Fall campout  method: check  ref: 1043
```

**Charges raise themselves** from the head counts × the rates. Three scouts are past tier 1, so
their **scout** share is waived — their adults and siblings still pay:

```
8 scout   @ $40 = $320   (3 waived by "Dues covered" −$120)
13 adult  @ $40 = $520
5 sibling @ $20 = $100
families owe                                    $820
```

Over the following weeks: seven families pay (ledger `in`, `source: 'family'`), St Mark's covers
one scout's share (ledger `in`, `source: 'donation'`, `donor: "St Mark's Church"`), and one family
is struggling so the Committee Chair forgives $60 with a reason recorded on the charge.

The line now reads:

```
planned $800 · actual $1,020 · charged $940 · waived $120 · forgiven $60 · donated $40
recovered $760 · pack absorbed $260
```

Every one of those is a stored record. **Today none of it exists** — the line would say
`actual $102 × 10 scouts = $1,020` and stop.

### Any month — the Treasurer's routine

Home shows the Treasurer's queue, and it now knows about incomplete books:

- *Fall campout has attendance but no spend recorded* — half a book
- *Blue & Gold has spend but nobody entered who came* — the other half
- *4 families owe $310*
- *12 ledger entries not yet reconciled*

**Reconciling** is a real thing now: open **Money · Ledger · Reconcile**, tick entries against the
bank statement, type the statement's closing balance. The difference should be zero. If it isn't,
something is missing — which is exactly what a treasurer needs to know and cannot currently find
out from this app at all.

At the committee meeting, budget-vs-actual by category, with variance, straight off the plan.

### March — day camp, which is not the pack's money

Day camp is on the calendar. Families pay the council **directly**, $145 a scout —
`fundedBy: 'families'`, `paidDirectTo: 'Council'`.

- It appears in Program like any other event.
- It appears in the true-cost-to-a-family view: *"this year costs your family about $X."*
- It raises **no charge**, writes **no ledger entry**, and does **not move the pack's balance**.

Today there is no way to say that. Either the fee sits in the budget and overstates what the pack
spends, or it is left out and the pack understates what Scouting costs a family.

Uniforms work the same way — `paidDirectTo: 'Scout Shop'` — so 510-278's *"every Cub Scout in full
uniform"* line can finally be budgeted honestly without pretending the pack buys them.

### June — closing the year

Close-out works as it does now, with better inputs:

- The archive stores **real actuals** from the ledger, not `estimate × roster`.
- Carryover is the **reconciled bank balance**, not a derived figure.
- Next year's estimates seed from what things actually cost, which is what the current rollover
  already tries to do — it just finally has true numbers to do it with.

### What the Treasurer can answer afterwards that they cannot today

| Question | Today | After |
|---|---|---|
| What is our bank balance? | a derived guess | a reconciled figure, ticked against the statement |
| Are we over budget, and where? | one number per line | per line, per category, with variance |
| Who owes what? | a boolean grid | charges and payments, with dates |
| Why has this not been collected? | *unanswerable* | paid · donated · waived · forgiven, with reasons |
| What did fundraising buy the families? | *unanswerable* | total waived |
| What did we give away? | *unanswerable* | total forgiven |
| What did donors cover, and whom do we thank? | *unanswerable* | total donated, by donor |
| What does Scouting cost one of our families? | *unanswerable* | pack charges + council fees |

---

## 4. How today's features map on

| Today | Becomes |
|---|---|
| `budget.activities[]` | one Event + one budget line, linked by `eventId` |
| `budget.expenses[]` | budget lines with no `eventId` |
| `activity.actualCents × roster` | Σ ledger entries on that line |
| `collected[key][scoutId] = true` | a charge + a payment ledger entry |
| reward tier `covers[]` | tier threshold waives `who: 'scout'` charges |
| `familyPays` boolean | `fundedBy: 'pack'\|'families'` + `paidDirectTo` |
| camp fees in the pack budget | `paidDirectTo: 'Council'` — visible, outside the books |
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

**Phase 0 — the ledger, and bank reconciliation. ✅ BUILT.** `state.ledger = []` plus
`state.book`, a Money · Ledger section with entry, filtering and a running balance, and a
**reconcile** view: tick entries against a bank statement, enter its closing balance, see the
difference. `computeBudget` was left alone in this phase, so the app kept functioning while the
Treasurer started keeping the real book alongside it.

*This is the load-bearing phase.* Everything after it is about removing the duplicate,
derived version of numbers the ledger already holds.

As built, three details worth carrying forward:

- **The running balance is computed over the whole ledger in date order**, then looked up per
  row — never over the filtered subset, or filtering to "money out" would show a running total
  that never existed.
- **Until an opening figure is set, the headline stat reads "Net movement", not "Bank
  balance".** A freshly migrated book with expenses and no income would otherwise announce a
  large negative bank balance that is not true.
- **The Budget's own Balance is labelled as a projection** wherever a ledger exists, with the
  real cash position shown next to it. The gap between them is information, not an error.

**Phase 1 — derive actual from the ledger. ✅ BUILT.** Every budget line with
`actualCents > 0` was migrated to one ledger entry (date = event date, else today clamped into
the program year; description = line name), and `actualCents` was deleted — its *absence* is
the marker that migration has run, so re-loading never migrates twice. `actual = Σ ledger`.

The migrated amount is the line's **total, not its rate**: `actualCents` on a per-scout line
was multiplied by the roster on every read, so the entry records rate × roster-as-it-stood.
Totals are identical before and after, asserted in `test/harness.mjs`
(*"Phase 1 migration: actual totals are identical before and after"*). From there the figure is
frozen — a transaction does not change when a scout joins the pack.

Two consequences that had to be handled at the same time: the **year rollover** now clears the
ledger, opens the new year's book at the closing bank balance, and divides a per-scout line's
real spend back down by the roster before seeding next year's estimate; and the **append-only
divergence merge** unions `state.ledger`, so two leaders posting receipts from two devices
cannot lose each other's transactions.

**Phase 2 — split events out. ✅ BUILT.** `state.events[]` now holds every meeting and the
calendar half of every activity; `meetings[]` is emptied (not deleted — an older build reading the
record finds an empty calendar rather than a missing key). Budget lines keep their own id, because
the ledger's `lineId` points at it, and gain an `eventId`. The calendar fields are gone from the
budget line entirely.

**The first symptom in §1 is fixed:** importing a BAND calendar creates *events only*. No budget
rows, no money, no per-scout flags. Budgeting an imported event is a deliberate act — a
"+ Budget this" button on the day detail — and an unbudgeted event reads "not budgeted" rather than
silently implying a cost.

Decisions made while building it:

- **Event ids are fresh, and the migration repoints attendance and RSVPs onto them.** Reusing the
  meeting's id would have kept `attendance[meetingId]` working untouched, but left
  `event.id === budgetLine.id` for every migrated activity — two record types aliased in one
  namespace for the life of the app. The repointing is ten lines and is tested directly.
- **RSVP and attendance now key off one id.** `rsvps['mtg:'+id]` and `rsvps['act:'+id]` collapse to
  the bare `event.id`, which is the single mechanism §3.1 asks for. Storefronts are not events, so
  `'sf:'` keys stay prefixed.
- **A budget line's month comes from its event.** `slot` lives on the event, so the Budget's
  month grouping is derived rather than stored twice. Lines whose event was deleted group under
  **"Not on the calendar"** — a state that could not exist before the split, because the date and
  the money were the same row.
- **Deleting a calendar event never deletes the budget line under it.** The ledger posts against
  that line; removing it to service a calendar edit would orphan real transactions. The event goes,
  the money stands, and the Budget says where it went.
- **`meetings[]` is emptied rather than deleted**, and a budget line pointing at a vanished event is
  unlinked rather than left dangling.

**Phase 2b — attendance head counts. ✅ BUILT.** `attendance[eventId][scoutId]` is now
`{ scout, adults, siblings }`; every existing tick migrated to `{ scout: 1, adults: 0, siblings: 0 }`
and keeps working unchanged. Phase 2 had already done the hard half — attendance was keyed on
`event.id` — so this was a value-shape change on a key that no longer had to move.

- **The grid is only asked for where heads cost something.** An activity gets the full
  scout/adults/siblings entry; a den meeting keeps the plain roll-call it has always had, because
  heads other than the scout cost nothing there and a weekly register should stay one tap per scout.
- **A family of zeros is pruned, not stored.** "Absent from the map" has to keep meaning "did not
  come", exactly as the boolean did — otherwise every scout ever unticked would read as a family
  that turned up with nobody in it.
- **A parent who came without their scout is recordable** (`scout: 0, adults: 2`). It happens, and
  from Phase 3 it is chargeable.
- **Roster percentages count scouts, never heads.** The close-out average would otherwise sail past
  100% as soon as the parents were counted.

Still deferred to Phase 3, because it needs `fundedBy` to know which lines care: the Home nag for
*"a past event with attendance but no spend, or spend but no attendance"* (§3.5). Firing it on
every pack-funded line would be noise.

**Phase 3a — pricing, `fundedBy` and `paidDirectTo`. ✅ BUILT.** The `perScout`/`familyPays`
booleans are gone. A line now carries `basis: 'flat'|'per-head'`, the three rates,
`adultsPerScout`, `fundedBy: 'pack'|'families'` and `paidDirectTo`. Migration is total-preserving
— a per-scout line's estimate becomes its SCOUT rate with the adult and sibling rates at zero, so
`adultsPerScout: 1` multiplies a rate of zero and nothing moves. Asserted in `test/harness.mjs`.

- **Paid-direct money is out of the books entirely** — excluded from planned, actual, the balance
  and the collect grid — and reported separately as *what the year costs a family*. Before this it
  either sat in the budget and overstated what the pack spends, or was left out and understated
  what Scouting costs a family. `fundedBy: 'pack'` with a payee is not expressible.
- **The paid-direct question is asked once, per pack**, on a dismissible card. Migration never
  guesses it: whether families pay the pack or pay the council is a judgement call per line.
- **Switching basis carries the money across** rather than zeroing it.
- **The rollover carries the pricing shape and rebuilds the calendar.** Phase 2 had left a bug
  here — the re-seeded activity lines had no `eventId`, so the whole plan would have come back
  under "Not on the calendar" with its months lost. Flat lines seed next year from the ledger;
  per-head lines keep their rates, because those are per-person prices and back-deriving them from
  a total that depended on who turned up would be worse than leaving them alone.

*Interim, closed by 3b:* expected family income still counts only the **scout** share of a
per-head line, because `state.collected` can record just one tick per scout. The adult and sibling
shares are real money families owe (the pack fronts it and is made whole) and start counting when
charges replace the collect grid. Until then the figure understates family income, so the popcorn
goal comes out slightly high rather than slightly short.

**Phase 3b — charges and family accounts.** *(Next.)* Generate charges from recorded attendance
× rates, waiving `who: 'scout'` where a tier applies. Add the four settlement paths — paid,
donated, waived, forgiven. Backfill history from `collected[]`. Rework Dues & fees onto charges.
Also picks up the Home nag deferred from 2b: a past event with attendance but no spend, or spend
but no attendance, is an incomplete book — now expressible, because `fundedBy` says which lines
care.

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
   `fundedBy: 'families'` with `paidDirectTo: 'Council'`. On the calendar, counted in what the
   year costs a family, invisible to the pack's balance.

5. **Plan from an assumption; charge from recorded attendance.** Parents will not be RSVPing here,
   so the plan assumes every active scout plus one adult. After the event the Treasurer enters the
   real head counts and the real spend, and charges are raised from those. *(This was the question
   that started all of this — RSVP is not the answer, because RSVP will not exist.)*
6. **Attendance is an open head count.** A scout may bring two parents and siblings, so attendance
   is `{ scout, adults, siblings }` per family per event, not a tick. Siblings get their own rate.

7. **Attendance is entered on the event, after the fact** — by whoever ran it, in Program. The
   Treasurer separately posts what it cost, in Money. Charges fall out of the two meeting, so an
   event with only one half entered is an incomplete book and should be visible as such.
8. **A charge stands even if the family did not attend, and can be settled four ways** — paid by
   the family, covered by a donation, waived by a reward tier, or forgiven by the committee. All
   four are recorded on the charge or in the ledger, never deleted, and reported separately:
   a donation leaves the pack whole, a waiver or forgiveness does not.

**Settled (owner, 2026-07-26, during the Phase 0/1 build):**

12. **Opening balance and history — both, through one mechanism.** `state.book` holds an
    opening figure and the date it was true. An entry dated **on or after** that date moves the
    bank balance; an entry dated **before** it does not, because the opening figure already
    embodies it. That one rule gives both ways of starting:
    *opening balance* — type today's real bank balance and record forward, and the first
    reconciliation is meaningful immediately; *backfill* — set the date to the start of the
    program year with the balance you had then and enter the season.
    They also mix: a pack can start from today and later backfill September's receipts, which
    will count toward those lines' actual cost **without** double-counting the cash. A
    pre-opening entry is reported on screen rather than hidden, so nobody has to guess why it
    isn't in the balance.

**Still open:**

9. **Scout Account ceiling.** Should the app warn when total tier-waived value gets large relative
   to net fundraising proceeds? No individual balances exist here, so the direct-benefit risk is
   low — but the number is worth seeing.
10. **Categories.** Adopt 510-278's list verbatim, or a shorter pack-specific one?
11. **Who may forgive?** Treasurer alone, or Committee Chair too? The app has jobs now, so this
    can be a real distinction rather than "any editor".
