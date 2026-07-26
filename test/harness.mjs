// Ideal Year of Scouting — test harness.
//
// Two comments in index.html have long assumed this file existed ("The Node harness asserts
// this with a source scan" at renderParentApp; "Pure (takes the state) so the Node harness
// can exercise it" at startHereVisible). It didn't. This is it.
//
// The app is one <script> IIFE that ends by touching the DOM, so we don't run the whole
// thing. Instead:
//   * SOURCE SCANS assert structural invariants (no `state` in the parent block, alias
//     coverage, attribute names) directly against the text.
//   * SLICED EVAL pulls named pure declarations out of the IIFE by their 2-space-indented
//     `function x(` / `var x =` header and evaluates just those in a bare sandbox.
//
// Run:  node test/harness.mjs
// Exit: 0 all green, 1 on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));

/* ---------------- tiny assert kit ---------------- */
let pass = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(`${name}\n      ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------------- slicing ---------------- */
// Declarations inside the IIFE are indented exactly two spaces, so a declaration ends at the
// first line that is `  }` / `  };` / `  ];` at that same indent. Good enough, and it fails
// loudly (ReferenceError in the sandbox) rather than silently if the file's style drifts.
function slice(name) {
  const re = new RegExp(`^  (?:function ${name}\\(|var ${name} =)`, 'm');
  const m = re.exec(SCRIPT);
  if (!m) throw new Error(`harness: could not find declaration "${name}" in index.html`);
  const rest = SCRIPT.slice(m.index);
  const end = /^  (?:\}|\};|\];)$/m.exec(rest);
  if (!end) throw new Error(`harness: could not find the end of "${name}"`);
  return rest.slice(0, end.index + end[0].length);
}
function sandbox(names) {
  const ctx = vm.createContext({});
  vm.runInContext(names.map(slice).join('\n'), ctx);
  return ctx;
}

/* ================================================================
   Wave 21 — the jobs model
   ================================================================ */
const jobs = sandbox([
  'DENS', 'JOBS', 'JOB_PATTERNS', 'JOB_BY_ID', 'jobLabel', 'arrOf',
  'jobsFromRoleText', 'densFromRoleText'
]);
// JOB_BY_ID is populated by a forEach that lives outside the sliced declaration.
vm.runInContext('JOBS.forEach(function (j) { JOB_BY_ID[j.id] = j; });', jobs);

test('every JOBS entry has id, label and a home workspace', () => {
  const homes = new Set(['home', 'program', 'scouts', 'popcorn', 'money', 'pack']);
  for (const j of jobs.JOBS) {
    ok(j.id && j.label, `job missing id/label: ${JSON.stringify(j)}`);
    ok(homes.has(j.home), `job "${j.id}" has unknown home workspace "${j.home}"`);
  }
});

test('the three jobs every pack must have are present', () => {
  const ids = jobs.JOBS.map((j) => j.id);
  for (const req of ['chair', 'secretary', 'treasurer']) {
    ok(ids.includes(req), `missing required committee job "${req}"`);
  }
});

test('JOB_PATTERNS only reference real job ids', () => {
  for (const p of jobs.JOB_PATTERNS) {
    ok(jobs.JOB_BY_ID[p.id], `pattern for unknown job id "${p.id}"`);
    if (p.notWith) ok(jobs.JOB_BY_ID[p.notWith], `notWith references unknown job "${p.notWith}"`);
  }
});

// The migration is the risky part: it runs once over every existing ledger.
test('free-text role migrates to structured jobs', () => {
  const f = jobs.jobsFromRoleText;
  eq(f('Cubmaster'), ['cubmaster'], 'Cubmaster');
  eq(f('Treasurer'), ['treasurer'], 'Treasurer');
  eq(f('Popcorn Kernel'), ['kernel'], 'Popcorn Kernel');
  eq(f('Committee Chair'), ['chair'], 'Committee Chair');
  eq(f('Advancement Chair'), ['advancement'], 'Advancement Chair');
  eq(f('Activities Chair'), ['activities'], 'Activities Chair');
  eq(f('Pack Trainer'), ['trainer'], 'Pack Trainer');
  eq(f('Wolf Den Leader'), ['denleader'], 'Wolf Den Leader');
});

test('assistant roles suppress their principal', () => {
  const f = jobs.jobsFromRoleText;
  eq(f('Assistant Den Leader'), ['asstden'], 'Assistant Den Leader must not also be denleader');
  eq(f('Assistant Cubmaster'), ['asstcub'], 'Assistant Cubmaster must not also be cubmaster');
});

// Multi-job is the whole point: one person routinely holds two or three of these.
test('a person can hold several jobs at once', () => {
  const f = jobs.jobsFromRoleText;
  let got = f('Treasurer and Popcorn Kernel');
  ok(got.includes('treasurer') && got.includes('kernel'), `expected both, got ${JSON.stringify(got)}`);
  got = f('Assistant Cubmaster & Popcorn Kernel');
  ok(got.includes('asstcub') && got.includes('kernel'), `expected both, got ${JSON.stringify(got)}`);
  ok(!got.includes('cubmaster'), 'Assistant Cubmaster must not also yield cubmaster');
  got = f('Den Leader / Treasurer');
  ok(got.includes('denleader') && got.includes('treasurer'), `expected both, got ${JSON.stringify(got)}`);
});

test('the widened job list covers the roles a pack actually fills', () => {
  const f = jobs.jobsFromRoleText;
  eq(f('Pinewood Derby Chair'), ['derbychair'], 'Pinewood Derby Chair');
  eq(f('Camping Chair'), ['outdoors'], 'Camping Chair');
  eq(f('Webmaster'), ['comms'], 'Webmaster');
});

test('overlapping patterns do not double-assign', () => {
  // 'outdoor'/'camp' used to live on activities too; they must resolve to exactly one job.
  eq(jobs.jobsFromRoleText('Outdoor Chair'), ['outdoors'], 'Outdoor Chair');
  eq(jobs.jobsFromRoleText('Activities Chair'), ['activities'], 'Activities Chair');
});

test('there is no free-text role input left in the leader row', () => {
  // The picker is the single answer to "what do they do" — a text box would compete with it.
  ok(!/data-ch="ldr-role"/.test(SCRIPT), 'a data-ch="ldr-role" input still exists');
  ok(!/ch === 'ldr-role'/.test(SCRIPT), "a stale 'ldr-role' change handler still exists");
  // …but the stored field must survive, since it is what the migration reads.
  ok(/jobsFromRoleText\(l\.role\)/.test(SCRIPT), 'the migration no longer reads l.role');
});

test('migration never invents jobs from empty or unknown text', () => {
  eq(jobs.jobsFromRoleText(''), [], 'empty string');
  eq(jobs.jobsFromRoleText(undefined), [], 'undefined');
  eq(jobs.jobsFromRoleText('Snack coordinator'), [], 'unrelated free text');
});

test('den scope is extracted from the role text', () => {
  eq(jobs.densFromRoleText('Wolf Den Leader'), ['Wolf'], 'Wolf');
  eq(jobs.densFromRoleText('Arrow of Light den leader'), ['Arrow of Light'], 'Arrow of Light');
  eq(jobs.densFromRoleText('Cubmaster'), [], 'no den mentioned');
});

test('every den in a migrated scope is a real den', () => {
  for (const d of jobs.densFromRoleText('lion tiger wolf bear webelos arrow of light')) {
    ok(jobs.DENS.includes(d), `"${d}" is not in DENS`);
  }
});

test('arrOf guards every non-array', () => {
  eq(jobs.arrOf(undefined), [], 'undefined');
  eq(jobs.arrOf(null), [], 'null');
  eq(jobs.arrOf('nope'), [], 'string');
  eq(jobs.arrOf(['a']), ['a'], 'passthrough');
});

/* ================================================================
   Structural invariants (source scans)
   ================================================================ */

test('jobs are a lens, never a gate', () => {
  // myJobs() may only order/mark. If it ever appears next to a permission predicate, the
  // two concepts have been conflated — which is the drift the JOBS banner warns about.
  const bad = /(canEdit|isAdmin|MEMBER_ROLES)\s*\(\s*\)?\s*&&\s*(myJobs|hasJob)\(|(myJobs|hasJob)\([^)]*\)\s*&&\s*(canEdit|isAdmin)\(/;
  ok(!bad.test(SCRIPT), 'myJobs()/hasJob() is being combined with a permission check');
});

test('the parent render block never reads `state`', () => {
  // The invariant renderParentApp's own comment claims the harness asserts.
  const start = SCRIPT.indexOf('function renderParentApp(');
  ok(start > -1, 'renderParentApp not found');
  const after = SCRIPT.slice(start);
  const end = after.indexOf('function renderStorefrontList(');
  ok(end > -1, 'could not find the end of the parent block');
  const block = after.slice(0, end);
  const hit = /\bstate\./.exec(block);
  ok(!hit, `parent block reads state at: ${block.slice(Math.max(0, hit?.index - 60), hit?.index + 60)}`);
});

test('leaders[].jobs and [].dens are defaulted in the normalizer', () => {
  const start = SCRIPT.indexOf('function normalizeState(');
  const block = SCRIPT.slice(start, start + 4000);
  ok(/l\.jobs = jobsFromRoleText\(l\.role\)/.test(block), 'jobs are not seeded from the old role text');
  ok(/l\.dens = densFromRoleText\(l\.role\)/.test(block), 'dens are not seeded from the old role text');
  ok(/typeof l\.uid !== 'string'/.test(block), 'leaders[].uid is not defaulted');
});

test('the normalizer never bumps the version gate', () => {
  // Additive fields only — the whole migration strategy depends on this staying === 1.
  ok(/d\.version !== 1/.test(SCRIPT), 'the v1 gate is gone');
  ok(!/\bd\.version\s*=\s*[2-9]/.test(SCRIPT), 'something writes a version above 1');
});

test('add-leader seeds the new job fields', () => {
  const m = /state\.leaders\.push\(\{[^}]*\}\)/.exec(SCRIPT);
  ok(m, 'add-leader push not found');
  for (const k of ['jobs:', 'dens:', 'uid:']) ok(m[0].includes(k), `add-leader is missing ${k}`);
});

/* ================================================================
   Wave 21 — the six-workspace nav shell
   ================================================================ */
const nav = sandbox(['WORKSPACES', 'TAB_ALIAS']);

const OLD_TABS = ['calendar', 'storefronts', 'scouts', 'advancement', 'totals',
  'budget', 'inventory', 'derby', 'pack'];

test('TAB_ALIAS covers every one of the nine old tabs', () => {
  // This is what lets the data-tab="…" strings already embedded across index.html keep
  // working untouched. A miss here is a dead button, not a crash — hence the test.
  for (const id of OLD_TABS) ok(nav.TAB_ALIAS[id], `no alias for the old "${id}" tab`);
  eq(Object.keys(nav.TAB_ALIAS).sort(), [...OLD_TABS].sort(), 'alias keys');
});

test('every alias points at a workspace and section that exist', () => {
  const wsIds = new Set(nav.WORKSPACES.map((w) => w.id));
  for (const [old, dest] of Object.entries(nav.TAB_ALIAS)) {
    ok(wsIds.has(dest.tab), `alias "${old}" -> unknown workspace "${dest.tab}"`);
    const ws = nav.WORKSPACES.find((w) => w.id === dest.tab);
    ok(ws.sections.some((s) => s.id === dest.section),
      `alias "${old}" -> "${dest.section}" is not a section of "${dest.tab}"`);
  }
});

test('section ids are globally unique', () => {
  // SECTION_HOME is a flat id -> workspace map, so a duplicate would silently route a
  // section to the wrong workspace.
  const seen = new Set();
  for (const w of nav.WORKSPACES) {
    for (const s of w.sections) {
      ok(!seen.has(s.id), `section id "${s.id}" is used in more than one workspace`);
      seen.add(s.id);
    }
  }
});

test('Home is first, and is the first paint', () => {
  eq(nav.WORKSPACES[0].id, 'home', 'first workspace');
  ok(/^\s*tab: 'home',/m.test(SCRIPT), "ui.tab does not default to 'home'");
  ok(/^\s*sections: \{\}/m.test(SCRIPT), 'ui.sections is not initialised');
});

test('every old tab label survives as a section label', () => {
  // The migration promise: muscle memory maps 1:1, so no clever renames.
  const labels = new Set(nav.WORKSPACES.flatMap((w) => w.sections.map((s) => s.label)));
  for (const l of ['Calendar', 'Derby', 'Advancement', 'Standings', 'Budget', 'Inventory', 'Storefronts']) {
    ok(labels.has(l), `the old "${l}" label no longer appears as a section`);
  }
});

test('every renderer the dispatch names is reachable from some section', () => {
  const sectionIds = new Set(nav.WORKSPACES.flatMap((w) => w.sections.map((s) => s.id)));
  const dispatch = [...SCRIPT.matchAll(/sec === '([a-z]+)'/g)].map((m) => m[1]);
  ok(dispatch.length >= 8, `expected the section dispatch chain, found ${dispatch.length} branches`);
  for (const id of dispatch) ok(sectionIds.has(id), `dispatch handles "${id}", which is not a section`);
});

test('navigation funnels through gotoNav', () => {
  // Stray `ui.tab = …` assignments bypass section bookkeeping and the scroll reset.
  const strays = [...SCRIPT.matchAll(/ui\.tab = (?!'popcorn';\s*\/\/ Wave 21)/g)];
  const decl = /tab: 'home',/.test(SCRIPT);
  ok(decl, 'ui.tab declaration missing');
  ok(strays.length <= 1, `${strays.length} direct ui.tab assignments remain; navigation should go through gotoNav()`);
});

test('the section strip is not sticky chrome', () => {
  // It must be a SIBLING that follows a closed .topbar, on --ground — not a second row
  // inside it. Nested, sticky chrome grows from ~93px to ~136px, and on a phone with the
  // keyboard up that is most of what's left to type a budget line into.
  const shell = /<div class="topbar no-print">[\s\S]*?<main id="view"/.exec(HTML);
  ok(shell, 'could not find the app shell markup');
  // topbar-inner closes, then topbar closes, THEN the subnav opens.
  ok(/<\/div>\s*<\/div>\s*<div class="subnav-wrap no-print" id="subnav" hidden>/.test(shell[0]),
    'the section strip is not a sibling following a closed .topbar');
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  ok(/\.subnav-wrap \{ background: var\(--ground\); \}/.test(css),
    'the section strip does not sit on --ground');
});

test('nav chrome never prints and is keyboard-escapable', () => {
  ok(/class="subnav-wrap no-print"/.test(HTML), 'the section strip is missing no-print');
  ok(/class="skip-link no-print" href="#view"/.test(HTML), 'no skip link past the nav strips');
  ok(/<main id="view" tabindex="-1">/.test(HTML), 'the skip target is not focusable');
});

test("SIG_ATTRS carries 'section' so focus survives a re-render", () => {
  const m = /var SIG_ATTRS = \[([^\]]+)\]/.exec(SCRIPT);
  ok(m, 'SIG_ATTRS not found');
  ok(m[1].includes("'section'"), "SIG_ATTRS is missing 'section'");
  ok(m[1].includes("'tab'"), "SIG_ATTRS lost 'tab'");
});

test('no in-content jump collides with a workspace strip button', () => {
  // findBySignature uses querySelector — first match in document order wins — so an
  // in-card data-act="tab" whose data-tab is also a workspace id would steal focus to
  // the topbar on every re-render.
  const wsIds = new Set(nav.WORKSPACES.map((w) => w.id));
  for (const m of SCRIPT.matchAll(/data-act="tab" data-tab="([a-z]+)"/g)) {
    ok(!wsIds.has(m[1]),
      `an in-content button uses data-act="tab" data-tab="${m[1]}", which collides with the workspace strip`);
  }
});

test('gold is never used as a marker on navy', () => {
  // --accent on --navy is 2.71:1 — fails 4.5:1 for text and 3:1 for a non-text indicator.
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  const tabMine = /\.tab\.mine::before \{[^}]*\}/.exec(css);
  ok(tabMine, '.tab.mine::before not found');
  ok(/background: var\(--navy-ink\)/.test(tabMine[0]),
    'the "yours" marker on the navy strip must use --navy-ink, not --accent');
});

/* ================================================================
   Wave 21 — relocations
   ================================================================ */

test('Season setup is one card rendered in two workspaces', () => {
  // A section can't live in two workspaces; a card can. That's why it's a card.
  ok(/function seasonSetupCard\(opts\)/.test(SCRIPT), 'seasonSetupCard() not found');
  const calls = [...SCRIPT.matchAll(/seasonSetupCard\(/g)].length;
  ok(calls >= 3, `expected the definition plus two call sites, found ${calls} occurrences`);
  ok(/h \+= seasonSetupCard\(\{ collapsible: true \}\)/.test(SCRIPT), 'Popcorn does not render Season setup');
  ok(/var h = seasonSetupCard\(\)/.test(SCRIPT), 'Money does not render Season setup');
});

test('the pack name left Season setup for Pack', () => {
  const card = /function seasonSetupCard\(opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(card, 'seasonSetupCard body not found');
  ok(!/data-ch="pack-name"/.test(card[0]), 'the pack name is still inside Season setup');
  const sharing = /function renderPackSharing\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(sharing && /data-ch="pack-name"/.test(sharing[0]), 'the pack name is not on Pack · Sharing');
});


test('the Trail’s End file input exists exactly once', () => {
  // It used to be emitted from two places; whichever rendered second lost the id, so the
  // picker silently opened the wrong element.
  const n = [...HTML.matchAll(/id="teFile"/g)].length;
  eq(n, 1, 'teFile input count');
});

test('the importer is permanent, not empty-state-only', () => {
  const fn = /function teImportCard\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'teImportCard() not found');
  // Its three real destinations must be visible, since one button serves all three.
  for (const w of ['Storefront Shifts', 'Inventory Transactions', 'Sales Transactions']) {
    ok(fn[0].includes(w), `the importer does not name the "${w}" report`);
  }
  const list = /function renderStorefrontList\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok((list[0].match(/teImportCard\(\)/g) || []).length >= 2,
    'the importer is not rendered in both the empty and populated states');
});

test('no user-facing copy points at a tab that no longer exists', () => {
  // Comments are exempt; strings are not.
  const stale = [];
  for (const m of SCRIPT.matchAll(/'[^'\n]*\bthe (Budget|Storefronts|Standings|Totals|Inventory|Advancement|Derby) tab\b[^'\n]*'/g)) {
    stale.push(m[0].slice(0, 70));
  }
  ok(!stale.length, `stale tab references in copy: ${stale.join(' | ')}`);
});

test('the printable money map lists the same seams the UI does', () => {
  // main is display:none when printing, so handoff cards never reach paper and this list
  // is all a new treasurer gets. If they drift, the handoff document lies.
  const fn = /function renderPackSeason\(\) \{[\s\S]*?<\/ul><\/div>'/.exec(SCRIPT);
  ok(fn, 'the "Where the money lives" list was not found in renderPackSeason');
  for (const seam of ['Dues &amp; fees', 'Fundraisers', 'Past seasons']) {
    ok(fn[0].includes(seam), `the printable money map no longer mentions ${seam}`);
  }
});

/* ================================================================
   Wave 21 — Home
   ================================================================ */
const home = sandbox(['TIER_ORDER', 'pickHomeTasks']);

test('the urgency rank is shared by every job', () => {
  // Per-job urgency scales would make a three-job person's Home incoherent.
  eq(Object.keys(home.TIER_ORDER).sort(), ['now', 'week', 'whenever'], 'tiers');
  ok(home.TIER_ORDER.now < home.TIER_ORDER.week, 'now must outrank week');
  ok(home.TIER_ORDER.week < home.TIER_ORDER.whenever, 'week must outrank whenever');
});

test('a noisy job cannot crowd a quiet one out', () => {
  // Kernel+Treasurer in November: five popcorn items and one dues item. Without
  // round-robin the treasurer never learns the app knows about dues.
  const tasks = [
    ...Array.from({ length: 5 }, (_, i) => ({ job: 'kernel', tier: 'now', title: `k${i}` })),
    { job: 'treasurer', tier: 'week', title: 't0' },
  ];
  const picked = home.pickHomeTasks(tasks, ['kernel', 'treasurer'], 5);
  eq(picked.length, 5, 'picked count');
  ok(picked.some((t) => t.job === 'treasurer'), 'the treasurer got no slot at all');
  ok(picked.filter((t) => t.job === 'kernel').length <= 4, 'the kernel took every slot');
});

test('the picked queue comes back in urgency order', () => {
  const tasks = [
    { job: 'a', tier: 'whenever', title: 'w' },
    { job: 'a', tier: 'now', title: 'n' },
    { job: 'b', tier: 'week', title: 'k' },
  ];
  const picked = home.pickHomeTasks(tasks, ['a', 'b'], 5);
  eq(picked.map((t) => t.tier), ['now', 'week', 'whenever'], 'tier order');
});

test('pickHomeTasks terminates on odd input', () => {
  eq(home.pickHomeTasks([], ['kernel'], 5).length, 0, 'no tasks');
  eq(home.pickHomeTasks([{ job: 'nobody', tier: 'now', title: 'x' }], ['kernel'], 5).length, 0,
    'a task whose job nobody holds must not be picked');
  eq(home.pickHomeTasks([{ job: 'kernel', tier: 'now', title: 'x' }], [], 5).length, 0, 'no jobs');
});

test('Home renders no inputs', () => {
  // The app re-renders on every keystroke; an input here would put computeBudget() and
  // computeScoutTotals() in the typing path.
  const fn = /function renderHome\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(fn, 'renderHome() not found');
  ok(!/data-ch="/.test(fn[0]), 'renderHome emits a data-ch input');
  const flow = /function packFlow\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(!/data-ch="/.test(flow[0]), 'packFlow emits a data-ch input');
});

test('every Home task routes somewhere that exists', () => {
  // A task pointing at a dead section is a dead row — silent, and only found by tapping it.
  const fn = /function homeTasks\(\) \{[\s\S]*?\n    return out;\n  \}/.exec(SCRIPT);
  ok(fn, 'homeTasks() not found');
  const sectionIds = new Set(nav.WORKSPACES.flatMap((w) => w.sections.map((s) => s.id)));
  const wsIds = new Set(nav.WORKSPACES.map((w) => w.id));
  const calls = [...fn[0].matchAll(/'(\w+)',\s*'(\w+)'\);/g)];
  ok(calls.length >= 8, `expected many add() calls, found ${calls.length}`);
  for (const [, tab, section] of calls) {
    ok(wsIds.has(tab), `a task routes to unknown workspace "${tab}"`);
    ok(sectionIds.has(section), `a task routes to unknown section "${section}"`);
  }
});

test('every Home task names a real job', () => {
  const fn = /function homeTasks\(\) \{[\s\S]*?\n    return out;\n  \}/.exec(SCRIPT);
  for (const m of fn[0].matchAll(/add\('(\w+)',/g)) {
    ok(jobs.JOB_BY_ID[m[1]], `a task is owned by unknown job "${m[1]}"`);
  }
});

test('the Pack Flow map is real text, not SVG', () => {
  // SVG <text> does not wrap, ignores the reader's font size, and is not selectable.
  const fn = /function packFlow\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'packFlow() not found');
  ok(!/<svg/i.test(fn[0]), 'packFlow emits SVG');
  ok(/<ol class="flow">/.test(fn[0]), 'packFlow is not an ordered list');
  ok(/flow-step list-row/.test(fn[0]), 'flow stages do not reuse .list-row, so Enter/Space will not work');
});

test('the job pill is never coloured by urgency', () => {
  // The pill says who owns the item. A column of red job names reads as alarm, not
  // ownership — urgency gets its own quiet marker instead.
  const fn = /function homeTaskRow\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'homeTaskRow() not found');
  ok(!/pill' \+ \(t\.tier/.test(fn[0]), 'the job pill is still styled by tier');
  ok(/<span class="urg"/.test(fn[0]), 'there is no separate urgency marker');
  ok(/visually-hidden/.test(fn[0]), 'the urgency marker is not announced to screen readers');
});

test('the moved notice is an additive, dismissible flag', () => {
  ok(/d\.movedNoticeDismissed = d\.movedNoticeDismissed === true/.test(SCRIPT),
    'movedNoticeDismissed is not defaulted in the normalizer');
  ok(/movedNoticeDismissed: false/.test(SCRIPT), 'movedNoticeDismissed is missing from freshState');
  ok(/act === 'moved-dismiss'/.test(SCRIPT), 'no dismiss action');
  ok(/act === 'moved-go'/.test(SCRIPT), 'using a row to navigate does not dismiss the notice');
});

test('Start here lives on Home, not Calendar', () => {
  const cal = /function renderCalendarTab\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(cal, 'renderCalendarTab not found');
  ok(!/Start here<\/h2>/.test(cal[0]), 'the Start here card is still on the Calendar');
  const hm = /function renderHome\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(/Start here<\/h2>/.test(hm[0]), 'the Start here card is not on Home');
});

/* ================================================================
   Wave 21 — handoff cards and den scoping
   ================================================================ */


test('a handoff renders only when it carries a live figure', () => {
  // The anti-banner-blindness rule is a RENDER rule, not styling: a handoff conditional
  // on data can never decay into decoration.
  const fn = /function handoffCard\([\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'handoffCard() not found');
  ok(/if \(!w \|\| !figure\) return '';/.test(fn[0]), 'handoffCard does not bail on a missing figure');
});

test('every handoff points at a section that exists', () => {
  const sectionIds = new Set(nav.WORKSPACES.flatMap((w) => w.sections.map((s) => s.id)));
  // Five seams. The sixth (Pack · People -> Popcorn two-deep gaps) went away with the
  // storefront adults roster — this pack sends a parent with each scout.
  const calls = [...SCRIPT.matchAll(/handoffCard\('([^']+)', '([^']+)', '(\w+)'/g)];
  ok(calls.length >= 5, `expected the five seams, found ${calls.length}`);
  for (const [, , , section] of calls) {
    ok(sectionIds.has(section), `a handoff routes to unknown section "${section}"`);
  }
});

test('handoffs never reach paper', () => {
  // main is display:none when printing. They carry no-print anyway, and the printable
  // counterpart is the "Where the money lives" list on Pack · Season.
  const fn = /function handoffCard\([\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/class="handoff no-print"/.test(fn[0]), 'the handoff card is missing no-print');
});

test('the handoff is quieter than a card, not louder', () => {
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  const rule = /\n  \.handoff \{[^}]*\}/.exec(css);
  ok(rule, '.handoff rule not found');
  ok(/background: var\(--surface-2\)/.test(rule[0]), '.handoff should sit on the recessed surface');
  ok(!/box-shadow/.test(rule[0]), '.handoff must not have a shadow — every .card has one');
  ok(/min-height: 44px/.test(rule[0]), '.handoff is below a comfortable phone target');
});

test('den scope distinguishes "untouched" from "all dens"', () => {
  // null = fall back to the signed-in leader's den; '' = they chose All dens. Collapsing
  // the two makes the All dens button do nothing.
  ok(/denFilter: null/.test(SCRIPT), 'ui.denFilter does not start as null');
  const uses = [...SCRIPT.matchAll(/ui\.denFilter === null \? myDens\(\) : \(ui\.denFilter \? \[ui\.denFilter\] : \[\]\)/g)];
  ok(uses.length >= 2, `the three-state check should guard both scoped screens, found ${uses.length}`);
  ok(/ui\.denFilter = el\.dataset\.name \|\| ''/.test(SCRIPT),
    'the den-filter action does not write an empty string for All dens');
});

test('den scope is a default, never a lock', () => {
  // A den leader covering for someone else must always be able to see the whole pack.
  const chips = [...SCRIPT.matchAll(/data-act="den-filter" data-name=""/g)];
  ok(chips.length >= 2, `every scoped screen needs an "All dens" escape, found ${chips.length}`);
});

test('den scope never gates a workspace', () => {
  // Scoping filters rows. It must not decide what someone can reach.
  ok(!/myDens\(\)[^;\n]*\?\s*'' :/.test(SCRIPT), 'myDens() is being used to hide a surface');
});

/* ================================================================
   Wave 21 — storefront shifts track scouts only
   ================================================================ */

test('nothing tracks adults on a storefront shift', () => {
  // Pack policy: a parent accompanies their scout, so adults are 1:1 with the scouts who
  // sign up. A separate roster would be data nobody ever fills in, and a two-deep warning
  // computed from it would fire on every shift forever.
  for (const dead of ['blockAdultLeaders', 'blockNeedsAdults', 'storefrontNeedsAdults', 'getLeader']) {
    ok(!SCRIPT.includes(dead + '('), `${dead}() is still referenced`);
  }
  for (const act of ['adult-assign', 'adult-remove']) {
    ok(!SCRIPT.includes(`'${act}'`), `the ${act} handler still exists`);
  }
  ok(!/adults: \[\]/.test(SCRIPT), 'a new block is still seeded with an adults array');
});

test('no surface still says a shift needs adults', () => {
  // String literals only — a comment explaining what was removed is legitimate history.
  const literals = [...SCRIPT.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).join(' ');
  for (const phrase of ['needs adults', 'Needs two-deep', 'no adults', 'Adults on this block']) {
    ok(!literals.includes(phrase), `user-facing copy still reads "${phrase}"`);
  }
});

test('the glance pill flags an unfilled shift instead', () => {
  // An empty SHIFT is the real gap now — that is what leaves the table unstaffed.
  const fn = /function glanceStatus\(sf\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'glanceStatus() not found');
  ok(/storefrontCoverage\(sf\)/.test(fn[0]), 'glanceStatus no longer derives from shift coverage');
  ok(/shift' \+ /.test(fn[0]), 'the middle state does not report open shifts');
});

test('the RSVP adults count is untouched', () => {
  // Different feature: "how many adults are coming" on an RSVP, not shift staffing.
  ok(/adults: rVal === 'yes'/.test(SCRIPT), 'the RSVP adults tally was removed by mistake');
});

test('deleting a leader no longer cascades into storefronts', () => {
  const fn = /if \(act\.indexOf\('del-leader:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'the del-leader handler was not found');
  ok(!/storefronts/.test(fn[0]), 'deleting a leader still walks the storefronts');
});

/* ================================================================
   Wave 21 — per-tier reward coverage
   ================================================================ */
test('coverage stacks up the tiers a scout has reached', () => {
  // A top seller must never end up with less than a lower seller, so a scout at tier 3
  // gets everything tiers 1-3 cover — not just tier 3's own list.
  const ctx = vm.createContext({});
  vm.runInContext(
    `${slice('packCoverage')}
     var TIERS = [
       { id:'t1', thresholdCents: 30000, covers:['x1'] },
       { id:'t2', thresholdCents: 45000, covers:['act:a3'] },
       { id:'t3', thresholdCents: 90000, covers:[] }
     ];
     var SALES = { top: 50000, mid: 35000, low: 1000 };
     function sortedTiers() { return TIERS; }
     function arrOf(v) { return Array.isArray(v) ? v : []; }
     function computeScoutTotals() { return SALES; }
     function goalBaseOf(r) { return r.t; }
     function activeScouts() { return [{id:'top'},{id:'mid'},{id:'low'}]; }
     var RESULT = packCoverage();`, ctx);
  const r = ctx.RESULT;
  eq(Object.keys(r.x1).sort(), ['mid', 'top'], 'tier-1 charge covers everyone past tier 1');
  eq(Object.keys(r['act:a3']), ['top'], 'tier-2 charge covers only the scout past tier 2');
  ok(r.x1.top, 'the tier-2 scout must ALSO get what tier 1 covers');
  ok(!r.x1.low, 'a scout below every tier is covered for nothing');
});

test('a tier covering nothing is valid', () => {
  // Prizes, a pack shirt, a patch: a reward description with no budget line behind it.
  ok(/if \(!Array\.isArray\(tier\.covers\)\) tier\.covers = \[\]/.test(SCRIPT),
    'tier.covers is not defaulted in the normalizer');
  const add = /state\.rewardTiers\.tiers\.push\(\{[^}]*\}\)/.exec(SCRIPT);
  ok(add && add[0].includes('covers: []'), 'a new tier is not seeded with an empty covers list');
});

test('the pack covering a fee is lost income, not a new cost', () => {
  // The charge's own value is already in planned/actual (est x roster), so adding a lump
  // on top would double-count it. What changes is that the family no longer reimburses.
  const fn = /function addFeeItem\(item, colKey\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'addFeeItem() not found');
  ok(/if \(cov\[s\.id\]\) \{ feesAbsorbed \+= each; return; \}/.test(fn[0]),
    'a covered scout is not excluded from expected fee income');
  ok(!/actual \+= feesAbsorbed/.test(SCRIPT), 'absorbed fees are being double-counted into actual spent');
});

test('the legacy dues lump switches off once coverage is configured', () => {
  // Both applying at once would count the same dues twice.
  ok(/var rewardDues = tierCoverageConfigured\(\) \? 0 : reward\.rewardDues/.test(SCRIPT),
    'the old lump is still added after per-tier coverage is set up');
  const fn = /function tierCoverageConfigured\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn && /arrOf\(t\.covers\)\.length > 0/.test(fn[0]), 'tierCoverageConfigured() does not test for covers');
});


test('coverage is derived, never written into state.collected', () => {
  // The collect grids stay a record of what FAMILIES paid. Mixing the two is what would
  // let the same dues be counted as both a pack cost and family income.
  const fn = /function packCoverage\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'packCoverage() not found');
  ok(!/state\.collected/.test(fn[0]), 'packCoverage writes or reads state.collected');
});

/* ================================================================
   Money redesign — Phase 0 (the ledger) and Phase 1 (actual = sum of ledger).
   See DESIGN-money.md sections 3.3 and 5.
   ================================================================ */

// The ledger math is deliberately pure — it takes (ledger, book) rather than reading
// `state` — precisely so it can be exercised here rather than by clicking around.
const LEDGER_FNS = ['ledgerSort', 'entrySignedCents', 'entryAfterOpening', 'ledgerBalance',
  'lineActualCents', 'ledgerTotals', 'reconcileTotals', 'runningBalances'];

function entry(o) {
  return Object.assign({ id: 'x', date: '2025-10-01', description: '', amountCents: 0,
    direction: 'out', lineId: '', method: '', ref: '', source: '', donor: '',
    scoutId: '', reconciled: false }, o);
}

test('money in and money out are the only sign — amounts are always positive', () => {
  const { entrySignedCents } = sandbox(LEDGER_FNS);
  eq(entrySignedCents(entry({ amountCents: 5000, direction: 'in' })), 5000, 'money in');
  eq(entrySignedCents(entry({ amountCents: 5000, direction: 'out' })), -5000, 'money out');
});

test('the bank balance is the opening figure plus what actually moved', () => {
  const { ledgerBalance } = sandbox(LEDGER_FNS);
  const book = { openingCents: 42000, openingDate: '2025-09-01' };
  const led = [
    entry({ id: 'a', date: '2025-09-15', amountCents: 10000, direction: 'out' }),
    entry({ id: 'b', date: '2025-10-02', amountCents: 273000, direction: 'in' })
  ];
  eq(ledgerBalance(led, book), 42000 - 10000 + 273000, 'balance');
});

test('an entry dated before the opening date never moves the bank balance', () => {
  // The opening figure is the bank's word for everything up to that date, so counting a
  // backfilled receipt again would double it. This is the whole reason both ways of
  // starting a ledger (opening balance / backfill) can share one mechanism.
  const { ledgerBalance, ledgerTotals } = sandbox(LEDGER_FNS);
  const book = { openingCents: 50000, openingDate: '2025-09-01' };
  const led = [
    entry({ id: 'old', date: '2025-08-14', amountCents: 9900, direction: 'out' }),
    entry({ id: 'new', date: '2025-09-14', amountCents: 9900, direction: 'out' })
  ];
  eq(ledgerBalance(led, book), 50000 - 9900, 'only the post-opening entry counts');
  eq(ledgerTotals(led, book).preOpening, 1, 'the pre-opening entry is reported, not hidden');
});

test('with no opening date set, every entry counts', () => {
  const { ledgerBalance } = sandbox(LEDGER_FNS);
  const led = [entry({ date: '2001-01-01', amountCents: 700, direction: 'in' })];
  eq(ledgerBalance(led, { openingCents: 0, openingDate: '' }), 700, 'balance');
});

test("a line's actual is money out against it, less anything refunded back", () => {
  const { lineActualCents } = sandbox(LEDGER_FNS);
  const led = [
    entry({ id: '1', lineId: 'L', amountCents: 102000, direction: 'out' }),
    entry({ id: '2', lineId: 'L', amountCents: 2000, direction: 'in' }),
    entry({ id: '3', lineId: 'OTHER', amountCents: 500000, direction: 'out' }),
    entry({ id: '4', lineId: '', amountCents: 1234, direction: 'out' })
  ];
  eq(lineActualCents(led, 'L'), 100000, 'actual for L');
  eq(lineActualCents(led, ''), 0, 'an empty lineId matches nothing, not everything');
});

test("a line's actual ignores the opening date", () => {
  // A backfilled receipt is still what the line cost, even though the opening balance
  // already accounts for the cash having left. Cost and cash position are separate
  // questions, which is the point of splitting them at all.
  const { lineActualCents } = sandbox(LEDGER_FNS);
  const led = [entry({ id: '1', date: '2025-08-01', lineId: 'L', amountCents: 4200, direction: 'out' })];
  eq(lineActualCents(led, 'L'), 4200, 'actual');
});

test('the running balance is computed in date order, not entry order', () => {
  const { runningBalances } = sandbox(LEDGER_FNS);
  const book = { openingCents: 10000, openingDate: '' };
  const led = [
    entry({ id: 'later', date: '2025-11-01', amountCents: 3000, direction: 'out' }),
    entry({ id: 'earlier', date: '2025-10-01', amountCents: 5000, direction: 'in' })
  ];
  const run = runningBalances(led, book);
  eq(run.earlier, 15000, 'earlier row');
  eq(run.later, 12000, 'later row');
});

test('a pre-opening entry has no place in the running balance', () => {
  const { runningBalances } = sandbox(LEDGER_FNS);
  const run = runningBalances(
    [entry({ id: 'old', date: '2025-01-01', amountCents: 100, direction: 'out' })],
    { openingCents: 0, openingDate: '2025-09-01' });
  eq(run.old, null, 'pre-opening row');
});

test('reconciling compares the TICKED entries to the statement', () => {
  const { reconcileTotals } = sandbox(LEDGER_FNS);
  const book = { openingCents: 10000, openingDate: '2025-09-01', statementCents: 12000 };
  const led = [
    entry({ id: 'cleared', date: '2025-09-10', amountCents: 5000, direction: 'in', reconciled: true }),
    entry({ id: 'outstanding', date: '2025-09-20', amountCents: 900, direction: 'out', reconciled: false })
  ];
  const rec = reconcileTotals(led, book);
  eq(rec.cleared, 15000, 'ticked balance excludes the outstanding entry');
  eq(rec.ticked, 1, 'ticked count');
  eq(rec.open, 1, 'outstanding count');
  eq(rec.difference, 12000 - 15000, 'difference is statement minus ticked');
});

/* ---- Phase 1 migration: totals identical before and after ---- */

// normalizeState is the single migration seam, so the migration is tested through it
// rather than through a reimplementation of it.
const NORMALIZE_FNS = ['defaultProgramYear', 'freshBudget', 'programYearStartISO',
  'programYearEndISO', 'EVENT_KINDS', 'freshEvent', 'ADV_RENAMES', 'dateToSlot',
  'ATT_MAX_HEADS', 'attHeads', 'freshAttendance', 'attEmpty', 'attTotals',
  'centsOf', 'freshLine', 'LINE_BASES', 'LINE_FUNDERS', 'HEAD_KINDS',
  'linePlannedHeads', 'linePlannedCents',
  'LEDGER_METHODS', 'LEDGER_SOURCES', 'LEDGER_SOURCE_LABELS',
  'freshBook', 'TE_LINEUP', 'freshInventory', 'JOBS', 'arrOf', 'jobsFromRoleText',
  'densFromRoleText', 'normalizeSeasonArchive', 'uid', 'pad2', 'todayISO',
  'parseLegacyTime', 'normalizeState', 'lineActualCents', 'entrySignedCents'];

function preMigrationState() {
  // A pre-Phase-0 pack record, with the two shapes that matter: a flat line and a
  // per-scout line (whose actualCents was a RATE multiplied by the roster on every read).
  return {
    version: 1, packName: 'Pack 569',
    scouts: [
      { id: 's1', name: 'Ben' }, { id: 's2', name: 'Ivy' }, { id: 's3', name: 'Mae' },
      { id: 's4', name: 'Gus', archived: true }   // archived scouts were never multiplied
    ],
    budget: {
      programYear: 2025, startingBalance: 42000,
      activities: [
        { id: 'a1', slot: 1, name: 'Fall campout', date: '2025-10-18', estCents: 80000, actualCents: 102000, perScout: false, familyPays: false },
        { id: 'a2', slot: 9, name: 'Cub day camp', date: '', estCents: 14500, actualCents: 14500, perScout: true, familyPays: true },
        { id: 'a3', slot: 3, name: 'Not paid for yet', date: '', estCents: 5000, actualCents: 0, perScout: false, familyPays: false }
      ],
      expenses: [
        { id: 'e1', name: 'Charter fee', estCents: 10000, actualCents: 10000, perScout: false, familyPays: false },
        { id: 'e2', name: 'Pack dues', estCents: 8000, actualCents: 2500, perScout: true, familyPays: true }
      ]
    }
  };
}

// What computeBudget used to produce for "actual": rate x roster for a per-scout line.
function legacyActualTotal(d) {
  const n = d.scouts.filter(s => !s.archived).length;
  const sum = rows => rows.reduce((t, x) => t + (x.actualCents || 0) * (x.perScout ? n : 1), 0);
  return sum(d.budget.activities) + sum(d.budget.expenses);
}

test('Phase 1 migration: actual totals are identical before and after', () => {
  // This is THE migration test named in DESIGN-money.md section 5. If it ever fails, a
  // pack's books moved on their own during an upgrade, which is unforgivable in a
  // financial record however small.
  const ctx = sandbox(NORMALIZE_FNS);
  const before = preMigrationState();
  const expected = legacyActualTotal(before);
  const after = ctx.normalizeState(before);
  ok(after, 'normalizeState rejected the record');
  const rows = after.budget.activities.concat(after.budget.expenses);
  const got = rows.reduce((t, x) => t + ctx.lineActualCents(after.ledger, x.id), 0);
  eq(got, expected, 'total actual across every line');
});

test('Phase 1 migration: a per-scout rate becomes a total, once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preMigrationState());
  // 3 active scouts (the archived one never counted), $145 each.
  eq(ctx.lineActualCents(after.ledger, 'a2'), 14500 * 3, 'day camp');
  eq(ctx.lineActualCents(after.ledger, 'e2'), 2500 * 3, 'dues');
  eq(ctx.lineActualCents(after.ledger, 'a1'), 102000, 'a flat line is not multiplied');
});

test('Phase 1 migration: actualCents is deleted and never migrated twice', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const once = ctx.normalizeState(preMigrationState());
  const n = once.ledger.length;
  ok(once.budget.activities.every(a => !('actualCents' in a)), 'actualCents survived on an activity');
  ok(once.budget.expenses.every(e => !('actualCents' in e)), 'actualCents survived on an expense');
  // The field's ABSENCE is the marker that migration has run. Re-normalizing (which happens
  // on every load, every import and every sync adoption) must add nothing.
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  eq(twice.ledger.length, n, 'ledger grew on a second normalize');
});

test('Phase 1 migration: a zero actual writes no entry', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preMigrationState());
  ok(!after.ledger.some(e => e.lineId === 'a3'), 'an unpaid line got a $0 ledger entry');
  eq(after.ledger.length, 4, 'one entry per line that had an actual');
});

test('Phase 1 migration: entries land on the line, dated, and unreconciled', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preMigrationState());
  const campout = after.ledger.find(e => e.lineId === 'a1');
  eq(campout.date, '2025-10-18', "a dated line keeps the event's date");
  eq(campout.direction, 'out', 'direction');
  eq(campout.description, 'Fall campout', 'description');
  ok(after.ledger.every(e => e.reconciled === false),
    'migrated money was marked reconciled — it has never been held next to a statement');
  const undated = after.ledger.find(e => e.lineId === 'e1');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(undated.date), 'an undated line got no date at all');
  ok(undated.date <= '2026-08-31' && undated.date >= '2025-09-01',
    `an undated line landed outside its program year (${undated.date})`);
});

test('Phase 0: the ledger and book survive normalization additively', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = preMigrationState();
  d.ledger = [{ id: 'k', date: '2025-09-09', description: 'Deposit', amountCents: -500,
    direction: 'in', lineId: 'a1', method: 'nonsense', source: 'donation',
    donor: 'St Marks', scoutId: 's1', reconciled: true }];
  d.book = { openingCents: 12345.6, openingDate: '2025-09-01' };
  const after = ctx.normalizeState(d);
  const k = after.ledger.find(e => e.id === 'k');
  eq(k.amountCents, 500, 'a stored negative is folded into direction');
  eq(k.method, '', 'an unknown method is dropped');
  eq(k.source, 'donation', 'a known source is kept');
  eq(k.scoutId, 's1', 'scoutId is carried through for Phase 3');
  eq(after.book.openingCents, 12346, 'the opening figure is rounded to whole cents');
  eq(after.book.reconciledThrough, '', 'missing book fields are defaulted');
});

test('actual is no longer a field a budget row can type into', () => {
  // Phase 1's contract: actual is derived. A stray input would silently reintroduce the
  // second source of truth this whole redesign exists to remove.
  ok(!/data-ch="act-actual"/.test(SCRIPT), 'the activity row still has an Actual input');
  ok(!/data-ch="exp-actual"/.test(SCRIPT), 'the expense row still has an Actual input');
  ok(!/ch === 'act-actual'/.test(SCRIPT), 'act-actual is still handled');
  ok(!/ch === 'exp-actual'/.test(SCRIPT), 'exp-actual is still handled');
  // computeBudget must read the ledger, and must NOT multiply actual by the roster.
  const fn = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'computeBudget() not found');
  ok(/actActual \+= lineActualCents\(state\.ledger, a\.id\)/.test(fn[0]), 'activity actual is not ledger-derived');
  ok(/expActual \+= lineActualCents\(state\.ledger, e\.id\)/.test(fn[0]), 'expense actual is not ledger-derived');
  ok(!/actualCents \|\| 0\) \* /.test(fn[0]), 'computeBudget still multiplies an actual by the roster');
});

test('the year rollover clears the ledger and opens next year at the bank balance', () => {
  // The old entries point at line ids that no longer exist after the re-seed, so leaving
  // them would strand every one of them as uncategorised.
  const fn = /function rolloverYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'rolloverYear() not found');
  ok(/state\.ledger = \[\]/.test(fn[0]), 'the ledger is carried into the new year');
  ok(/var closingBank = bookBalance\(\)/.test(fn[0]), 'the closing bank balance is not captured');
  ok(/closingBank/.test(fn[0]) && /openingCents = closingBank/.test(fn[0]),
    "next year's book does not open at the closing bank balance");
  // Phase 3a — a per-head line keeps its RATES rather than back-deriving them from a total
  // that depended on who happened to turn up; only flat lines seed from the ledger.
  ok(/if \(linePerHead\(x\)\) return;/.test(fn[0]),
    'a per-head line is having its rates re-derived from last year\u2019s total');
  ok(/state\.events\.push\(ev\)/.test(fn[0]),
    'the rollover does not rebuild the calendar — the plan would come back unscheduled');
});

test('a divergence merge never drops a ledger entry', () => {
  // The append-only merge is the recovery path when two copies of a pack record diverge.
  // Popcorn sales are protected there; transactions must be too.
  const fn = /function mergeRemoteAppendOnly\(d\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'mergeRemoteAppendOnly() not found');
  ok(/unionById\(state\.ledger, remote\.ledger\)/.test(fn[0]),
    'ledger entries are not unioned on merge — one device could lose another device\'s transactions');
});

test('a record holding only a ledger does not read as empty', () => {
  // isStateEmpty gates whether a remote copy is adopted wholesale. A treasurer who opens
  // the books before anyone types a roster must not have that work adopted away.
  const fn = /function isStateEmpty\(s\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'isStateEmpty() not found');
  ok(/s\.ledger && s\.ledger\.length/.test(fn[0]), 'isStateEmpty ignores the ledger');
});

test('the parent view never carries the ledger', () => {
  // Parents get a sanitized calendar. The pack's transactions are not theirs to see, and
  // the published doc is world-readable to anyone the pack has approved as a parent.
  const fn = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'buildParentView() not found');
  ok(!/ledger/i.test(fn[0]), 'buildParentView references the ledger');
  ok(!/\bbook\b/.test(fn[0]), 'buildParentView references the book (opening/statement balances)');
});

/* ================================================================
   Money redesign — Phase 2: events split out of the budget (DESIGN-money.md 3.1).
   ================================================================ */

function preSplitState() {
  return {
    version: 1, packName: 'Pack 569',
    scouts: [{ id: 's1', name: 'Ben' }, { id: 's2', name: 'Ivy' }],
    meetings: [
      { id: 'm1', kind: 'den', den: 'Wolf', date: '2025-09-10', time: '19:00', note: 'Library', adventure: 'Call of the Wild' },
      { id: 'm2', kind: 'pack', den: '', date: '2025-09-24', time: '18:30', note: '' }
    ],
    attendance: { m1: { s1: true, s2: true } },
    rsvps: {
      'mtg:m2': { s1: { s: 'yes', adults: 2 } },
      'act:a1': { s2: { s: 'maybe', adults: 0 } },
      'sf:sf1': { s1: { s: 'yes', adults: 1 } }
    },
    budget: {
      programYear: 2025, startingBalance: 0,
      activities: [
        { id: 'a1', slot: 1, name: 'Fall campout', date: '2025-10-18', time: '09:00', endTime: '15:00',
          location: 'Camp Rainey', note: 'Bring boots', sourceUid: 'band-77', estCents: 80000,
          actualCents: 0, perScout: false, familyPays: false },
        { id: 'a2', slot: 5, name: 'Blue & Gold', date: '', estCents: 30000, actualCents: 0, perScout: false, familyPays: false }
      ],
      expenses: []
    }
  };
}

test('Phase 2: every meeting and activity becomes an event', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  eq(after.events.length, 4, 'event count');
  eq(after.meetings.length, 0, 'meetings[] is emptied');
  ok(Array.isArray(after.meetings), 'meetings[] was deleted rather than emptied — an older build would crash');
  const kinds = after.events.map(e => e.kind).sort();
  eq(kinds, ['activity', 'activity', 'den', 'pack'], 'kinds');
});

test('Phase 2: the calendar fields leave the budget line, the money stays', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  const line = after.budget.activities.find(a => a.id === 'a1');
  ok(line, 'the budget line kept its own id — the ledger posts against it');
  eq(line.flatCents, 80000, 'the money stayed on the line');
  ['date', 'time', 'endTime', 'location', 'note', 'sourceUid', 'slot'].forEach(f => {
    ok(!(f in line), `calendar field "${f}" is still on the budget line`);
  });
  const ev = after.events.find(e => e.id === line.eventId);
  ok(ev, 'the line does not point at an event');
  eq(ev.date, '2025-10-18', 'event date');
  eq(ev.location, 'Camp Rainey', 'event location');
  eq(ev.sourceUid, 'band-77', 'ICS round-trip uid moved to the event');
  ok(!('estCents' in ev), 'the event carries money');
});

test('Phase 2: event ids are fresh, and never alias a budget line id', () => {
  // Reusing the old ids would have been cheaper but would leave event.id === line.id for
  // every migrated activity, aliasing two record types in one namespace forever.
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  const lineIds = new Set(after.budget.activities.map(a => a.id));
  after.events.forEach(e => ok(!lineIds.has(e.id), `event ${e.id} reuses a budget line id`));
  ok(!after.events.some(e => e.id === 'm1' || e.id === 'm2'), 'a meeting id was reused as an event id');
});

test('Phase 2: attendance is repointed onto the event, not lost', () => {
  // The single most destructive thing this migration could get wrong.
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  const den = after.events.find(e => e.kind === 'den');
  // Phase 2b turned each tick into a head count of one; the point here is that the marks
  // followed the meeting onto its new event id at all.
  eq(after.attendance[den.id],
    { s1: { scout: 1, adults: 0, siblings: 0 }, s2: { scout: 1, adults: 0, siblings: 0 } },
    'attendance followed the meeting');
  eq(Object.keys(after.attendance).length, 1, 'a stale meeting-keyed entry was left behind');
});

test('Phase 2: RSVPs collapse onto the bare event id, storefronts keep their prefix', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  const pack = after.events.find(e => e.kind === 'pack');
  const campout = after.events.find(e => e.name === 'Fall campout');
  eq(after.rsvps[pack.id], { s1: { s: 'yes', adults: 2 } }, 'meeting RSVP');
  eq(after.rsvps[campout.id], { s2: { s: 'maybe', adults: 0 } }, 'activity RSVP');
  eq(after.rsvps['sf:sf1'], { s1: { s: 'yes', adults: 1 } }, 'storefronts are not events and keep sf:');
  ok(!after.rsvps['mtg:m2'] && !after.rsvps['act:a1'], 'a prefixed key survived the migration');
});

test('Phase 2: a meeting keeps its den, adventure and note', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  const den = after.events.find(e => e.kind === 'den');
  eq(den.den, 'Wolf', 'den');
  eq(den.adventure, 'Call of the Wild', 'adventure drives the advancement mark-off');
  eq(den.note, 'Library', 'note');
  const pack = after.events.find(e => e.kind === 'pack');
  eq(pack.den, '', 'a pack meeting has no den');
  eq(pack.adventure, '', 'a pack meeting has no adventure');
});

test('Phase 2: a dated event takes its month from the date, an undated one keeps its slot', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState(preSplitState());
  eq(after.events.find(e => e.name === 'Fall campout').slot, 1, 'October is slot 1');
  eq(after.events.find(e => e.name === 'Blue & Gold').slot, 5, 'undated keeps its planning slot');
});

test('Phase 2: migration runs once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const once = ctx.normalizeState(preSplitState());
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  eq(twice.events.length, once.events.length, 'events grew on a second normalize');
  eq(Object.keys(twice.attendance).length, 1, 'attendance was repointed twice');
});

test('Phase 2: a budget line whose event vanished is unlinked, not left dangling', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState(preSplitState());
  const line = d.budget.activities.find(a => a.id === 'a1');
  d.events = d.events.filter(e => e.id !== line.eventId);   // the event was deleted
  const after = ctx.normalizeState(JSON.parse(JSON.stringify(d)));
  eq(after.budget.activities.find(a => a.id === 'a1').eventId, '', 'the stale link survived');
  eq(after.budget.activities.find(a => a.id === 'a1').flatCents, 80000, 'the money was lost with the event');
});

test('importing a calendar no longer writes budget rows', () => {
  // DESIGN-money.md's very first listed symptom. The import path must touch state.events
  // and never state.budget.
  const fn = /function findExisting\(evt\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'findExisting() not found');
  ok(/state\.events/.test(fn[0]) && !/state\.budget/.test(fn[0]),
    'the ICS importer still matches against budget rows');
  const commit = /events\.forEach\(function \(evt\) \{[\s\S]*?\n    \}\);/.exec(SCRIPT);
  ok(commit, 'the ICS commit loop not found');
  ok(/state\.events\.push/.test(commit[0]), 'the importer does not create events');
  ok(!/state\.budget\.activities\.push/.test(commit[0]),
    'importing a calendar still creates budget rows — this is the bug Phase 2 exists to fix');
});

test('deleting a calendar event never deletes the budget line under it', () => {
  // The ledger posts against the line. Removing it to service a calendar edit would orphan
  // real transactions.
  const fn = /if \(act\.indexOf\('del-event:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'the del-event handler not found');
  ok(/state\.events\.splice/.test(fn[0]), 'del-event does not remove the event');
  ok(!/budget\.activities\.splice/.test(fn[0]), 'del-event also deletes the budget line');
});

test('the parent view publishes the calendar and no money', () => {
  const fn = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'buildParentView() not found');
  ok(/state\.events\.forEach/.test(fn[0]), 'the parent view does not read events[]');
  ok(!/estCents|lineForEvent|budget\.activities/.test(fn[0]),
    'the parent view reads budget data — cost could leak into the published copy');
});

/* ================================================================
   Money redesign — Phase 2b: attendance is a head count (DESIGN-money.md 3.1).
   ================================================================ */

const ATT_FNS = ['ATT_MAX_HEADS', 'attHeads', 'freshAttendance', 'attEmpty', 'attTotals'];

test('Phase 2b: the old boolean tick becomes a head count of one', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = preSplitState();
  const after = ctx.normalizeState(d);
  const den = after.events.find(e => e.kind === 'den');
  eq(after.attendance[den.id].s1, { scout: 1, adults: 0, siblings: 0 }, 'migrated mark');
});

test('Phase 2b: head counts are clamped to sane whole numbers', () => {
  const { attHeads } = sandbox(ATT_FNS);
  eq(attHeads(2), 2, 'plain number');
  eq(attHeads('3'), 3, 'string from a number input');
  eq(attHeads(-4), 0, 'negative heads are nonsense');
  eq(attHeads(2.7), 2, 'fractional people are nonsense');
  eq(attHeads('abc'), 0, 'garbage');
  eq(attHeads(1e9), 99, 'clamped to ATT_MAX_HEADS');
});

test('Phase 2b: a family of zeros is pruned, not stored', () => {
  // "Absent from the map" has to keep meaning "did not come", exactly as the boolean did —
  // otherwise every scout who was ever unticked would read as a family that turned up with
  // nobody in it.
  const { attEmpty, attTotals } = sandbox(ATT_FNS);
  ok(attEmpty({ scout: 0, adults: 0, siblings: 0 }), 'all-zero is empty');
  ok(attEmpty(null), 'missing is empty');
  ok(!attEmpty({ scout: 0, adults: 2, siblings: 0 }), 'adults alone still counts as attendance');
  eq(attTotals({ s1: { scout: 0, adults: 0, siblings: 0 } }).heads, 0, 'a zero row contributes nothing');
});

test('Phase 2b: totals count families, scouts and heads separately', () => {
  // The worked example in DESIGN-money.md 3.4: 8 scouts, 13 adults, 5 siblings = 26 heads.
  const { attTotals } = sandbox(ATT_FNS);
  const marked = {};
  for (let i = 0; i < 8; i++) marked['s' + i] = { scout: 1, adults: 0, siblings: 0 };
  marked.s0.adults = 2; marked.s0.siblings = 1;
  marked.s1.adults = 2; marked.s1.siblings = 1;
  marked.s2.adults = 2; marked.s2.siblings = 1;
  marked.s3.adults = 2; marked.s3.siblings = 1;
  marked.s4.adults = 2; marked.s4.siblings = 1;
  marked.s5.adults = 1;
  marked.s6.adults = 1;
  marked.s7.adults = 1;
  const t = attTotals(marked);
  eq(t.scouts, 8, 'scouts');
  eq(t.adults, 13, 'adults');
  eq(t.siblings, 5, 'siblings');
  eq(t.heads, 26, 'heads');
  eq(t.families, 8, 'families');
});

test('Phase 2b: an unreadable attendance value is dropped, not coerced to a phantom head', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = preSplitState();
  d.attendance.m1.s2 = 'yes';       // garbage
  d.attendance.m1.s1 = { scout: 1, adults: '2', siblings: -3 };
  const after = ctx.normalizeState(d);
  const den = after.events.find(e => e.kind === 'den');
  ok(!after.attendance[den.id].s2, 'a garbage value became a head count');
  eq(after.attendance[den.id].s1, { scout: 1, adults: 2, siblings: 0 }, 'coerced in place');
});

test('Phase 2b: attendance migration runs once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const once = ctx.normalizeState(preSplitState());
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  const den = twice.events.find(e => e.kind === 'den');
  eq(twice.attendance[den.id].s1, { scout: 1, adults: 0, siblings: 0 }, 'stable across re-normalize');
});

test('a roster attendance percentage counts scouts, never total heads', () => {
  // Counting the parents who came would push the close-out average past 100%.
  const fn = /\/\/ Average attendance across[\s\S]*?\n    \}\);/.exec(SCRIPT);
  ok(fn, 'the close-out attendance average not found');
  ok(/attTotals\(state\.attendance\[m\.id\]\)\.scouts/.test(fn[0]),
    'the close-out average is not counting scouts');
});

test('the head-count grid is only asked for where heads cost something', () => {
  // A weekly den meeting keeps its plain roll-call; an activity is where the money is.
  const fn = /function renderAttendanceBlock\(m\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'renderAttendanceBlock() not found');
  ok(/var heads = m\.kind === 'activity'/.test(fn[0]), 'the grid does not distinguish activities from meetings');
  ok(/data-ch="att-adults"/.test(fn[0]) && /data-ch="att-siblings"/.test(fn[0]), 'head-count inputs missing');
});

/* ================================================================
   Money redesign — Phase 3a: how a line is priced, and whose money it is (3.2).
   ================================================================ */

const PRICE_FNS = ['centsOf', 'uid', 'freshLine', 'LINE_BASES', 'LINE_FUNDERS',
  'linePlannedHeads', 'linePlannedCents'];

test('Phase 3a: the line-shape migration does not move a single total', () => {
  // Same discipline as Phase 1. Today's planned is estCents x roster for a per-scout line
  // and estCents flat otherwise; a migrated line must plan to exactly the same number.
  const ctx = sandbox(NORMALIZE_FNS);
  const scouts = 10;
  const before = {
    version: 1, scouts: Array.from({ length: scouts }, (_, i) => ({ id: 's' + i, name: 'S' + i })),
    budget: {
      programYear: 2025, startingBalance: 0,
      activities: [
        { id: 'a1', slot: 1, name: 'Campout', estCents: 80000, perScout: false, familyPays: false },
        { id: 'a2', slot: 9, name: 'Day camp', estCents: 14500, perScout: true, familyPays: true }
      ],
      expenses: [
        { id: 'e1', name: 'Charter', estCents: 10000, perScout: false, familyPays: false },
        { id: 'e2', name: 'Dues', estCents: 8000, perScout: true, familyPays: true }
      ]
    }
  };
  const legacy = [...before.budget.activities, ...before.budget.expenses]
    .reduce((t, x) => t + x.estCents * (x.perScout ? scouts : 1), 0);
  const after = ctx.normalizeState(JSON.parse(JSON.stringify(before)));
  const got = [...after.budget.activities, ...after.budget.expenses]
    .reduce((t, x) => t + ctx.linePlannedCents(x, scouts), 0);
  eq(got, legacy, 'total planned across every line');
});

test('Phase 3a: a per-scout line becomes a per-head line priced on the scout rate', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [{ id: 's1' }],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Dues', estCents: 8000, perScout: true, familyPays: true },
      { id: 'e2', name: 'Charter', estCents: 10000, perScout: false, familyPays: false }
    ] }
  });
  const dues = d.budget.expenses.find(e => e.id === 'e1');
  eq(dues.basis, 'per-head', 'basis');
  eq(dues.scoutRateCents, 8000, 'the estimate became the SCOUT rate');
  eq(dues.adultRateCents, 0, 'no adult rate is invented');
  eq(dues.siblingRateCents, 0, 'no sibling rate is invented');
  eq(dues.adultsPerScout, 1, 'the planning assumption defaults to one adult per scout');
  eq(dues.fundedBy, 'families', 'familyPays became fundedBy');
  const charter = d.budget.expenses.find(e => e.id === 'e2');
  eq(charter.basis, 'flat', 'basis');
  eq(charter.flatCents, 10000, 'flat cost');
  eq(charter.fundedBy, 'pack', 'the pack pays for its own charter');
  [dues, charter].forEach(l => {
    ok(!('estCents' in l) && !('perScout' in l) && !('familyPays' in l),
      'an old pricing field survived the migration');
  });
});

test('Phase 3a: an adult rate of zero means the assumption changes nothing', () => {
  // adultsPerScout defaults to 1, so a migrated line multiplies one adult by a rate of
  // zero. If that default ever started costing money, every pack's plan would jump on
  // upgrade — which is exactly what the totals test above exists to prevent.
  const { linePlannedCents, freshLine } = sandbox(PRICE_FNS);
  const l = freshLine({ basis: 'per-head', scoutRateCents: 4000, adultRateCents: 0, adultsPerScout: 1 });
  eq(linePlannedCents(l, 10), 40000, 'planned');
});

test('Phase 3a: planned is rates x an assumed head count, stated openly', () => {
  // DESIGN-money.md 3.2: one adult per scout and no siblings is the honest default — the
  // minimum the pack is on the hook for.
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const bg = freshLine({ basis: 'per-head', scoutRateCents: 1500, adultRateCents: 1500, siblingRateCents: 800 });
  eq(linePlannedHeads(bg, 10), { scouts: 10, adults: 10, siblings: 0 }, 'assumed heads');
  eq(linePlannedCents(bg, 10), 30000, 'the 3.4 worked example plans to $300');
  bg.adultsPerScout = 2;
  eq(linePlannedCents(bg, 10), 45000, 'two parents always come on this one');
});

test('Phase 3a: a flat line ignores the roster entirely', () => {
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const charter = freshLine({ basis: 'flat', flatCents: 10000, scoutRateCents: 999 });
  eq(linePlannedCents(charter, 50), 10000, 'a charter fee is a charter fee');
  eq(linePlannedHeads(charter, 50), { scouts: 0, adults: 0, siblings: 0 }, 'no heads are assumed');
});

test('Phase 3a: "the pack pays, but somebody else is paid directly" is not expressible', () => {
  // If the pack is paying, it goes through the pack's account. The UI must not offer the
  // combination and the model must not store it.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Camp', basis: 'flat', flatCents: 100, fundedBy: 'pack', paidDirectTo: 'Council' }
    ] }
  });
  eq(d.budget.expenses[0].paidDirectTo, '', 'a pack-funded line kept a payee');
});

test('Phase 3a: council money never touches the pack balance, but is still visible', () => {
  // fundedBy: families + paidDirectTo: Council. No charge, no ledger entry, no effect on
  // the balance — and still counted in what the year costs a family.
  const fn = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'computeBudget() not found');
  ok(/if \(!lineThroughPack\(a\)\) \{ familyDirect \+=/.test(fn[0]),
    'paid-direct activities are still counted as pack spending');
  ok(/if \(!lineThroughPack\(e\)\) \{ familyDirect \+=/.test(fn[0]),
    'paid-direct expenses are still counted as pack spending');
  ok(/familyDirect: familyDirect/.test(fn[0]),
    'the true-cost-to-a-family figure is computed but never reported');
  const fee = /function addFeeItem\(item, colKey\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fee && /lineThroughPack\(item\)/.test(fee[0]),
    'a paid-direct line still raises family fee income the pack never handles');
});

test('Phase 3a: switching basis carries the money across rather than zeroing it', () => {
  const h = /if \(bk === 'basis'\) \{[\s\S]*?\n      \}/.exec(SCRIPT)
    || /\} else if \(bk === 'basis'\) \{[\s\S]*?\n      \}/.exec(SCRIPT);
  ok(h, 'the basis handler not found');
  ok(/bl\.scoutRateCents = bl\.flatCents/.test(h[0]) && /bl\.flatCents = bl\.scoutRateCents/.test(h[0]),
    'switching basis silently wipes the amount somebody typed');
});

test('one handler set serves every budget line, not parallel act-/exp- families', () => {
  ok(/if \(ch\.indexOf\('line-'\) === 0\)/.test(SCRIPT), 'the unified line- handler is missing');
  ["act-est", "exp-est", "act-perscout", "exp-perscout", "act-familypays", "exp-familypays"]
    .forEach(dead => ok(!SCRIPT.includes(`'${dead}'`), `${dead} is still handled`));
});

/* ================================================================
   Money redesign — Phase 3b: charges and family accounts (DESIGN-money.md 3.4).
   ================================================================ */

const CHARGE_FNS = ['CHARGE_WHO', 'centsOf', 'chargeKey', 'chargeRowsFor', 'chargeIsOpen',
  'paymentsForScout', 'familyOutstanding', 'chargeTotals'];

function line3b(patch) {
  return Object.assign({
    id: 'L', name: 'Blue & Gold', basis: 'per-head', eventId: 'E',
    scoutRateCents: 1500, adultRateCents: 1500, siblingRateCents: 800,
    flatCents: 0, adultsPerScout: 1, fundedBy: 'families', paidDirectTo: ''
  }, patch);
}

test('Phase 3b: one charge per head, because that is how the cost is incurred', () => {
  // "A family that brought the scout, both parents and a younger sibling gets four charges
  // against that scout's account: one scout, two adult, one sibling."
  const { chargeRowsFor } = sandbox(CHARGE_FNS);
  const rows = chargeRowsFor(line3b(), { s1: { scout: 1, adults: 2, siblings: 1 } }, []);
  eq(rows.length, 4, 'charge count');
  eq(rows.filter(r => r.who === 'scout').length, 1, 'scout charges');
  eq(rows.filter(r => r.who === 'adult').length, 2, 'adult charges');
  eq(rows.filter(r => r.who === 'sibling').length, 1, 'sibling charges');
  eq(rows.reduce((t, r) => t + r.amountCents, 0), 1500 + 3000 + 800, 'total');
});

test('Phase 3b: the 3.4 worked example bills 26 heads, not 20', () => {
  // 8 scouts came, 13 adults, 5 siblings. scout $15, adult $15, sibling $8.
  const { chargeRowsFor } = sandbox(CHARGE_FNS);
  const marked = {};
  for (let i = 0; i < 8; i++) marked['s' + i] = { scout: 1, adults: i < 5 ? 2 : 1, siblings: i < 5 ? 1 : 0 };
  const rows = chargeRowsFor(line3b(), marked, []);
  const total = rows.reduce((t, r) => t + r.amountCents, 0);
  eq(rows.filter(r => r.who === 'scout').length, 8, 'scouts');
  eq(rows.filter(r => r.who === 'adult').length, 13, 'adults');
  eq(rows.filter(r => r.who === 'sibling').length, 5, 'siblings');
  eq(total, 8 * 1500 + 13 * 1500 + 5 * 800, 'charged $355.00');
  eq(total, 35500, 'charged, in cents');
});

test('Phase 3b: a line with no event charges the roster, not the attendance', () => {
  // Dues are owed by every registered scout whether or not they come to anything. Raising
  // them from attendance would bill nobody.
  const { chargeRowsFor } = sandbox(CHARGE_FNS);
  const dues = line3b({ id: 'D', name: 'Pack dues', eventId: '', scoutRateCents: 8000, adultRateCents: 0, siblingRateCents: 0 });
  const rows = chargeRowsFor(dues, null, [{ id: 's1' }, { id: 's2' }]);
  eq(rows.length, 2, 'one per scout on the roster');
  eq(rows.every(r => r.who === 'scout'), true, 'nobody is billed an adult for dues');
});

test('Phase 3b: a rate of zero raises no charge', () => {
  const { chargeRowsFor } = sandbox(CHARGE_FNS);
  const rows = chargeRowsFor(line3b({ siblingRateCents: 0 }), { s1: { scout: 1, adults: 0, siblings: 3 } }, []);
  eq(rows.length, 1, 'three free siblings raised three $0 charges');
});

test("a family's payment is income, not a refund of what the pack spent", () => {
  // Backfilled dues payments carry a lineId. Without this distinction a dues line reads as
  // negative spending and the pack's "actual spent" goes below zero.
  const { lineActualCents } = sandbox(LEDGER_FNS);
  const led = [
    entry({ id: '1', lineId: 'L', amountCents: 50000, direction: 'out' }),
    entry({ id: '2', lineId: 'L', amountCents: 8000, direction: 'in', scoutId: 's1', source: 'family' }),
    entry({ id: '3', lineId: 'L', amountCents: 8000, direction: 'in', scoutId: 's2', source: 'donation' }),
    entry({ id: '4', lineId: 'L', amountCents: 2000, direction: 'in', scoutId: '' })   // vendor refund
  ];
  eq(lineActualCents(led, 'L'), 48000, 'family money reduced the cost of the line');
});

test('Phase 3b: the four settlements are counted apart, never collapsed', () => {
  // A donation leaves the pack whole; a waiver or forgiveness does not. Collapsing any of
  // them into "paid" or "written off" would misstate the pack's position.
  const { chargeTotals } = sandbox(CHARGE_FNS);
  const charges = [
    { scoutId: 's1', amountCents: 1500, waivedBy: '', forgiven: null },   // paid below
    { scoutId: 's2', amountCents: 1500, waivedBy: 't1', forgiven: null }, // waived
    { scoutId: 's3', amountCents: 1500, waivedBy: '', forgiven: { reason: 'hardship' } },
    { scoutId: 's4', amountCents: 1500, waivedBy: '', forgiven: null }    // donated below
  ];
  const ledger = [
    { direction: 'in', scoutId: 's1', amountCents: 1500, source: 'family' },
    { direction: 'in', scoutId: 's4', amountCents: 1500, source: 'donation' },
    { direction: 'out', scoutId: '', amountCents: 9999, source: '' }
  ];
  const t = chargeTotals(charges, ledger);
  eq(t.raised, 6000, 'every charge was raised');
  eq(t.waived, 1500, 'waived');
  eq(t.forgiven, 1500, 'forgiven');
  eq(t.paid, 1500, 'paid by a family');
  eq(t.donated, 1500, 'covered by a donation');
  eq(t.standing, 3000, 'still standing after waiver and forgiveness');
  eq(t.outstanding, 0, 'everything standing has been settled by money');
});

test('Phase 3b: a donation settles a charge exactly as a family payment does', () => {
  const { familyOutstanding } = sandbox(CHARGE_FNS);
  const charges = [{ scoutId: 's1', amountCents: 8000, waivedBy: '', forgiven: null }];
  eq(familyOutstanding(charges, [{ direction: 'in', scoutId: 's1', amountCents: 8000, source: 'donation' }], 's1'),
    0, "St Mark's covered it — the family owes nothing");
  eq(familyOutstanding(charges, [], 's1'), 8000, 'unpaid');
});

test('Phase 3b: a waived or forgiven charge is not owed, and is not deleted', () => {
  const { familyOutstanding, chargeIsOpen } = sandbox(CHARGE_FNS);
  const waived = { scoutId: 's1', amountCents: 8000, waivedBy: 't1', forgiven: null };
  const forgiven = { scoutId: 's1', amountCents: 4000, waivedBy: '', forgiven: { reason: 'x' } };
  eq(familyOutstanding([waived, forgiven], [], 's1'), 0, 'neither is owed');
  ok(!chargeIsOpen(waived) && !chargeIsOpen(forgiven), 'both still read as settled');
  // They are still THERE — an auditor can read a marked charge; a missing one tells them nothing.
  eq([waived, forgiven].length, 2, 'a settled charge was deleted');
});

test('Phase 3b: a family is never shown as owing a negative amount', () => {
  const { familyOutstanding } = sandbox(CHARGE_FNS);
  const charges = [{ scoutId: 's1', amountCents: 1000, waivedBy: '', forgiven: null }];
  eq(familyOutstanding(charges, [{ direction: 'in', scoutId: 's1', amountCents: 5000 }], 's1'), 0, 'overpayment');
});

test('a reward tier waives the scout share only, never the heads they brought', () => {
  // "A scout's fundraising buys the scout's seat, not the family's." One line of rule, and
  // it is the entire feature.
  const fn = /function applyTierWaivers\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'applyTierWaivers() not found');
  ok(/if \(c\.who !== 'scout'\) \{ c\.waivedBy = ''; return; \}/.test(fn[0]),
    'a tier is waiving adult or sibling charges');
  ok(/c\.waivedBy = et \? et\.id/.test(fn[0]),
    'the waiver does not record WHICH tier bought it — total waived stops being measurable');
});

test('reconciling charges never removes one that has been settled or paid against', () => {
  // A book does not lose rows because somebody fixed a head count.
  const fn = /function syncCharges\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'syncCharges() not found');
  ok(/if \(c\.waivedBy \|\| c\.forgiven\) return true;/.test(fn[0]), 'a settled charge can be dropped');
  ok(/return paymentsForScout\(state\.ledger, c\.scoutId\) > 0;/.test(fn[0]),
    'a charge with money against it can be dropped');
  ok(/paymentsForScout\(state\.ledger, have\.scoutId\) === 0/.test(fn[0]),
    'a paid charge can be silently re-priced');
});

test('paid-direct lines raise no charges at all', () => {
  const fn = /function lineRaisesCharges\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineRaisesCharges() not found');
  ok(/lineThroughPack\(l\)/.test(fn[0]), 'a council camp is billing families through the pack');
  ok(/lineFamilyFunded\(l\)/.test(fn[0]), 'a pack-funded line is billing families');
});

test('Phase 3b backfill: every collected tick becomes a payment, not a lost balance', () => {
  // Losing these would tell every square family they owe again.
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState({
    version: 1, scouts: [{ id: 's1' }, { id: 's2' }],
    collected: { e2: { s1: true, s2: true }, 'act:a1': { s1: true } },
    budget: {
      programYear: 2025,
      activities: [{ id: 'a1', name: 'Camp', estCents: 4000, perScout: true, familyPays: true }],
      expenses: [{ id: 'e2', name: 'Dues', estCents: 8000, perScout: true, familyPays: true }]
    }
  });
  const pays = after.ledger.filter(e => e.direction === 'in' && e.scoutId);
  eq(pays.length, 3, 'one ledger payment per tick');
  eq(pays.reduce((t, e) => t + e.amountCents, 0), 8000 + 8000 + 4000, 'total collected');
  ok(pays.every(e => e.source === 'family'), 'backfilled money lost its source');
  eq(Object.keys(after.collected).length, 0, 'collected was not emptied — it would backfill twice');
});

test('Phase 3b backfill: runs once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const once = ctx.normalizeState({
    version: 1, scouts: [{ id: 's1' }],
    collected: { e2: { s1: true } },
    budget: { programYear: 2025, activities: [], expenses: [{ id: 'e2', name: 'Dues', estCents: 8000, perScout: true, familyPays: true }] }
  });
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  eq(twice.ledger.filter(e => e.direction === 'in').length, 1, 'the backfill ran again');
});

test('charges are reconciled on the one seam every mutation goes through', () => {
  const fn = /function commit\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'commit() not found');
  ok(/syncCharges\(\);/.test(fn[0]), 'charges are not reconciled on commit');
});

/* ---------------- report ---------------- */
if (fails.length) {
  console.error(`\n  ${fails.length} failing, ${pass} passing\n`);
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passing\n`);
