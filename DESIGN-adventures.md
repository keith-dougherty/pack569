# An adventure across several den meetings

*Owner ask, 2026-08-02: "when I create den meetings, I want to be able to assign achievement
targets… show that based on attendance they earned their belt loop/badge, or they are 2/3 there
and missing this meeting." Clarified mid-build: "it's no more than one adventure per meeting, but
an adventure can take multiple meetings to complete."*

---

## 1. What was already there, and what was wrong with it

A den meeting already had an `adventure` field and a one-tap **"mark it done for everyone checked
in"**. That is correct for an adventure a den finishes in one evening, and wrong for most of them:
tag Bobcat on the first of three meetings, tap the button, and a scout who then misses the other
two keeps the credit.

Nothing in the app could express *"this is the second of three nights on Bobcat"*, because that
fact does not live on any one meeting.

## 2. The model: a RUN of sessions

No new stored field. The multiplicity is on the other side — many meetings, one adventure.

> Every den meeting naming an adventure is one **session** of it. The sessions sharing a
> (den, adventure) inside one program year are a **run**. A scout's progress is the sessions of
> that run they were checked in at.

```
adventureRuns()        → [{ den, adventure, sessions: [meeting, …] }]   date-ordered
runProgress(run)       → { total, scouts: [{ attended, missed, pending, count, full, status }],
                           onTrack, complete, short }
runForMeeting(m)       → { run, position, of, prog }   this meeting's place in its run
```

Everything is **derived** from the meetings and the attendance book that were already there, so it
stays right when a meeting is added, moved, retagged or deleted. There is no second record to keep
in step.

Three details that are the whole correctness of it:

- **`pending` is not `missed`.** A session in the future that a scout has not attended is *still to
  come*. Counting it as a miss would report every scout as behind the moment a den schedules next
  month's meetings. `missed` requires `ev.date < today`.
- **Scoped to the program year.** A den works the same adventure again next year with a different
  set of children. Counting last year's meetings would report a scout as finished who has never
  been to one.
- **Grouped per den.** Wolf and Bear both working Bobcat is two runs, not one. A den meeting with
  no den set means all dens, matching what the meeting row already displays.

`onTrack` (missed nothing that has happened) and `complete` (attended every session, including the
planned ones) are different questions and both get asked. The mark-off button uses `onTrack`; the
"every session" badge uses `complete`.

## 3. What attendance is — the part that decided the copy

Researched rather than assumed, because it would have been easy to build a tracker that is subtly
wrong about the programme.

Cub Scout advancement is per **requirement**, and *"Do Your Best"* is the standard. From Scouting
America's own advancement training: preparation happens "in den meetings, pack meetings, or other
activities, or in family settings." For Tiger, Wolf and Bear, a requirement completed outside the
den meeting is signed by the parent or adult partner and **then approved by the den leader**; for
Webelos and Arrow of Light the den leader signs.

**So a missed den meeting does not cost a scout the adventure, and this app must never imply that
it does.** What attendance gives is *evidence*:

| | |
|---|---|
| Scouts at every session held | the ones a den leader can sign off without chasing anybody |
| Scouts who missed one | a **make-up-at-home** list, not a lost cause |

Both lists are shown, and the copy says exactly this. A harness test fails if the words
"cannot earn", "forfeit" or "missed out on the adventure" ever appear.

`advMarkDone` remains the only writer. Nothing here marks anything on its own — attendance is
evidence, the den leader is Akela.

## 4. Where it shows

- **Meeting editor** — the adventure box, then `session 2 of 3 · Jul 15 · Jul 22 (this one) ·
  Aug 19`. An undated meeting is told it needs a date before it counts as a session.
- **Below it** — one row per scout: `Ada Kent 3 of 3 recorded` / `Ben Doe 1 of 3 missed Jul 22`,
  the mark-off button, and the make-up sentence.
- **Agenda row** — `Council Fire (2/3)` in the meta line.
- **Agenda detail** (the printable sheet) — `ADVENTURE Council Fire · session 1 of 3` and a
  `PROGRESS` line.
- **Advancement · Adventures in progress** — one card, every run this year, who is behind. The
  grid below it answers "has Ada got Bobcat"; this answers the question that comes first: "will
  the den get through Bobcat, and who is behind".

### The pack meeting

Recognition is immediate at the den meeting and **formal at the next pack meeting**, where the loop
or pin is actually handed over. The calendar knows which meeting that is, so once anything is
recorded the app names it: *"Present the loop or pin at the next pack meeting — Wed, Aug 26."*

## 5. Two bugs fixed on the way through

**"Edit this meeting" appeared to do nothing.** It set the selected day and re-rendered — and the
day's editable card is a screen and a half below the fold on a long calendar page, with scroll
deliberately preserved. It had always worked and had never been visible. Fixed with `ui.scrollToId`,
honoured at the very end of `render()` (so it beats both the scroll restore and the reset) and
cleared immediately so it can never yank a later render.

Note: **not** `behavior: 'smooth'`. That was the first attempt and in this app's own preview engine
it does nothing at all — 2.4 seconds of polling, `scrollY` never left 0, while the plain call moved
1,131px instantly. A jump that sometimes silently fails is the bug being fixed.

**A NUL byte in `index.html`.** The run key was briefly `den + '\x00' + adventure`. It worked
perfectly, and it made `grep` return **nothing at all** — silently, with a non-zero exit — for the
entire 925KB file, so every "no matches for X" became a lie. Second time in this project: the
harness once had a `join('\x00')` with the same effect. The separator is now `' :: '` (a den name
comes from the fixed `DENS` list and cannot contain it), and a harness test now fails on any
control character anywhere in the source.

## 6. Sources

- Cub Scout Advancement: Delivering Adventure (presenter's notes) —
  <https://filestore.scouting.org/filestore/boyscouts/pdf/CubScoutAdvancementDeliveringAdventure_SpeakerNotes.pdf>
  — the three steps (preparation / qualification / recognition), who signs for which rank, and
  where awards are presented
- Den Leader Resources — <https://www.scouting.org/programs/cub-scouts/leader-resources/den-meeting-resources/>
- Den leader planning (a pack's own working guide) — <https://pack680.org/?page_id=484> — dens
  plan **two meetings a month**, "some adventures are planned over multiple meetings"

Den Leader Guides give four monthly den meeting outlines built around an adventure, so **two to
four den meetings per adventure** is the normal shape — which is exactly what the run model is for.

## 7. What deliberately does not happen

- **Nothing is marked automatically.** Attendance never writes advancement.
- **One adventure per meeting** (owner ruling). The field stays a single string.
- **No parent visibility.** Not asked for, and a per-scout progress board is a different privacy
  question from a campout page — the parent view publishes no advancement today and still doesn't.
- **No requirement-level tracking.** This app is an at-a-glance tracker; the official record is
  Scoutbook Plus, which the Advancement card already says.
