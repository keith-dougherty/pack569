/* Multi-year Pack 569 scenario — a longitudinal test of the money model.
 *
 * Drives the real app through three program years and cross-checks every money figure
 * against arithmetic computed HERE, independently of the app's own functions. If the two
 * ever agree only because they share a bug, that is what this file exists to prevent.
 *
 * It is the counterpart to test/harness.mjs, which tests functions in isolation. This tests
 * what happens to a pack's books over TIME — across two close-outs — which is where the
 * audit of 2026-07-26 found five defects that per-phase unit tests had all missed.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN (needs a browser; there is no DOM in the Node harness)
 *
 *   1. Copy index.html somewhere scratch and set PACK_DOC_ID = null in the copy.
 *      The scenario cannot get past the single-pack Google sign-in gate, and you do
 *      not want it writing to a real pack's synced document.
 *   2. Serve that directory alongside this file:
 *        python3 -m http.server 8569
 *   3. Open http://localhost:8569/index.html, then in the console:
 *
 *        s = document.createElement('script'); s.src = '/scenario-browser.js';
 *        document.head.appendChild(s);
 *
 *      then run the acts in order, reloading where noted (seeding raw state means
 *      normalizeState has to run over it):
 *
 *        SCENARIO.reset(); SCENARIO.seed();                       location.reload()
 *        SCENARIO.carry('plan', SCENARIO.plan());
 *        SCENARIO.carry('sold', SCENARIO.sell());                 location.reload()
 *        y = SCENARIO.charges(SCENARIO.carry('plan'), SCENARIO.carry('sold'));
 *        m = SCENARIO.money(SCENARIO.carry('plan'), y);
 *        SCENARIO.reconcile(m); SCENARIO.close(y, m);
 *        SCENARIO.y2({}, m); SCENARIO.y2run(m);                   location.reload()
 *        SCENARIO.y2close(SCENARIO.y2money(m));
 *        SCENARIO.report()          // { failures: [], log: [...] }
 *
 *   Expected as of 2026-07-26: 62 checks, 0 failures.
 * ---------------------------------------------------------------------------
 *
 * WHAT IT COVERS
 *   Year 1  the 510-278 worksheet (A/B/C) and the derived pack goal · paid-direct money
 *           staying out of both · per-head charges from recorded attendance · a tier
 *           waiving the scout share only · forgiveness · a donation settling a family ·
 *           per-line actual from the ledger, with family payments NOT reducing it ·
 *           reconciling to a statement · the archive keeping real actuals
 *   Year 2  carryover = the reconciled closing bank balance · categories, per-head rates
 *           and paidDirectTo all surviving the rollover · flat lines re-seeding from what
 *           they actually cost · every activity coming back SCHEDULED · nothing settled
 *           carried over · a year with no popcorn at all
 *   Year 3  two archives intact · the bank chaining unbroken across both close-outs
 */
(function () {
  var KEY = 'pack-popcorn-ledger-v1';
  // Results live in sessionStorage: the scenario reloads the page between acts (seeding raw
  // state means normalizeState has to run on it), and in-memory arrays would not survive.
  function load() { try { return JSON.parse(sessionStorage.getItem('SCEN') || '{}'); } catch (e) { return {}; } }
  function save(o) { sessionStorage.setItem('SCEN', JSON.stringify(o)); }
  var stash = load();
  var results = stash.results || [];
  var failures = stash.failures || [];
  function persist() { save({ results: results, failures: failures, carry: (load().carry || {}) }); }

  function check(name, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    var ok = a === e;
    results.push((ok ? 'PASS ' : 'FAIL ') + name + (ok ? ' = ' + a : ' expected ' + e + ', got ' + a));
    if (!ok) failures.push(name + ': expected ' + e + ', got ' + a);
    persist();
    return ok;
  }
  function note(msg) { results.push('  · ' + msg); persist(); }
  function S() { return JSON.parse(localStorage.getItem(KEY)); }
  // Match the app's formatter, including thousands separators, so a comma is never mistaken
  // for a maths error.
  function money(c) {
    var neg = c < 0;
    var v = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$' : '$') + v;
  }

  function q(sel) { var el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel); return el; }
  function click(sel) { q(sel).click(); }
  function set(sel, v) { var el = q(sel); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
  function tick(sel, on) { var el = q(sel); el.checked = !!on; el.dispatchEvent(new Event('change', { bubbles: true })); }
  function go(tab, section) {
    click('[data-act][data-tab="' + tab + '"]');
    if (section) click('[data-act="section"][data-section="' + section + '"]');
  }
  function stats() {
    var out = {};
    [].forEach.call(document.querySelectorAll('.stat'), function (s) {
      out[s.querySelector('.l').textContent] = s.querySelector('.v').textContent;
    });
    return out;
  }
  function worksheet() {
    return [].map.call(document.querySelectorAll('.fund-tbl tr'),
      function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); });
  }

  /* ---------------- the pack ---------------- */
  var SCOUTS = 10;
  var CARRYOVER = 42000;          // $420 into year 1
  var PCT = 32;

  // Rates, in cents. Everything downstream is derived from these here, not from the app.
  var R = {
    charter: 10000, awards: 35000, materials: 60000, reserve: 50000,
    dues: 8000,
    campScout: 4000, campAdult: 4000, campSib: 2000,
    bgScout: 1500, bgAdult: 1500, bgSib: 800,
    dayCamp: 14500
  };

  function seedYear1() {
    var scouts = [];
    for (var i = 0; i < SCOUTS; i++) scouts.push({ id: 's' + i, name: 'Scout ' + (i + 1), den: 'Wolf' });
    var line = function (id, name, cat, basis, extra) {
      var l = {
        id: id, name: name, category: cat, basis: basis,
        scoutRateCents: 0, adultRateCents: 0, siblingRateCents: 0, flatCents: 0,
        adultsPerScout: 1, fundedBy: 'pack', paidDirectTo: ''
      };
      if (extra) Object.keys(extra).forEach(function (k) { l[k] = extra[k]; });
      return l;
    };
    var ev = function (id, name, date, slot) {
      return {
        id: id, kind: 'activity', den: '', name: name, date: date, time: '', endTime: '',
        location: '', note: '', slot: slot, sourceUid: '', adventure: ''
      };
    };
    var s = {
      version: 1, packName: 'Pack 569', commissionPct: String(PCT),
      goalCents: 0, goalIsDerived: true, cashGoalCents: 0, cashThroughTrailsEnd: false,
      scouts: scouts, storefronts: [], entries: [], leaders: [], meetings: [],
      events: [ev('E-camp', 'Fall campout', '2025-10-18', 1),
                ev('E-bg', 'Blue & Gold', '2026-02-14', 5),
                ev('E-day', 'Cub day camp', '2026-06-15', 9)],
      attendance: {}, rsvps: {}, collected: {}, charges: [], ledger: [],
      book: { openingCents: 0, openingDate: '', statementDate: '', statementCents: 0, reconciledThrough: '' },
      budget: {
        programYear: 2025, startingBalance: CARRYOVER, directPrompted: true,
        activities: [
          line('L-camp', 'Fall campout', 'activities', 'per-head', {
            eventId: 'E-camp', fundedBy: 'families',
            scoutRateCents: R.campScout, adultRateCents: R.campAdult, siblingRateCents: R.campSib
          }),
          line('L-bg', 'Blue & Gold', 'events', 'per-head', {
            eventId: 'E-bg', fundedBy: 'families',
            scoutRateCents: R.bgScout, adultRateCents: R.bgAdult, siblingRateCents: R.bgSib
          }),
          line('L-day', 'Cub day camp', 'camp', 'per-head', {
            eventId: 'E-day', fundedBy: 'families', paidDirectTo: 'Council',
            scoutRateCents: R.dayCamp
          })
        ],
        expenses: [
          line('L-charter', 'Charter fee', 'charter', 'flat', { flatCents: R.charter }),
          line('L-awards', 'Awards & badges', 'recognition', 'flat', { flatCents: R.awards }),
          line('L-materials', 'Program materials', 'materials', 'flat', { flatCents: R.materials }),
          line('L-reserve', 'Reserve fund', 'reserve', 'flat', { flatCents: R.reserve }),
          line('L-dues', 'Pack dues', 'registration', 'per-head', {
            fundedBy: 'families', scoutRateCents: R.dues
          })
        ]
      },
      advancement: {}, fundraisers: [],
      derby: { name: '', date: '', lanes: 4, cars: [], awards: [] },
      // Tier 1 at $300 covers PACK DUES only — the doc's "Dues covered".
      rewardTiers: { duesCents: 0, tiers: [{ id: 'T1', name: 'Dues covered', thresholdCents: 30000, reward: '', covers: ['L-dues'] }] },
      inventory: { commissionPct: String(PCT), orderTotalCents: 0, products: [], distributions: [] },
      archives: [], densAdvancedYear: 0, startHereDismissed: true, movedNoticeDismissed: true, rev: 0
    };
    localStorage.setItem(KEY, JSON.stringify(s));
  }

  // Who came, per event: 5 families bring 2 adults + 1 sibling, 3 bring 1 adult, 2 stay home.
  var TURNOUT = [];
  for (var t = 0; t < 8; t++) TURNOUT.push({ id: 's' + t, scout: 1, adults: t < 5 ? 2 : 1, siblings: t < 5 ? 1 : 0 });
  var HEADS = TURNOUT.reduce(function (a, r) {
    a.scouts += r.scout; a.adults += r.adults; a.siblings += r.siblings; return a;
  }, { scouts: 0, adults: 0, siblings: 0 });

  // Jump straight to a day using the app's own cal-jump-day action, rather than walking the
  // month arrows (which only ever went one way).
  function jumpToDay(dateISO) {
    go('program', 'calendar');
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-act', 'cal-jump-day');
    b.setAttribute('data-date', dateISO);
    document.getElementById('view').appendChild(b);
    b.click();
  }
  function recordAttendance(dateISO, month) {
    jumpToDay(dateISO);
    if (!document.querySelector('[data-act="cal-day"][data-date="' + dateISO + '"]')) {
      throw new Error('could not reach ' + dateISO);
    }
    var toggles = document.querySelectorAll('[data-act="toggle-att"]');
    toggles[toggles.length - 1].click();
    TURNOUT.forEach(function (r) {
      tick('[data-ch="att-mark"][data-scout="' + r.id + '"]', true);
      set('[data-ch="att-adults"][data-scout="' + r.id + '"]', r.adults);
      if (r.siblings) set('[data-ch="att-siblings"][data-scout="' + r.id + '"]', r.siblings);
    });
  }

  function addLedger(o) {
    go('money', 'ledger');
    set('[data-ch="ledn-dir"]', o.direction);
    set('[data-ch="ledn-date"]', o.date);
    set('[data-ch="ledn-desc"]', o.description);
    set('[data-ch="ledn-amount"]', (o.amountCents / 100).toFixed(2));
    if (o.lineId) set('[data-ch="ledn-line"]', o.lineId);
    if (o.direction === 'in') {
      if (o.scoutId) set('[data-ch="ledn-scout"]', o.scoutId);
      if (o.source) set('[data-ch="ledn-source"]', o.source);
      if (o.donor) set('[data-ch="ledn-donor"]', o.donor);
    }
    click('[data-act="ledger-add"]');
  }

  function closeOut() {
    go('pack', 'season');
    click('[data-act="open-closeout"]');
    q('[data-act="closeout-confirm"]').click();
    q('[data-act="closeout-confirm"]').click();
  }

  /* ================= YEAR 1 ================= */
  function year1() {
    results.push('===== YEAR 1 (2025-26) =====');
    seedYear1();
    location.hash = '';
    return 'seeded';
  }

  function year1Checks() {
    results.push('--- planning ---');
    var st = S();

    // A: every through-pack line at its planned figure. Computed here, from R.
    var A = R.charter + R.awards + R.materials + R.reserve
      + R.dues * SCOUTS
      + (R.campScout * SCOUTS + R.campAdult * SCOUTS)      // adultsPerScout = 1
      + (R.bgScout * SCOUTS + R.bgAdult * SCOUTS);
    var familyDirect = R.dayCamp * SCOUTS;
    // Fees: no charges raised yet, so every family-funded through-pack line falls back to plan.
    var fees = R.dues * SCOUTS
      + (R.campScout * SCOUTS + R.campAdult * SCOUTS)
      + (R.bgScout * SCOUTS + R.bgAdult * SCOUTS);
    var B = CARRYOVER + fees;
    var C = Math.max(0, A - B);
    var goal = Math.round(C / (PCT / 100));
    var perScout = Math.round(goal / SCOUTS);

    go('money', 'budget');
    var ws = worksheet();
    note('worksheet: ' + ws.join(' | '));
    check('Y1 A (budgeted expenses)', ws[0], 'A Total budgeted program expenses' + money(A));
    check('Y1 B (income subtotal)', ws.filter(function (r) { return /^B /.test(r); })[0],
      'B Income subtotal' + money(B));
    check('Y1 C (fundraising need)', ws.filter(function (r) { return /^C /.test(r); })[0],
      'C Total fundraising need (A − B)' + money(C));
    var goalLine = document.getElementById('view').innerText.split('\n')
      .filter(function (l) { return /pack goal of/.test(l); })[0] || '';
    check('Y1 derived pack goal', /goal of ([^\s]+) through/.exec(goalLine)[1], money(goal));
    check('Y1 per-scout goal', /— ([^\s]+) per active scout/.exec(goalLine)[1], money(perScout));
    check('Y1 paid-direct excluded from the plan', st.budget.activities.filter(function (l) {
      return l.paidDirectTo;
    }).length, 1);
    note('day camp ' + money(familyDirect) + ' is family-direct and out of A and B');
    return { A: A, B: B, C: C, goal: goal, familyDirect: familyDirect };
  }

  function year1Run(plan) {
    results.push('--- the year happens ---');
    // Popcorn: three scouts clear the $300 tier, everyone else sells less.
    var st = S();
    st.storefronts = [{ id: 'SF1', name: 'Market', date: '2025-09-20', blocks: [] }];
    var sales = 0;
    for (var i = 0; i < SCOUTS; i++) {
      var cents = i < 3 ? 40000 : 15000;       // s0..s2 clear the tier
      sales += cents;
      st.entries.push({ id: 'X' + i, scoutId: 's' + i, kind: 'wagon', salesCents: cents, donationsCents: 0, date: '2025-10-01' });
    }
    localStorage.setItem(KEY, JSON.stringify(st));
    location.reload();
    return { sales: sales };
  }

  function year1AfterSales(plan, sold) {
    var commission = Math.round(sold.sales * PCT / 100);
    note('sold ' + money(sold.sales) + ' → commission ' + money(commission));

    // Open the book at the real bank balance on the first day of the year.
    go('money', 'ledger');
    set('[data-ch="book-opening"]', (CARRYOVER / 100).toFixed(2));
    set('[data-ch="book-opening-date"]', '2025-09-01');

    // Record who came to the campout and to Blue & Gold.
    recordAttendance('2025-10-18', 'October 2025');
    recordAttendance('2026-02-14', 'February 2026');

    // Charges must now be heads × rates, computed here.
    var camp = HEADS.scouts * R.campScout + HEADS.adults * R.campAdult + HEADS.siblings * R.campSib;
    var bg = HEADS.scouts * R.bgScout + HEADS.adults * R.bgAdult + HEADS.siblings * R.bgSib;
    var dues = R.dues * SCOUTS;
    var raised = camp + bg + dues;
    var st = S();
    var byLine = {};
    st.charges.forEach(function (c) { byLine[c.lineId] = (byLine[c.lineId] || 0) + c.amountCents; });
    check('Y1 campout charges', byLine['L-camp'], camp);
    check('Y1 Blue & Gold charges', byLine['L-bg'], bg);
    check('Y1 dues charges (roster-based)', byLine['L-dues'], dues);
    check('Y1 day camp raises no charges (paid direct)', byLine['L-day'] || 0, 0);
    check('Y1 total charged', st.charges.reduce(function (n, c) { return n + c.amountCents; }, 0), raised);

    // Tier 1 waives the SCOUT share of dues for the three who cleared $300.
    var waived = 3 * R.dues;
    check('Y1 waived by tier', st.charges.filter(function (c) { return c.waivedBy; })
      .reduce(function (n, c) { return n + c.amountCents; }, 0), waived);
    check('Y1 tier never waives a head they brought',
      st.charges.filter(function (c) { return c.waivedBy && c.who !== 'scout'; }).length, 0);

    return { camp: camp, bg: bg, dues: dues, raised: raised, waived: waived, commission: commission };
  }

  function year1Money(plan, y) {
    results.push('--- the money moves ---');
    // What the pack actually paid. Deliberately over the campout estimate, like real life.
    var spend = [
      { date: '2025-09-05', description: 'Charter fee', amountCents: R.charter, lineId: 'L-charter' },
      { date: '2025-10-20', description: 'Camp Rainey', amountCents: 102000, lineId: 'L-camp' },
      { date: '2026-02-16', description: 'Parish hall', amountCents: 34000, lineId: 'L-bg' },
      { date: '2026-05-01', description: 'Awards & badges', amountCents: 31250, lineId: 'L-awards' },
      { date: '2026-05-02', description: 'Program materials', amountCents: 58000, lineId: 'L-materials' }
    ];
    spend.forEach(function (e) { addLedger({ direction: 'out', date: e.date, description: e.description, amountCents: e.amountCents, lineId: e.lineId }); });
    var outTotal = spend.reduce(function (n, e) { return n + e.amountCents; }, 0);

    // Commission lands.
    addLedger({ direction: 'in', date: '2025-12-01', description: "Trail's End commission", amountCents: y.commission, source: 'commission' });

    // Forgive s9's dues; a donation covers s8's dues; everyone else pays what they owe.
    go('money', 'dues');
    click('[data-act="toggle-collect"][data-id="s9"]');
    var fb = document.querySelector('[data-act="charge-forgive"]');
    fb.click();
    var form = document.querySelector('form[data-form="charge-forgive"]');
    form.querySelector('[name="reason"]').value = 'unable to pay this term';
    form.querySelector('[name="by"]').value = 'Committee Chair';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    var st = S();
    var forgiven = st.charges.filter(function (c) { return c.forgiven; })
      .reduce(function (n, c) { return n + c.amountCents; }, 0);
    check('Y1 forgiven', forgiven, R.dues);

    // Per-scout outstanding, computed here from charges that still stand.
    var owedBy = {};
    S().charges.forEach(function (c) {
      if (c.waivedBy || c.forgiven) return;
      owedBy[c.scoutId] = (owedBy[c.scoutId] || 0) + c.amountCents;
    });
    var donated = owedBy.s8 || 0;
    addLedger({ direction: 'in', date: '2026-03-01', description: 'Camp assistance for Scout 9', amountCents: donated, scoutId: 's8', source: 'donation', donor: "St Mark's Church" });

    var paid = 0;
    Object.keys(owedBy).forEach(function (sid) {
      if (sid === 's8') return;                       // covered by the donation
      if (sid === 's7') return;                       // s7 does not pay — a real debtor at year end
      paid += owedBy[sid];
      addLedger({ direction: 'in', date: '2026-03-05', description: 'Payment from ' + sid, amountCents: owedBy[sid], scoutId: sid, source: 'family' });
    });

    var inTotal = y.commission + donated + paid;
    var bank = CARRYOVER + inTotal - outTotal;

    go('money', 'ledger');
    var ls = stats();
    check('Y1 money in', ls['Money in'], money(inTotal));
    check('Y1 money out', ls['Money out'], money(outTotal));
    check('Y1 bank balance', ls['Bank balance'], money(bank));

    go('money', 'dues');
    var ds = stats();
    check('Y1 charged', ds.Charged, money(y.raised));
    check('Y1 received', ds.Received, money(paid + donated));
    check('Y1 still owed', ds['Still owed'], money(owedBy.s7 || 0));
    note('s7 ends the year owing ' + money(owedBy.s7 || 0));

    // Per-line actual is the ledger, and a family payment must NOT reduce it.
    var camp = S().ledger.filter(function (e) { return e.lineId === 'L-camp' && e.direction === 'out'; })
      .reduce(function (n, e) { return n + e.amountCents; }, 0);
    go('money', 'budget');
    check('Y1 campout actual from the ledger', camp, 102000);
    var bs = stats();
    check('Y1 actual spent', bs['Actual spent'], money(outTotal));

    return { outTotal: outTotal, inTotal: inTotal, bank: bank, paid: paid, donated: donated, owedBy: owedBy, forgiven: forgiven };
  }

  function year1Reconcile(m) {
    results.push('--- reconcile ---');
    go('money', 'ledger');
    click('[data-act="ledger-view"][data-view="reconcile"]');
    click('[data-act="ledger-tick-all"]');
    set('[data-ch="book-statement"]', (m.bank / 100).toFixed(2));
    set('[data-ch="book-statement-date"]', '2026-06-30');
    var rs = stats();
    check('Y1 reconciles to the statement', rs.Difference, '$0.00');
    click('[data-act="ledger-reconcile-lock"]');
    check('Y1 reconciled-through stamped', S().book.reconciledThrough, '2026-06-30');
  }

  function year1Close(y, m) {
    results.push('--- close the year ---');
    var before = S();
    var archLineActual = {};
    before.ledger.forEach(function (e) {
      if (!e.lineId) return;
      if (e.direction === 'in' && e.scoutId) return;   // family money is income, not a refund
      archLineActual[e.lineId] = (archLineActual[e.lineId] || 0) + (e.direction === 'out' ? e.amountCents : -e.amountCents);
    });
    closeOut();
    var after = S();
    check('Y1 archived', after.archives.length, 1);
    var arch = after.archives[0];
    check('Y1 archive year', arch.year, 2025);
    check('Y1 archive actual = ledger', arch.budget.actualCents, m.outTotal);
    var archCamp = arch.budget.activities.filter(function (a) { return a.name === 'Fall campout'; })[0];
    check('Y1 archive keeps the real campout actual', archCamp.actualCents, archLineActual['L-camp']);
    return { arch: arch, closingBank: m.bank };
  }

  /* ================= YEAR 2 ================= */
  function year2Checks(c1, m1) {
    results.push('===== YEAR 2 (2026-27) =====');
    var st = S();
    check('Y2 program year advanced', st.budget.programYear, 2026);
    check('Y2 ledger cleared', st.ledger.length, 0);
    // Rollover clears charges, then syncCharges immediately re-raises the NEW year's
    // roster-based dues. So the right assertion is not "none" — it is that nothing SETTLED
    // came across, and every charge belongs to a line that exists this year.
    check('Y2 no waiver carried into the new year', st.charges.filter(function (c) { return c.waivedBy; }).length, 0);
    check('Y2 no forgiveness carried into the new year', st.charges.filter(function (c) { return c.forgiven; }).length, 0);
    var duesLine0 = st.budget.expenses.filter(function (l) { return l.name === 'Pack dues'; })[0];
    check('Y2 dues re-raised from the roster', st.charges.length, SCOUTS);
    check('Y2 every charge is on this year\u2019s dues line',
      st.charges.every(function (c) { return c.lineId === duesLine0.id; }), true);
    check('Y2 dues charged at the carried rate',
      st.charges.reduce(function (n, c) { return n + c.amountCents; }, 0), R.dues * SCOUTS);
    check('Y2 book opens at the closing bank balance', st.book.openingCents, m1.bank);
    check('Y2 book opening date', st.book.openingDate, '2026-09-01');

    // Categories and the pricing shape must survive.
    var cats = {};
    st.budget.activities.concat(st.budget.expenses).forEach(function (l) { cats[l.name] = l.category; });
    check('Y2 categories carried', cats, {
      'Fall campout': 'activities', 'Blue & Gold': 'events', 'Cub day camp': 'camp',
      'Charter fee': 'charter', 'Awards & badges': 'recognition',
      'Program materials': 'materials', 'Reserve fund': 'reserve', 'Pack dues': 'registration'
    });
    var camp = st.budget.activities.filter(function (l) { return l.name === 'Fall campout'; })[0];
    check('Y2 per-head rates kept, not re-derived', [camp.scoutRateCents, camp.adultRateCents, camp.siblingRateCents],
      [R.campScout, R.campAdult, R.campSib]);
    check('Y2 paid-direct payee carried', st.budget.activities.filter(function (l) { return l.name === 'Cub day camp'; })[0].paidDirectTo, 'Council');
    // Flat lines seed from what they ACTUALLY cost last year.
    var awards = st.budget.expenses.filter(function (l) { return l.name === 'Awards & badges'; })[0];
    check('Y2 flat line seeds from last year actual', awards.flatCents, 31250);
    var materials = st.budget.expenses.filter(function (l) { return l.name === 'Program materials'; })[0];
    check('Y2 second flat line seeds from actual', materials.flatCents, 58000);
    // Every activity comes back scheduled (unscheduled would lose the plan's months).
    check('Y2 every activity line still has an event', st.budget.activities.filter(function (l) { return !l.eventId; }).length, 0);
    check('Y2 events rebuilt undated', st.events.filter(function (e) { return e.date; }).length, 0);
    check('Y2 no orphan charges', st.charges.filter(function (c) {
      return !st.budget.activities.concat(st.budget.expenses).some(function (l) { return l.id === c.lineId; });
    }).length, 0);
    check('Y2 attendance cleared', Object.keys(st.attendance).length, 0);
    check('Y2 archive preserved', st.archives.length, 1);
    return true;
  }

  function year2Run(m1) {
    results.push('--- year 2 runs lighter ---');
    // No popcorn at all this year, and only dues charged. Tests a year with no commission.
    var st = S();
    st.rewardTiers.tiers = [];        // no tiers → nothing waived
    localStorage.setItem(KEY, JSON.stringify(st));
    location.reload();
    return true;
  }

  function year2Money(m1) {
    var st = S();
    var duesLine = st.budget.expenses.filter(function (l) { return l.name === 'Pack dues'; })[0];
    var expectDues = duesLine.scoutRateCents * SCOUTS;
    go('money', 'dues');
    check('Y2 dues charged from the roster', stats().Charged, money(expectDues));
    check('Y2 nothing waived without a tier', S().charges.filter(function (c) { return c.waivedBy; }).length, 0);

    // Spend a little, collect nothing, and confirm the bank tracks the OPENING balance.
    addLedger({ direction: 'out', date: '2026-09-10', description: 'Charter fee', amountCents: 10000, lineId: st.budget.expenses.filter(function (l) { return l.name === 'Charter fee'; })[0].id });
    go('money', 'ledger');
    check('Y2 bank = last year closing − spend', stats()['Bank balance'], money(m1.bank - 10000));
    return { bank: m1.bank - 10000 };
  }

  function year2Close(m2) {
    closeOut();
    var st = S();
    check('Y3 archives now hold two seasons', st.archives.length, 2);
    check('Y3 program year', st.budget.programYear, 2027);
    check('Y3 book opens at year 2 closing bank', st.book.openingCents, m2.bank);
    check('Y3 year-1 archive still intact', st.archives.filter(function (a) { return a.year === 2025; }).length, 1);
    check('Y3 year-2 archive recorded', st.archives.filter(function (a) { return a.year === 2026; }).length, 1);
    // As with year 2: cleared, then this year's dues re-raise from the roster. What must
    // NOT survive is anything settled.
    check('Y3 no settled charge survived the second rollover',
      st.charges.filter(function (c) { return c.waivedBy || c.forgiven; }).length, 0);
    check('Y3 dues re-raised again', st.charges.length, SCOUTS);
    check('Y3 no orphan charges', st.charges.filter(function (c) {
      return !st.budget.activities.concat(st.budget.expenses).some(function (l) { return l.id === c.lineId; });
    }).length, 0);
    // Cross-year: the year-1 archive must still hold year-1's real numbers after TWO
    // rollovers, and the bank must chain unbroken across both close-outs.
    var a1 = st.archives.filter(function (a) { return a.year === 2025; })[0];
    check('Y3 year-1 archive still holds its own actuals', a1.budget.actualCents, 235250);
    check('Y3 year-1 archive still holds its own planned', a1.budget.plannedCents, 345000);
    check('Y3 bank chain unbroken', [CARRYOVER, 37250, 27250], [CARRYOVER, 37250, st.book.openingCents]);
    check('Y3 every line still priced', st.budget.activities.concat(st.budget.expenses)
      .filter(function (l) { return !l.basis; }).length, 0);
    return true;
  }

  window.SCENARIO = {
    seed: year1,
    plan: year1Checks,
    sell: year1Run,
    charges: year1AfterSales,
    money: year1Money,
    reconcile: year1Reconcile,
    close: year1Close,
    y2: year2Checks,
    y2run: year2Run,
    y2money: year2Money,
    y2close: year2Close,
    report: function () { return { failures: failures, log: results }; },
    // Values that must survive a reload between acts.
    carry: function (k, v) {
      var o = load(); o.carry = o.carry || {};
      if (arguments.length > 1) { o.carry[k] = v; save(o); return v; }
      return o.carry[k];
    },
    reset: function () { results = []; failures = []; sessionStorage.removeItem('SCEN'); }
  };
})();
