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
// Some invariants live in the stylesheet, not the script.
const SCRIPT_CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));

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
  const literals = [...SCRIPT.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).join('\0');
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
// packCoverage() reads who earned what through tierEarnedMap(), so both come out of the
// source together. Since 2026-08-02 a threshold is COMMISSION, not sales, so the rate math is
// sliced in rather than stubbed — the conversion IS the thing under test. The stubs are only
// the tier list, the roster and the totals (deadline-aware — `asOf` selects a snapshot).
//
// A test writes a scout's sales as `tot(storefrontSales, onlineSales)` and may set RATE and
// ONLINE_RATE; RATE defaults to 100% so a test that does not care about the conversion can
// keep writing thresholds in the same units as the sales.
function coverageSandbox(setup) {
  const ctx = vm.createContext({});
  vm.runInContext(
    `function tot(store, online) {
       var on = online || 0;
       return { sales: (store || 0) + on, onS: on, onD: 0, storeD: 0, wagonD: 0 };
     }
     ${setup}
     ${slice('tierEarnedMap')}
     ${slice('packCoverage')}
     ${slice('scoutCommissionOf')}
     ${slice('commissionRates')}
     ${slice('goalBaseOf')}
     ${slice('cashDonOf')}
     ${slice('cashScoutRate')}
     ${slice('cashCreditOn')}
     ${slice('cashScoutCredit')}
     var SALES_AT = typeof SALES_AT === 'undefined' ? {} : SALES_AT;
     var state = {
       commissionPct: typeof RATE === 'undefined' ? '100' : RATE,
       commissionPctOnline: typeof ONLINE_RATE === 'undefined' ? '' : ONLINE_RATE,
       cashScoutPct: typeof CASH_RATE === 'undefined' ? '' : CASH_RATE,
       cashThroughTrailsEnd: typeof CASH_VIA_TE === 'undefined' ? false : CASH_VIA_TE
     };
     function sortedTiers() { return TIERS; }
     function arrOf(v) { return Array.isArray(v) ? v : []; }
     function computeScoutTotals(asOf) { return asOf ? SALES_AT[asOf] : SALES; }
     function activeScouts() { return Object.keys(SALES).map(function (id) { return { id: id }; }); }
     var EARNED = tierEarnedMap();
     var RESULT = packCoverage();`, ctx);
  return ctx;
}

test('coverage stacks up the tiers a scout has reached', () => {
  // A top seller must never end up with less than a lower seller, so a scout at tier 3
  // gets everything tiers 1-3 cover — not just tier 3's own list.
  const ctx = coverageSandbox(`
     var TIERS = [
       { id:'t1', thresholdCents: 30000, covers:['x1'] },
       { id:'t2', thresholdCents: 45000, covers:['act:a3'] },
       { id:'t3', thresholdCents: 90000, covers:[] }
     ];
     var SALES = { top: tot(50000), mid: tot(35000), low: tot(1000) };`);
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
  // `planCovered` is the 2026-07-27 planning assumption: earned it, or the pack has decided
  // to plan on covering it. Either way the family is not billed and the pack absorbs it.
  ok(/if \(cov\[s\.id\] \|\| planCovered\) \{ feesAbsorbed \+= each; return; \}/.test(fn[0]),
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
const NORMALIZE_FNS = ['PROGRAM_MONTHS', 'PROGRAM_TURN', 'PROGRAM_START_MONTH',
  'defaultProgramYear', 'freshBudget', 'programYearStartISO',
  // DENS: the event coercion rebuilds `dens` in rank order against it.
  'DENS',
  'programYearEndISO', 'EVENT_KINDS', 'freshEvent', 'ADV_RENAMES', 'dateToSlot',
  'ATT_MAX_HEADS', 'attHeads', 'freshAttendance', 'attEmpty', 'attTotals',
  'centsOf', 'freshLine', 'LINE_BASES', 'LINE_FUNDERS',
  'LINE_CATEGORIES', 'LINE_CATEGORY_KEYS', 'CHARGE_WHO',
  'linePerHead', 'linePlannedHeads', 'linePlannedCents',
  'LEDGER_METHODS', 'LEDGER_SOURCES', 'LEDGER_SOURCE_LABELS',
  'freshBook', 'TE_LINEUP', 'freshInventory', 'JOBS', 'arrOf', 'jobsFromRoleText',
  // Camping — normalizeState seeds the two council trips when the key is absent.
  'CAMP_SAFETY', 'CAMP_AGES', 'CAMP_WHY_COUNCIL', 'CAMP_FIRST_TIME',
  'freshTripSection', 'freshTrip', 'seedCampingTrips', 'freshCamping',
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
  ok(/var spent = lineActualCents\(state\.ledger, a\.id\);/.test(fn[0]), 'activity actual is not ledger-derived');
  ok(/var spentE = lineActualCents\(state\.ledger, e\.id\);/.test(fn[0]), 'expense actual is not ledger-derived');
  // A paid-direct line is out of the PLAN but its ledger entries are still money that left the
  // pack — a tier reimbursing a council fee posts exactly that, and dropping it would overstate
  // the balance by whatever was paid back.
  ok(/if \(!lineThroughPack\(a\)\) \{ familyDirect \+= linePlanned\(a\); actActual \+= spent; return; \}/.test(fn[0]),
    'money really paid out on a paid-direct line never reaches actual');
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
  eq(after.events.find(e => e.name === 'Fall campout').slot, 3, 'October is slot 3 in a July-start year');
  // The fixture's slots are pre-July-rebase, so the undated one is remapped: old 5 (February
  // under a September start) becomes new 7 (February under a July one). Same month either way.
  eq(after.events.find(e => e.name === 'Blue & Gold').slot, 7, 'undated keeps its planning MONTH');
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
  // linePerHead: both per-head kinds price off the roster, and the planning math asks it.
  'linePerHead', 'linePlannedHeads', 'linePlannedCents'];

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
  eq(dues.includeLeaders, false, 'the pack is not signed up to pay for leaders by default');
  eq(dues.leaderRateCents, 0, 'no leader rate is invented');
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

test('a family rate never reaches the pack’s plan', () => {
  // OWNER RULING 2026-07-27: the pack covers scouts and registered leaders, nobody else.
  // Parents and siblings pay their own way, so an adult or sibling rate is a BILLING rate —
  // it must not add a cent to what the pack plans to spend. This replaces the old
  // adultsPerScout assumption, which invented one parent per scout and charged the pack for
  // every one of them.
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const bg = freshLine({ basis: 'per-head', scoutRateCents: 1500, adultRateCents: 1500, siblingRateCents: 800 });
  eq(linePlannedHeads(bg, 10, 4), { scouts: 10, leaders: 0 }, 'planned heads');
  eq(linePlannedCents(bg, 10, 4), 15000, 'ten scouts at $15 — the parents are not the pack’s to plan');
});

test('the pack plans for leaders only when it is paying for them', () => {
  // Registration is genuinely two prices, which is why leaders carry their own rate rather
  // than sharing the scout's.
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const camp = freshLine({ basis: 'per-head', scoutRateCents: 2000 });
  eq(linePlannedCents(camp, 10, 4), 20000, 'unticked: scouts only');
  camp.includeLeaders = true; camp.leaderRateCents = 2000;
  eq(linePlannedHeads(camp, 10, 4), { scouts: 10, leaders: 4 }, 'planned heads');
  eq(linePlannedCents(camp, 10, 4), 28000, 'ticked: 10 scouts + 4 leaders at $20');
  const reg = freshLine({ basis: 'per-head', scoutRateCents: 8500, includeLeaders: true, leaderRateCents: 6500 });
  eq(linePlannedCents(reg, 10, 4), 111000, '$85 a scout and $65 a leader');
  // A leader count of zero is not a reason to plan nothing for the scouts.
  eq(linePlannedCents(reg, 10, 0), 85000, 'no leaders on the roster yet');
});

test('Phase 3a: a flat line ignores the roster entirely', () => {
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const charter = freshLine({ basis: 'flat', flatCents: 10000, scoutRateCents: 999 });
  eq(linePlannedCents(charter, 50), 10000, 'a charter fee is a charter fee');
  eq(linePlannedHeads(charter, 50, 9), { scouts: 0, leaders: 0 }, 'no heads are counted');
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

test('a tier waives a head other than the scout only where it NAMES that share', () => {
  // The rule was "a scout's fundraising buys the scout's seat, not the family's", enforced by
  // refusing to waive any charge but the scout's. Pack 569 wants a higher tier that buys an
  // ADULT pack shirt, so the refusal is now a DEFAULT rather than a prohibition: a bare cover
  // key is the scout share, and an adult share has to be named on a specific tier — where it
  // costs the plan real money (fundingSummary adds it to A).
  const fn = /function applyTierWaivers\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'applyTierWaivers() not found');
  ok(!/if \(c\.who !== 'scout'\) \{ c\.waivedBy = ''; return; \}/.test(fn[0]),
    'the blanket refusal is back, so a named adult share can never be honoured');
  ok(/var hit = \(covered\[coverKeyOf\(key, c\.who\)\] \|\| \{\}\)\[c\.scoutId\];/.test(fn[0]),
    'the waiver does not look up the charge’s own head kind');
  ok(/c\.waivedBy = et \? et\.id/.test(fn[0]),
    'the waiver does not record WHICH tier bought it — total waived stops being measurable');
  // And the default really is scout-only: a bare key must not resolve to an adult share.
  const { coverKeyOf, coverKeyParts } = sandbox(['COVER_WHO', 'coverKeyOf', 'coverKeyParts']);
  eq(coverKeyOf('L1', 'scout'), 'L1', 'the scout share must stay a bare key — nothing migrates');
  eq(coverKeyOf('L1', ''), 'L1', 'an unspecified head kind is the scout');
  eq(coverKeyOf('L1', 'adult'), 'L1#adult', 'an adult share needs its own key');
  eq(coverKeyParts('L1'), { key: 'L1', who: 'scout' }, 'an existing tier means the scout share');
  eq(coverKeyParts('act:A1#adult'), { key: 'act:A1', who: 'adult' }, 'an activity key survives the split');
  eq(coverKeyParts('L1#nonsense'), { key: 'L1', who: 'scout' }, 'an unknown head kind falls back to the scout');
});

test('a covered adult share is priced at the ADULT rate, and is new pack spending', () => {
  // One line, two prices, two rewards: the lower tier buys the scout's shirt, the higher one an
  // adult's. The scout share is already inside the line's planned cost, so covering it only
  // moves money out of expected fees; the adult rate is never planned, so covering THAT has to
  // add to A or the cost lands nowhere.
  const { lineRateForWho } = sandbox(['lineRateForWho']);
  const shirt = { scoutRateCents: 1200, adultRateCents: 1500, siblingRateCents: 800 };
  eq(lineRateForWho(shirt, 'scout'), 1200, 'scout rate');
  eq(lineRateForWho(shirt, 'adult'), 1500, 'adult rate');
  eq(lineRateForWho(shirt, 'sibling'), 800, 'sibling rate');
  eq(lineRateForWho(shirt, undefined), 1200, 'no head kind means the scout');
  const cost = /function coverCostForKeys\(keys\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(cost, 'coverCostForKeys() not found');
  ok(/if \(who === 'scout' && !reimb\) fees \+= cents; else extra \+= cents;/.test(cost[0]),
    'the two kinds of covered money are not kept apart');
  ok(/lineRateForWho\(r\.line, who\) \* lineBillingRoster\(r\.line\)\.length/.test(cost[0]),
    'a share is not priced at its own rate across whoever the line actually bills');
  const fs2 = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var tierExtra = coverCostForKeys\(assumeCov\)\.extra;\s*\n\s*expenses \+= tierExtra;/.test(fs2[0]),
    'a covered adult share never reaches A, so the pack plans to buy shirts with no money for them');
  ok(/tierExtra: tierExtra,/.test(fs2[0]), 'the figure is not reported for the worksheet to show');
  // The Budget card must agree with the worksheet about it.
  const cb = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var tierExtra = tierExtraPackCostCents\(\);\s*\n\s*var planned = actPlanned \+ expPlanned \+ tierExtra;/.test(cb[0]),
    "the Budget card's Planned leaves out what the worksheet added to A");
  // Only the shares a tier actually names are offered, and a rate of zero is not one of them.
  const shares = /function coverableShares\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(shares && /if \(who !== 'scout' && \(family \|\| !rate\)\) return;/.test(shares[0]),
    'an unpriced adult share is offered as something a tier can cover, or a per-family fee is split');
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

/* ================================================================
   Money redesign — Phase 4: categories and the funding summary (2, 3.2).
   ================================================================ */

test('Phase 4: existing lines default to "other" rather than being guessed at', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Charter fee', estCents: 10000, perScout: false },
      { id: 'e2', name: 'Nonsense', category: 'not-a-category', basis: 'flat', flatCents: 1 }
    ] }
  });
  eq(d.budget.expenses[0].category, 'other', 'a name is not a category');
  eq(d.budget.expenses[1].category, 'other', 'an unknown category is not kept');
});

test('Phase 4: the 510-278 category list is adopted whole', () => {
  const { LINE_CATEGORY_KEYS } = sandbox(['LINE_CATEGORIES', 'LINE_CATEGORY_KEYS']);
  ['registration', 'charter', 'advancement', 'recognition', 'events', 'activities',
    'camp', 'materials', 'training', 'uniforms', 'reserve', 'other', 'income']
    .forEach(k => ok(LINE_CATEGORY_KEYS.indexOf(k) !== -1, `category "${k}" is missing`));
});

test('Phase 4: the goal derives from the plan, and the hand-typed one is gone', () => {
  // "That last figure is currently typed in by hand. After this it is derived from the
  // plan, which is the entire point of the 510-278 worksheet."
  ok(!/data-act="use-budget-goal"/.test(SCRIPT), 'the manual "use this as the goal" button survived');
  ok(!/act === 'use-budget-goal'/.test(SCRIPT), 'the manual goal-sync handler survived');
  const fn = /function packGoalCents\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'packGoalCents() not found');
  ok(/state\.goalIsDerived/.test(fn[0]), 'the goal does not honour the derived flag');
  ok(/fundingSummary\(\)\.salesGoal/.test(fn[0]), 'the derived goal does not come from the plan');
  const totals = /function computePackTotals\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/teGoal: teGoalNow/.test(totals[0]), 'computePackTotals still reports the raw stored goal');
});

test('Phase 4: a pack that already typed a goal keeps it', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const typed = ctx.normalizeState({ version: 1, scouts: [], goalCents: 500000, budget: { programYear: 2025, activities: [], expenses: [] } });
  eq(typed.goalIsDerived, false, 'a typed goal was silently replaced by a derived one');
  const fresh = ctx.normalizeState({ version: 1, scouts: [], budget: { programYear: 2025, activities: [], expenses: [] } });
  eq(fresh.goalIsDerived, true, 'a pack with no goal did not get the derived one');
});

test('Phase 4: the funding summary never depends on what has been sold', () => {
  // The goal feeds computePackTotals' teGoal, so if the summary read sales back it would be
  // circular — and the goal would move every time somebody recorded a storefront.
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'fundingSummary() not found');
  ok(!/computePackTotals/.test(fn[0]), 'fundingSummary reads sales totals — that is circular');
  ok(/Math\.max\(0, expenses - income\)/.test(fn[0]), 'C is not A - B, floored at zero');
});

test('Phase 4: paid-direct money is in neither A nor B', () => {
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/if \(!lineThroughPack\(l\)\) \{ familyDirect \+= planned; return; \}/.test(fn[0]),
    'council money is being counted as a pack expense or as pack income');
});

test('Phase 4: an income-category line adds to B instead of A', () => {
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/if \(l\.category === 'income'\) incomeLines \+= planned;\s*\n\s*else expenses \+= planned;/.test(fn[0]),
    'an income line is being budgeted as an expense');
});

test('Phase 4: a family-funded event counts as income before anyone has attended', () => {
  // Reading only charges would count a family-funded campout as pure cost until the day it
  // happens, inflating the popcorn goal by the whole of it — the pack would be told to
  // raise money it was never going to spend.
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'fundingSummary() not found');
  ok(/rows\.length \? chargeTotals\(rows, state\.ledger\)\.standing : lineFamilyPlanned\(l\)/.test(fn[0]),
    'a family-funded line with no charges yet contributes nothing to income');
  // ...and the fallback is what FAMILIES would be billed, not the whole planned cost: a leader's
  // place is in linePlanned and no family is ever billed for one.
  ok(/function lineFamilyPlanned\(l\) \{ return \(l\.scoutRateCents \|\| 0\) \* lineBillingRoster\(l\)\.length; \}/.test(SCRIPT),
    'expected family income is not the scout share');
});

test('Phase 4: the Budget card and the goal share one arithmetic', () => {
  // Repeating the A-B=C sum in computeBudget is how the card and the goal would drift.
  const fn = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var fund = fundingSummary\(\);/.test(fn[0]), 'computeBudget does not use fundingSummary');
  ok(/var teNeed = fund\.C;/.test(fn[0]), 'computeBudget recomputes the fundraising need');
  ok(/var salesGoal = fund\.salesGoal;/.test(fn[0]), 'computeBudget recomputes the sales goal');
});

/* ================================================================
   Audit regressions — four bugs that survived the phase work, all found by
   auditing rather than by the tests written alongside it.
   ================================================================ */

test('AUDIT: the year rollover clears charges', () => {
  // syncCharges deliberately KEEPS a settled charge, so without an explicit clear a waived
  // or forgiven row survives the rollover pointing at a line id that no longer exists — and
  // the new year opens reporting last year's forgiveness against a "Removed line".
  const fn = /function rolloverYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'rolloverYear() not found');
  ok(/state\.charges = \[\];/.test(fn[0]), "last year's charges are carried into the new year");
});

test('AUDIT: the rollover carries the 510-278 category', () => {
  // freshLine defaults category to 'other', so the whole grouping was silently reset every
  // year — and an 'income' line came back as an ordinary expense that bills families.
  const fn = /function rolloverYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'rolloverYear() not found');
  const carries = fn[0].match(/category: x\.category/g) || [];
  eq(carries.length, 2, 'both activities and expenses must carry their category');
});

test('AUDIT: deleting a budget line takes its charges with it, and Undo brings them back', () => {
  // Both halves of the budget now remove through ONE function, so the cascade is asserted
  // there — two copies of it is how they drifted apart in the first place.
  const fn = /function removeBudgetLine\(id\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'removeBudgetLine() not found');
  ok(/state\.charges = state\.charges\.filter\(function \(c\) \{ return c\.lineId !== id; \}\);/.test(fn[0]),
    "removing a line orphans its charges");
  ok(/chg\.forEach\(function \(c\) \{ state\.charges\.push\(c\); \}\);/.test(fn[0]),
    'Undo does not bring the charges back');
  ok(/arr\.splice\(Math\.min\(ix, arr\.length\), 0, gone\);/.test(fn[0]), 'Undo does not put the line back');
  // And both delete buttons route through the confirm rather than deleting on the tap.
  const ask = /if \(act\.indexOf\('del-activity:'\) === 0 \|\| act\.indexOf\('del-expense:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(ask, 'the two budget deletes no longer share one guarded handler');
  ok(/ui\.overlay = \{ kind: 'confirm-del-line', lineId: askId \};/.test(ask[0]),
    'a budget line can still be deleted on a single tap');
  ok(!/removeBudgetLine/.test(ask[0]), 'the ask handler deletes as well as asking');
  const go = /if \(act\.indexOf\('confirm-del-line:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(go && /removeBudgetLine\(daId\)/.test(go[0]) && /deleteWithUndo\(gone\.label, gone\.restore\)/.test(go[0]),
    'confirming does not remove the line, or drops the Undo');
});

test('the delete dialog says what goes and what stays', () => {
  // The point is not the extra tap, it is knowing what the tap costs. A treasurer deleting a
  // line needs to know charges go, the ledger does not, and the calendar entry survives.
  const fn = /if \(o\.kind === 'confirm-del-line'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'the confirm-del-line overlay was not found');
  ok(/budgetLineDeleteFacts\(dl\)/.test(fn[0]), 'the dialog does not read the real figures');
  ok(/This goes:/.test(fn[0]) && /This stays:/.test(fn[0]), 'the dialog does not separate the two');
  ok(/money that really moved stays in the book/.test(fn[0]), 'it does not say the ledger survives');
  ok(/only the money side is removed/.test(fn[0]), 'it does not say the calendar entry survives');
  ok(/f\.paidAgainst/.test(fn[0]), 'it does not warn when a family has already paid something');
  const facts = /function budgetLineDeleteFacts\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(facts && /paymentsForScout\(state\.ledger, c\.scoutId\) > 0/.test(facts[0]),
    'the paid-against warning is not computed from real payments');
});

test('a calendar activity with no budget line can be budgeted again', () => {
  // The way back from a deleted line. It existed on the calendar day-detail only, which is no
  // use to somebody looking at the Budget wondering where their activity went.
  const fn = /function unbudgetedActivities\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'unbudgetedActivities() not found');
  ok(/e\.kind === 'activity' && !lineForEvent\(e\.id\)/.test(fn[0]), 'it does not test for a missing line');
  const rb = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(rb, 'renderBudget() not found');
  ok(/var unb = unbudgetedActivities\(\);/.test(rb[0]), 'the Budget never lists them');
  ok(/data-act="budget-this-event"/.test(rb[0]), 'there is no way to add the line back from the Budget');
  // The re-add must reuse the event, not make a second one.
  const add = /if \(act === 'budget-this-event'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(add && /eventId: btEv\.id/.test(add[0]), 'budgeting an event again does not reuse its calendar entry');
  ok(add && /lineForEvent\(btEv\.id\)\) return;/.test(add[0]), 'it would add a second line to the same event');
});

test('AUDIT: removing a scout strips their charges but keeps the money that moved', () => {
  // A settled charge would otherwise sit in the totals against a family who is not on the
  // roster. Their ledger entries stay — that money really did move.
  ok(/state\.charges = state\.charges\.filter\(function \(c\) \{ return c\.scoutId !== id; \}\);/.test(SCRIPT),
    "a removed scout's charges survive them");
  ok(/state\.ledger\.forEach\(function \(e\) \{ if \(e\.scoutId === id\) e\.scoutId = ''; \}\);/.test(SCRIPT),
    "a removed scout's payments still point at a scout who no longer exists");
});

test('AUDIT: an income-category line is never billed to families', () => {
  // Filing dues under "Income" is a plausible mistake, and it counted the same money twice
  // in B — once as fees owed, once as a budgeted income line.
  const fn = /function lineRaisesCharges\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineRaisesCharges() not found');
  ok(/if \(l\.category === 'income'\) return false;/.test(fn[0]),
    'an income line still raises charges — B double-counts it');
});

test('AUDIT: the Budget card and the worksheet cannot disagree about family income', () => {
  const fn = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/feeIncomeExpected = fundingSummary\(\)\.fees;/.test(fn[0]),
    'computeBudget computes expected family income its own way');
});

test('Home answers "what is coming" in exactly one place', () => {
  // Home used to carry two: a bare date in the stat row with no clue what it belonged to,
  // and a proper card below. They never appeared together, so the stat was only ever visible
  // in the state where it said least.
  const fn = /function renderHome\(\) \{[\s\S]*?\n    h \+= packFlow\(\);/.exec(SCRIPT);
  ok(fn, 'renderHome() not found');
  eq((fn[0].match(/<span class="l">Next up<\/span>/g) || []).length, 0, 'the bare-date stat is back');
  eq((fn[0].match(/<h2 class="section display" style="margin-bottom:0">This week<\/h2>/g) || []).length, 1,
    'Home should carry exactly one week card');
});

test('the week card always renders, and degrades in three useful steps', () => {
  const fn = /\/\/ This week — Monday to Sunday[\s\S]*?\n    h \+= '<\/div>';/.exec(SCRIPT);
  ok(fn, 'the week card not found');
  ok(/Nothing on the calendar this week/.test(fn[0]), 'no empty state');
  ok(/Next: <strong>/.test(fn[0]), 'an empty week does not say what IS coming');
  ok(/no date yet/.test(fn[0]), 'an empty calendar does not mention activities awaiting dates');
  ok(/data-tab="program" data-section="calendar"/.test(fn[0]), 'the empty state offers no way to fix it');
  ok(/wk-past/.test(fn[0]), 'days already past this week are not marked as done');
});

test('the week runs Monday to Sunday, and a Sunday belongs to the week that started', () => {
  // Sunday is the classic off-by-one: getDay() calls it 0, but in a Monday-start week it is
  // day SIX, so the week began six days ago rather than tomorrow.
  const { weekBounds } = sandbox(['pad2', 'weekBounds']);
  eq(weekBounds('2026-07-26'), { start: '2026-07-20', end: '2026-07-26' }, 'a Sunday');
  eq(weekBounds('2026-07-20'), { start: '2026-07-20', end: '2026-07-26' }, 'the Monday of that week');
  eq(weekBounds('2026-07-23'), { start: '2026-07-20', end: '2026-07-26' }, 'a Thursday mid-week');
});

test('a week straddling a month or a year still resolves', () => {
  const { weekBounds } = sandbox(['pad2', 'weekBounds']);
  eq(weekBounds('2026-09-01'), { start: '2026-08-31', end: '2026-09-06' }, 'across a month end');
  eq(weekBounds('2027-01-01'), { start: '2026-12-28', end: '2027-01-03' }, 'across a year end');
  eq(weekBounds('2028-02-29'), { start: '2028-02-28', end: '2028-03-05' }, 'a leap day');
  eq(weekBounds(''), { start: '', end: '' }, 'garbage in');
  eq(weekBounds('not-a-date'), { start: '', end: '' }, 'more garbage in');
});

test('the week list is ordered the way the week happens', () => {
  const fn = /function datedThingsInRange\(from, to\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'datedThingsInRange() not found');
  ok(/a\.date\.localeCompare\(b\.date\) \|\|/.test(fn[0]), 'not sorted by day first');
  ok(/a\.time \|\| '99:99'/.test(fn[0]),
    'an untimed thing sorts before timed ones — it should fall to the end of its day');
  ok(/state\.storefronts/.test(fn[0]) && /state\.events/.test(fn[0]),
    'the week must include storefronts as well as events');
});


test('a month heading never claims a year the event is not in', () => {
  // slotYear() takes the year from budget.programYear alone, so an event dated outside the
  // program year would be filed under a heading two years off with nothing to say so. The
  // realistic way to hit it is planning September before closing out the year in August.
  const { dateInProgramYear } = sandbox(['programYearStartISO', 'programYearEndISO', 'dateInProgramYear']);
  eq(dateInProgramYear('2025-07-01', 2025), true, 'first day of the program year');
  eq(dateInProgramYear('2026-06-30', 2025), true, 'last day of the program year');
  eq(dateInProgramYear('2025-06-30', 2025), false, 'the day before it starts');
  eq(dateInProgramYear('2026-07-01', 2025), false, 'next July, planned before the rollover');
  eq(dateInProgramYear('', 2025), false, 'undated');
});

test('an out-of-year line is grouped by its REAL month, not filed into the grid', () => {
  const inSlot = /function activitiesInSlot\(slot\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(inSlot, 'activitiesInSlot() not found');
  ok(/if \(ev\.date && !dateInProgramYear\(ev\.date, state\.budget\.programYear\)\) return false;/.test(inSlot[0]),
    'the month grid still swallows dates from another year');
  const stray = /function outOfYearActivities\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(stray, 'outOfYearActivities() not found');
  ok(/!dateInProgramYear\(ev\.date, state\.budget\.programYear\)/.test(stray[0]), 'wrong predicate');
  // ...and it must be rendered under monthLabel of its own date, with an explanation.
  ok(/monthLabel\(mk\)/.test(SCRIPT), 'the stray group is not labelled from its own month');
  ok(/Outside the/.test(SCRIPT), 'the stray group does not say why it is separate');
});

test('an out-of-year line appears exactly once', () => {
  // It must leave the slot grid when it joins the stray group, or the same money shows twice.
  const inSlot = /function activitiesInSlot\(slot\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  const stray = /function outOfYearActivities\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  const loose = /function unscheduledActivities\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/return false;/.test(inSlot), 'activitiesInSlot does not exclude anything');
  ok(/ev && ev\.date/.test(stray), 'outOfYearActivities would catch undated lines too');
  ok(/lineSlot\(a\) === -1/.test(loose), 'unscheduledActivities would catch dated lines too');
});

test('the budget hides gone-by months, but never one that carries a line', () => {
  // A budget is a plan for what is ahead. By February, seven empty month headings with
  // "+ Add activity" under each are noise. A month with a line in it always shows.
  const fn = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(fn, 'renderBudget() not found');
  ok(/if \(!acts\.length && slotMonthKey\(slot\) < nowMk && !ui\.budgetShowPast\) \{ hiddenPast \+= 1; continue; \}/.test(fn[0]),
    'past months are not hidden, or a month with lines could be hidden');
  ok(/var nowMk = monthKey\(todayISO\(\)\)/.test(fn[0]), 'past is not measured against the current month');
});

test('nothing becomes unreachable — the hidden months can be shown again', () => {
  const fn = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(/data-act="budget-toggle-past"/.test(fn[0]), 'no way to reveal the hidden months');
  ok(/Hide earlier months/.test(fn[0]), 'the toggle does not reverse');
  ok(/act === 'budget-toggle-past'/.test(SCRIPT), 'the toggle has no handler');
});

test('the budget points past spending at the ledger, where it can be back-dated', () => {
  const fn = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(/back-date an entry/.test(fn[0]),
    'hiding past months without saying where already-spent money goes');
});

test('a ledger entry can be dated freely, forwards or back', () => {
  // The budget now hides gone-by months, so the ledger is the only route to recording
  // something that already happened. Nothing may constrain its date.
  const add = /if \(act === 'ledger-add'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(add, 'the ledger-add handler not found');
  ok(/if \(!dr\.date\)/.test(add[0]), 'a date is not required');
  ok(!/dr\.date >=|dr\.date <=|min="/.test(add[0]), 'the new-entry date is range-restricted');
  // Both the draft field and the per-entry field must be plain, unbounded date inputs.
  [/(<input type="date" data-ch="ledn-date"[^>]*>)/, /(<input type="date" data-ch="led-date"[^>]*>)/]
    .forEach(function (re) {
      const m = re.exec(SCRIPT);
      ok(m, 'a ledger date input is missing');
      ok(!/\bmin=|\bmax=/.test(m[1]), 'a ledger date input is bounded: ' + m[1]);
    });
});

/* ================================================================
   Season-over-season location comparison.
   ================================================================ */

const LOC_FNS = ['locationKey', 'arrOf', 'locationHistoryFrom'];

test('location names match across years despite case, spacing and punctuation', () => {
  // The join key is the name. A leader types "Kroger — Main St" one year and "kroger main
  // st." the next, and Trail's End spells its own sites differently again.
  const { locationKey } = sandbox(['locationKey']);
  const same = ['Kroger — Main St', 'kroger main st.', 'KROGER   MAIN ST', 'Kroger, Main St!'];
  const keys = new Set(same.map(locationKey));
  eq(keys.size, 1, 'these should all be one store: ' + [...keys].join(' | '));
  ok(locationKey('Kroger Main St') !== locationKey('Kroger Oak Ave'), 'two real stores collapsed into one');
  eq(locationKey('   '), '', 'whitespace is not a location');
  eq(locationKey(null), '', 'null is not a location');
});

test('a Trail’s End import and a close-out line up on the same store', () => {
  const { locationHistoryFrom } = sandbox(LOC_FNS);
  const h = locationHistoryFrom([
    { kind: 'trails-end', year: 2024, locations: [{ name: 'Kroger — Main St', tx: 40, cents: 124000 }] },
    { kind: 'season', year: 2025, fundraising: { locations: [{ name: 'kroger main st', salesCents: 140000, donCents: 18000 }] } }
  ], [{ name: 'Kroger Main St.', sales: 61000, don: 0 }], 2026);
  eq(h.years, [2024, 2025, 2026], 'years');
  eq(h.rows.length, 1, 'the same store came out as ' + h.rows.length + ' rows');
  eq(h.rows[0].by, { 2024: 124000, 2025: 158000, 2026: 61000 }, 'per-year money');
  eq(h.rows[0].name, 'Kroger Main St.', 'the newest spelling should be the one displayed');
});

test('each year is labelled with what its source actually knew', () => {
  // A close-out has sales AND cash; a Trail's End import has TE storefront sales only.
  // Reporting them as one number without saying which is how a pack concludes cash "fell".
  const { locationHistoryFrom } = sandbox(LOC_FNS);
  const h = locationHistoryFrom([
    { kind: 'trails-end', year: 2024, locations: [{ name: 'A', cents: 100 }] },
    { kind: 'season', year: 2025, fundraising: { locations: [{ name: 'A', salesCents: 100, donCents: 5 }] } }
  ], [{ name: 'A', sales: 10, don: 0 }], 2026);
  eq(h.sources, { 2024: 'trails-end', 2025: 'season', 2026: 'live' }, 'sources');
});

test('a close-out outranks a Trail’s End import for the same year', () => {
  // Both can exist for one year. The close-out knows more, so it names the year.
  const { locationHistoryFrom } = sandbox(LOC_FNS);
  const a = locationHistoryFrom([
    { kind: 'trails-end', year: 2025, locations: [{ name: 'A', cents: 100 }] },
    { kind: 'season', year: 2025, fundraising: { locations: [{ name: 'A', salesCents: 100, donCents: 5 }] } }
  ], [], 2026);
  eq(a.sources[2025], 'season', 'import order should not decide the label');
  const b = locationHistoryFrom([
    { kind: 'season', year: 2025, fundraising: { locations: [{ name: 'A', salesCents: 100, donCents: 5 }] } },
    { kind: 'trails-end', year: 2025, locations: [{ name: 'A', cents: 100 }] }
  ], [], 2026);
  eq(b.sources[2025], 'season', 'the other order gives a different answer');
});

test('the comparison survives junk archives without inventing a year', () => {
  const { locationHistoryFrom } = sandbox(LOC_FNS);
  const h = locationHistoryFrom([
    null,
    { kind: 'trails-end', year: null, locations: [{ name: 'A', cents: 100 }] },
    { kind: 'season', year: 2025, fundraising: null },
    { kind: 'season', year: 2025, fundraising: { locations: [{ name: '  ', salesCents: 900, donCents: 0 }] } }
  ], [], 2026);
  eq(h.years, [], 'a yearless or nameless row should contribute nothing');
  eq(h.rows.length, 0, 'rows');
});

test('the new-storefront list offers previous years, not just this one', () => {
  // Rollover clears storefronts, so before this the list was empty every September — the
  // one moment where picking last year's exact name matters most.
  const fn = /function knownLocationNames\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'knownLocationNames() not found');
  ok(/state\.storefronts/.test(fn[0]), 'this season is not offered');
  ok(/a\.kind === 'trails-end'/.test(fn[0]), "Trail's End imports are not offered");
  ok(/a\.kind === 'season'/.test(fn[0]), 'close-outs are not offered');
  ok(/id="locList">' \+ knownLocs/.test(SCRIPT), 'the datalist is not fed from knownLocationNames()');
  ok(!/state\.storefronts\.forEach\(function \(sf\) \{ locations\[sf\.name\.trim\(\)\] = 1; \}\);/.test(SCRIPT),
    'the old current-season-only list is still there');
});

test('a store skipped for a season is not "new" when it comes back', () => {
  // The change column compared the latest year to the year immediately before it, so a
  // store that ran in 2024, sat out 2025 and returned in 2026 was labelled new.
  const i = SCRIPT.indexOf('Compare to the most recent year this store ACTUALLY RAN');
  ok(i !== -1, 'the change column still compares only to last year');
  const blk = SCRIPT.slice(i, i + 1600);
  ok(/for \(var wi = hist\.years\.length - 2; wi >= 0; wi--\)/.test(blk),
    'it does not walk back to find the last year the store ran');
  ok(/first year/.test(blk), '"first year" should replace the misleading "new"');
  ok(/' vs ' \+ wasYear/.test(blk), 'a non-adjacent comparison does not say which year it is against');
});

test('a part-season is never compared to a full one without saying so', () => {
  // The live column is a season still running. Against a completed year it looks like a
  // collapse — the sort of number that is arithmetically right and reads as a lie.
  ok(/var latestIsLive = hist\.sources\[hist\.latest\] === 'live';/.test(SCRIPT),
    'the table does not know whether its latest column is still running');
  ok(/latestIsLive \? '<span class="muted"> so far<\/span>' : ''/.test(SCRIPT),
    'a change against a live season is not marked "so far"');
});

test('season-over-season reports money only, and says why', () => {
  // The units differ — a Trail's End import counts transactions, a close-out counts
  // storefront dates — so an average-per-event column would compare two different things.
  ok(SCRIPT.indexOf('Season over season') !== -1, 'the season-over-season card not found');
  ok(/hist\.years\.length > 1/.test(SCRIPT), 'the card shows with only one year of data');
  ok(/average per event across them would be comparing two different things/.test(SCRIPT),
    'the card does not explain why there is no per-event column');
  ok(/Where each year came from/.test(SCRIPT), 'the card does not name each year’s source');
  // And the model must not offer one either.
  const model = /function locationHistoryFrom\(archives, liveLocs, programYear\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(model && !/events|perEvent|avg/i.test(model[0].replace(/\/\/[^\n]*/g, '')),
    'locationHistoryFrom exposes an event count that could be averaged across mismatched units');
});

/* ================================================================
   Seeded registration — only what the app can work out for itself.
   ================================================================ */

const REG_FNS = ['centsOf', 'uid', 'freshLine', 'SA_FEES', 'SEED_EXPENSES',
  // linePerHead: both per-head kinds price off the roster, and the planning math asks it.
  'linePerHead', 'linePlannedHeads', 'linePlannedCents'];

test('the national fees live in one dated place, and the seed reads them', () => {
  const { SA_FEES } = sandbox(['SA_FEES']);
  eq(SA_FEES.youthCents, 8500, 'annual national youth registration');
  eq(SA_FEES.adultCents, 6500, 'annual national adult registration');
  eq(SA_FEES.unitCharterCents, 10000, 'unit charter fee');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(SA_FEES.verified), 'the figures carry no verification date');
  const seed = /var SEED_EXPENSES = \[[\s\S]*?\n  \];/.exec(SCRIPT);
  ok(seed && !/\b8500\b|\b6500\b|\b10000\b/.test(seed[0]),
    'a fee is restated in the seed instead of read from SA_FEES — they would drift');
});

test('youth registration follows the roster', () => {
  const { SEED_EXPENSES, freshLine, linePlannedCents } = sandbox(REG_FNS);
  const youth = freshLine(SEED_EXPENSES.filter(e => e.name === 'Youth registration')[0]);
  eq(linePlannedCents(youth, 10, 4), 85000, 'ten scouts');
  eq(linePlannedCents(youth, 14, 4), 119000, 'four more scouts join');
  eq(linePlannedCents(youth, 0, 4), 0, 'an empty roster costs nothing');
});

test('adult registration follows the LEADER roster', () => {
  // This is the whole reason it can be seeded: the count is a number the pack already
  // keeps, so the line moves on its own as leaders join and leave.
  const { SEED_EXPENSES, freshLine, linePlannedCents, linePlannedHeads } = sandbox(REG_FNS);
  const adult = freshLine(SEED_EXPENSES.filter(e => e.name === 'Adult leader registration')[0]);
  eq(adult.includeLeaders, true, 'the seeded line does not include leaders');
  eq(adult.leaderRateCents, 6500, 'the leader fee is on the LEADER rate, not the family-adult rate');
  eq(adult.adultRateCents, 0, 'a leader is not a family adult — that rate bills a parent');
  eq(linePlannedCents(adult, 10, 6), 39000, 'six registered leaders at $65');
  eq(linePlannedCents(adult, 10, 7), 45500, 'a seventh leader registers');
  eq(linePlannedCents(adult, 40, 6), 39000, 'the scout count must not affect it');
  eq(linePlannedHeads(adult, 10, 6).leaders, 6, 'head count');
  eq(linePlannedCents(adult, 10, 0), 0, 'no leaders recorded yet');
});

test('an ordinary event does not pay for the leader roster', () => {
  // The leader count must never leak into a line that did not ask for it.
  const { freshLine, linePlannedCents, linePlannedHeads } = sandbox(REG_FNS);
  const bg = freshLine({ basis: 'per-head', scoutRateCents: 1500, adultRateCents: 1500 });
  eq(bg.includeLeaders, false, 'the default changed');
  eq(linePlannedHeads(bg, 10, 99).leaders, 0, 'the leader roster leaked into an event');
  eq(linePlannedCents(bg, 10, 99), 15000, 'ten scouts at $15, and not one adult');
});

test('the charter fee is flat — one unit, not one per scout', () => {
  const { SEED_EXPENSES, freshLine, linePlannedCents } = sandbox(REG_FNS);
  const chart = freshLine(SEED_EXPENSES.filter(e => e.name === 'Unit charter fee')[0]);
  eq(chart.basis, 'flat', 'basis');
  eq(linePlannedCents(chart, 30, 9), 10000, 'a bigger pack does not owe more charter fee');
});

test('nothing is seeded that the app cannot work out', () => {
  // A council fee or an optional subscription seeded at $0 looks planned-for and
  // understates the plan, which sets the popcorn goal too LOW.
  const { SEED_EXPENSES } = sandbox(REG_FNS);
  eq(SEED_EXPENSES.length, 3, 'the seed should be exactly the three derivable costs');
  const names = SEED_EXPENSES.map(e => e.name).sort();
  eq(names, ['Adult leader registration', 'Unit charter fee', 'Youth registration'], 'seeded lines');
  const seed = /var SEED_EXPENSES = \[[\s\S]*?\n  \];/.exec(SCRIPT)[0];
  ok(!/council/i.test(seed), 'a council program fee is being guessed at');
  ok(!/Scout Life/i.test(seed), 'an optional subscription is being seeded');
  ok(!/joining/i.test(seed), 'the $25 joining fee abolished in 2024 is being seeded');
});

test('seeding registration is idempotent, and independent of the activity slate', () => {
  const fn = /function seedStandardYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'seedStandardYear() not found');
  ok(/existingExp\[t\.name\.toLowerCase\(\)\]/.test(fn[0]), 'seeding twice would duplicate the registration lines');
  ok(/if \(added \|\| addedExp\)/.test(fn[0]),
    'a pack that already has the activities would be told nothing was added');
});

test('every planning call passes the leader count', () => {
  // A missed one silently plans adult registration at zero.
  // Walk each call balancing parens, so a nested activeScouts() does not fool the check.
  const bad = [];
  const NEEDLE = 'linePlannedCents(';
  for (let i = SCRIPT.indexOf(NEEDLE); i !== -1; i = SCRIPT.indexOf(NEEDLE, i + 1)) {
    if (/[.\w]/.test(SCRIPT[i - 1] || '')) continue;            // skip the declaration
    let depth = 0, args = [''], j = i + NEEDLE.length;
    for (; j < SCRIPT.length; j++) {
      const ch = SCRIPT[j];
      if (ch === '(') depth++;
      else if (ch === ')') { if (!depth) break; depth--; }
      if (!depth && ch === ',') { args.push(''); continue; }
      args[args.length - 1] += ch;
    }
    // 3 args, or 4 once the family count is passed for a per-family line. Fewer means somebody
    // dropped the leader count, which silently plans adult registration at zero.
    if (args.length !== 3 && args.length !== 4) bad.push(NEEDLE + args.join(',') + ')');
  }
  eq(bad, [], 'these calls omit the leader count: ' + bad.join(' | '));
  ok(/return linePlannedCents\(l, roster\.length, activeLeaders\(\)\.length, familiesOf\(roster\)\.length\);/.test(SCRIPT),
    'the state-reading wrapper does not pass the line roster, the ACTIVE leaders and the family count');
});

test('a leader who has moved on stops costing the pack money', () => {
  // state.leaders is every leader ever added. Counting it would keep paying registration
  // for people who left — and the line is seeded, so nobody would think to check it.
  ok(/function activeLeaders\(\) \{ return state\.leaders\.filter\(function \(l\) \{ return !l\.archived; \}\); \}/.test(SCRIPT),
    'there is no active-leader helper');
  ok(/l\.archived = l\.archived === true;/.test(SCRIPT), 'leaders cannot be archived');
  // Every place that asks "how many leaders" must count the ACTIVE ones. (The raw list is
  // still fine as a loop bound, an "any data at all" check, or a splice index — this checks
  // the places where the number is a HEAD COUNT.)
  //
  // computeBudget and fundingSummary no longer hold a leader count of their own: both plan
  // through linePlanned(), which is pinned to activeLeaders() by the test above. That is the
  // point of the single wrapper — one place to get it right — so what they are checked for
  // here is that they never went back to counting heads themselves.
  ['function computeBudget', 'function fundingSummary'].forEach(function (fname) {
    const re = new RegExp(fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}');
    const fn = re.exec(SCRIPT);
    ok(fn, fname + '() not found');
    ok(!/state\.leaders\.length/.test(fn[0]), fname + ' counts archived leaders');
    ok(!/linePlannedCents\(/.test(fn[0]),
      fname + ' prices a line itself instead of going through linePlanned, so a den-limited '
      + 'event would be planned against the whole pack');
  });
  ['function lineOptionControls'].forEach(function (fname) {
    const re = new RegExp(fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}');
    const fn = re.exec(SCRIPT);
    ok(fn, fname + '() not found');
    ok(!/state\.leaders\.length/.test(fn[0]), fname + ' counts archived leaders');
    ok(/activeLeaders\(\)\.length/.test(fn[0]), fname + ' does not count active leaders');
  });
});

test('an archived leader is not nagged about, and can come back', () => {
  ok(/activeLeaders\(\)\.forEach\(function \(l\) \{\s*\n\s*leaderStatus\(l\)/.test(SCRIPT),
    'Home still chases training for leaders who have left');
  ok(/act === 'archive-leader' \|\| act === 'restore-leader'/.test(SCRIPT), 'archiving is one-way or missing');
  ok(/data-act="toggle-leaders-archived"/.test(SCRIPT), 'archived leaders cannot be seen again');
});

test('a toast wraps instead of running off both edges of a phone', () => {
  // It is centred and position:fixed, so nowrap never gave anything to scroll — a long
  // message simply ran past both edges and lost text at each end. Several toasts are the
  // only place the app says what it just did.
  const css = /\.toast \{[\s\S]*?\n  \}/.exec(SCRIPT_CSS || '');
  const rule = css ? css[0] : (/\.toast \{[\s\S]*?\n  \}/.exec(HTML) || [''])[0];
  ok(rule, '.toast rule not found');
  ok(!/white-space: nowrap/.test(rule), 'a long toast still runs off the screen');
  ok(/white-space: normal/.test(rule), 'the toast does not wrap');
  ok(/max-width:/.test(rule), 'the toast has no width ceiling, so it can still overflow');
});

/* ================================================================
   Stretch goal — an aim above the minimum the plan already needs.
   ================================================================ */

test('a stretch goal only counts when it is above the minimum', () => {
  // At or below what the plan needs it is a typo, not an ambition — and showing it would
  // make the pack look further along than it is.
  const { stretchGoalOf } = sandbox(['stretchGoalOf']);
  eq(stretchGoalOf(800000, 607813), 800000, 'above the minimum');
  eq(stretchGoalOf(500000, 607813), 0, 'below the minimum is ignored');
  eq(stretchGoalOf(607813, 607813), 0, 'equal to the minimum is not a stretch');
  eq(stretchGoalOf(0, 607813), 0, 'unset');
  eq(stretchGoalOf(100, 0), 100, 'any stretch counts when no minimum is derived yet');
});

test('the stretch is reported apart from the minimum, never merged', () => {
  const fn = /function computePackTotals\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'computePackTotals() not found');
  ok(/stretchGoalOf\(state\.stretchGoalCents \|\| 0, teGoalNow\)/.test(fn[0]),
    'the stretch is not validated against the minimum');
  ok(/stretch: stretchNow/.test(fn[0]), 'the stretch is not reported');
  ok(/teGoal: teGoalNow/.test(fn[0]), 'the minimum stopped being the goal everything else uses');
});

test('the two goals get separate bars, on their own scales', () => {
  // Two scales on one bar is how "we are at 100%" and "we are at 76%" end up looking the same.
  // Anchor on the stretch bar itself — the "Trail's End goal" eyebrow appears in more than
  // one screen, and the first match was a different block entirely.
  const i = SCRIPT.indexOf('aria-label="Stretch goal ');
  ok(i !== -1, 'the stretch progress bar not found');
  const blk = SCRIPT.slice(Math.max(0, i - 1400), i + 900);
  ok(/pack\.teEligible \/ pack\.teGoal/.test(blk), 'the minimum bar is not measured against the minimum');
  ok(/pack\.teEligible \/ pack\.stretch/.test(blk), 'the stretch bar is not measured against the stretch');
  ok(/beyond what the budget needs/.test(blk), 'the stretch does not say how far past the plan it reaches');
  ok(/of <span class="money">' \+ fmt\(pack\.teGoal\) \+ '<\/span> needed/.test(blk),
    'the minimum bar does not say the figure is what is NEEDED');
});

test('the stretch goal stays with the leaders', () => {
  // Chosen scope: it must not reach the published parent document or the family digest.
  const pv = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(pv, 'buildParentView() not found');
  ok(!/stretch/i.test(pv[0]), 'the stretch goal leaked into the parent view');
  const dg = /function monthlyDigest\(mk\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(dg, 'monthlyDigest() not found');
  ok(!/stretch/i.test(dg[0]), 'the stretch goal leaked into the family digest');
});

test('Season setup says what the Trail’s End goal actually is', () => {
  // The question it kept raising: is this commission, or what we ring up?
  ok(/is <strong>what the pack sells<\/strong>, not what it keeps/.test(SCRIPT),
    'nothing explains that the goal is gross sales rather than commission');
  ok(/It is the <strong>minimum<\/strong>/.test(SCRIPT), 'nothing says the derived goal has no margin in it');
  ok(/stretch goal is below the minimum, so it’s ignored/.test(SCRIPT),
    'a stretch below the minimum is silently dropped with no explanation');
});

test('re-seeding never plans the same activity twice', () => {
  // del-event keeps the budget line when its event goes (the ledger posts against it), so
  // matching only event names let a re-seed re-create a name that was still budgeted for.
  const fn = /function seedStandardYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'seedStandardYear() not found');
  ok(/state\.events\.forEach\(function \(e\) \{ if \(e\.kind === 'activity'\) existing\[/.test(fn[0]),
    'event names are not checked');
  ok(/state\.budget\.activities\.forEach\(function \(a\) \{ existing\[/.test(fn[0]),
    'a budget line whose event was deleted would be seeded again — the same money twice');
});

/* ================================================================
   The program year starts in JULY, not September.
   ================================================================ */

const YEAR_FNS = ['PROGRAM_MONTHS', 'PROGRAM_TURN', 'PROGRAM_START_MONTH', 'pad2',
  'defaultProgramYear', 'programYearStartISO', 'programYearEndISO', 'dateToSlot',
  'slotMonthNumber'];

test('the twelve slots run July to June', () => {
  const { PROGRAM_MONTHS, slotMonthNumber } = sandbox(YEAR_FNS);
  eq(PROGRAM_MONTHS[0], 'July', 'slot 0');
  eq(PROGRAM_MONTHS[11], 'June', 'slot 11');
  eq(PROGRAM_MONTHS.length, 12, 'still twelve months');
  eq(PROGRAM_MONTHS.slice().sort().length, 12, 'no month repeated or dropped');
  // Slot → calendar month, across the turn of the calendar year.
  eq([0, 5, 6, 11].map(slotMonthNumber), [7, 12, 1, 6], 'Jul, Dec, Jan, Jun');
});

test('a date maps to its slot, and back, for every month', () => {
  const { dateToSlot, slotMonthNumber } = sandbox(YEAR_FNS);
  for (let m = 1; m <= 12; m++) {
    const iso = '2025-' + String(m).padStart(2, '0') + '-15';
    const slot = dateToSlot(iso);
    ok(slot >= 0 && slot <= 11, 'month ' + m + ' gave slot ' + slot);
    eq(slotMonthNumber(slot), m, 'month ' + m + ' did not round-trip');
  }
  eq(dateToSlot('2025-07-01'), 0, 'July is the first slot');
  eq(dateToSlot('2026-06-30'), 11, 'June is the last');
});

test('the program year window is July 1 to June 30', () => {
  const { programYearStartISO, programYearEndISO } = sandbox(YEAR_FNS);
  eq(programYearStartISO(2026), '2026-07-01', 'start');
  eq(programYearEndISO(2026), '2027-06-30', 'end');
});

test('the default program year turns over in July, not September', () => {
  // A pack opening the app in July is planning the year that starts NOW, not the one that
  // started eleven months ago.
  const ctx = sandbox(YEAR_FNS);
  const realDate = Date;
  function at(y, mZeroBased, d) {
    ctx.Date = class extends realDate {
      constructor() { super(); return new realDate(y, mZeroBased, d); }
    };
    const got = ctx.defaultProgramYear();
    ctx.Date = realDate;
    return got;
  }
  eq(at(2026, 6, 15), 2026, 'mid-July starts the new program year');
  eq(at(2026, 5, 30), 2025, 'the end of June is still the old one');
  eq(at(2026, 11, 1), 2026, 'December sits in the year that began in July');
  eq(at(2027, 0, 5), 2026, 'January belongs to the year before it');
});

test('an existing pack’s stored slots are rebased once, keeping their month', () => {
  // Slot 0 used to mean September and now means July, so every stored slot is two months
  // out. Rebasing twice would shift by four and nothing would look obviously wrong.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = {
    version: 1, scouts: [],
    // Pre-rebase: 0=Sep, 3=Dec, 4=Jan, 11=Aug. No slotsRebased flag.
    events: [
      { id: 'a', kind: 'activity', name: 'Sep', date: '', slot: 0 },
      { id: 'b', kind: 'activity', name: 'Dec', date: '', slot: 3 },
      { id: 'c', kind: 'activity', name: 'Jan', date: '', slot: 4 },
      { id: 'e', kind: 'activity', name: 'Aug', date: '', slot: 11 }
    ],
    budget: { programYear: 2025, activities: [], expenses: [] }
  };
  const once = ctx.normalizeState(JSON.parse(JSON.stringify(d)));
  const slots = {};
  once.events.forEach(e => { slots[e.name] = e.slot; });
  eq(slots, { Sep: 2, Dec: 5, Jan: 6, Aug: 1 }, 'every slot should keep its calendar month');
  eq(once.budget.slotsRebased, true, 'the rebase is not marked done');
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  const again = {};
  twice.events.forEach(e => { again[e.name] = e.slot; });
  eq(again, slots, 'the rebase ran a second time and shifted everything again');
});

test('a dated event ignores the rebase — its date already decides', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const after = ctx.normalizeState({
    version: 1, scouts: [],
    events: [{ id: 'a', kind: 'activity', name: 'Campout', date: '2025-10-18', slot: 0 }],
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(after.events[0].slot, 3, 'October is slot 3, whatever was stored');
});

test('a brand new pack is born July-based and never rebases', () => {
  const { freshBudget } = sandbox(['PROGRAM_START_MONTH', 'defaultProgramYear', 'freshBudget']);
  eq(freshBudget().slotsRebased, true, 'a fresh budget would be rebased on first load');
});

test('the seeded slate keeps every activity in the month it was always in', () => {
  const { SEED_ACTIVITIES, PROGRAM_MONTHS } = sandbox(['PROGRAM_MONTHS', 'PROGRAM_TURN',
    'PROGRAM_START_MONTH', 'SA_FEES', 'SEED_EXPENSES', 'SEED_ACTIVITIES']);
  const month = n => PROGRAM_MONTHS[SEED_ACTIVITIES.filter(a => a.name.indexOf(n) === 0)[0].slot];
  eq(month('School Night'), 'September', 'School Night');
  eq(month('Popcorn kickoff'), 'September', 'Popcorn kickoff');
  eq(month('Fall family campout'), 'October', 'campout');
  eq(month('Holiday pack party'), 'December', 'holiday party');
  eq(month('Pinewood Derby'), 'January', 'derby');
  eq(month('Blue & Gold'), 'February', 'Blue & Gold');
  eq(month('Crossover'), 'May', 'crossover');
  eq(month('Day camp'), 'June', 'day camp');
  // The one deliberate move: a straight remap would have put resident camp in July, the
  // very month a pack is doing this planning.
  eq(month('Resident camp'), 'June', 'resident camp should sit at the END of the year');
  SEED_ACTIVITIES.forEach(a => ok(a.slot >= 0 && a.slot <= 11, a.name + ' has slot ' + a.slot));
});

test('the program-year constants are declared before load() reads them', () => {
  // This is the one the sliced-eval sandbox cannot catch, because it evaluates declarations
  // in whatever order the test lists them. In the real file `var` hoists the NAME but not
  // the VALUE, and both defaultProgramYear and dateToSlot run inside load() → normalizeState
  // while the page is initialising. Declared too far down, they were undefined at that
  // moment: dateToSlot returned NaN for every dated event (stored as null) and
  // defaultProgramYear quietly answered a year early.
  const at = (needle) => SCRIPT.indexOf(needle);
  const load = at('  var state = load();');
  ok(load !== -1, 'the load() call not found');
  ['var PROGRAM_MONTHS', 'var PROGRAM_TURN', 'var PROGRAM_START_MONTH'].forEach(function (decl) {
    const i = at('  ' + decl);
    ok(i !== -1, decl + ' not found');
    ok(i < load, decl + ' is declared after load() runs — it will be undefined during normalizeState');
  });
});

test('a budget row leads with the name and the money, not the settings', () => {
  // Every row used to lay eight controls of equal weight across two wrapped lines, so a
  // month of activities read as a wall of repeated "Flat cost / Other / Pack pays".
  const fn = /function budgetLineRow\(l, scoutN, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'budgetLineRow() not found');
  // The primary line runs from brow-main to the line that closes it. `money` is built just
  // above and dropped in, so check the variable lands there and that it carries bmoney.
  const main = /brow-main[\s\S]*?\n      '<\/div>'/.exec(fn[0]);
  ok(main, 'the row has no primary line');
  ok(/class="bname"/.test(main[0]), 'the name is not on the primary line');
  ok(/\n\s*money \+/.test(main[0]), 'the money is not on the primary line');
  ok(/class="bmoney"|bmoney money/.test(fn[0]), 'nothing is marked up as the row money');
  ok(!/line-category|line-funded|line-basis/.test(main[0]),
    'a settings drop-down is back on the primary line');
});

test('the settings are still reachable, one tap away', () => {
  // Quieter must not mean gone.
  const fn = /function budgetLineRow\(l, scoutN, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/data-act="line-options"/.test(fn[0]), 'no disclosure for the settings');
  ok(/open \? lineOptionControls/.test(fn[0]), 'the settings never render');
  const opt = /function lineOptionControls\(l, scoutN, collectKey\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(opt, 'lineOptionControls() not found');
  ['line-basis', 'line-category', 'line-funded', 'line-scout-rate', 'line-include-leaders',
    'line-leader-rate', 'line-adult-rate', 'line-sibling-rate', 'line-direct']
    .forEach(function (ch) { ok(opt[0].indexOf('data-ch="' + ch + '"') !== -1, ch + ' is no longer editable'); });
  ok(/act === 'line-options'/.test(SCRIPT), 'the disclosure has no handler');
});

test('activities and expenses share one row shape', () => {
  // They had two near-identical renderers that drifted apart.
  ok(!/function lineMoneyControls/.test(SCRIPT), 'the old split renderer is still here');
  const rb = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(rb, 'renderBudget() not found');
  ok(/budgetLineRow\(e, bud\.scouts/.test(rb[0]), 'expenses do not use the shared row');
  ok(/function activityLineRow\(a, scoutN\) \{[\s\S]*?budgetLineRow\(a, scoutN/.test(SCRIPT),
    'activities do not use the shared row');
});

test('the row does not repeat the month its group already states', () => {
  const fn = /function activityLineRow\(a, scoutN\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'activityLineRow() not found');
  ok(!/slotLabel\(ev\.slot\)/.test(fn[0]),
    'the row still prints "September 2026" under a heading that already says it');
  ok(/no date yet/.test(fn[0]), 'the row no longer says when there is no date');
});

/* ================================================================
   Den-limited events — Webelos Woods is not a bill for the Tigers
   ================================================================ */
// The helper run is a chain of one-line declarations, so slicing the first of them carries
// the rest through the end of eventRoster. That is how slice() works and it is what we want
// here: every helper in the group, evaluated together.
const dens = sandbox(['DENS', 'eventDens', 'denListLabel']);

test('an event is for the whole pack unless it says which dens', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  eq(ctx.freshEvent().dens, [], 'a new event carries an empty den list');
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    events: [{ id: 'ev1', kind: 'activity', name: 'Fall campout', date: '2025-10-04' }],
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(d.events[0].dens, [], 'an existing event must migrate to "the whole pack"');
});

test('only an activity can be limited to dens', () => {
  // A den meeting already names its den and a pack meeting is everyone, so a den list on
  // either could only contradict the kind.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    events: [
      { id: 'ev1', kind: 'den', den: 'Wolf', date: '2025-10-01', dens: ['Tiger'] },
      { id: 'ev2', kind: 'pack', date: '2025-10-02', dens: ['Lion', 'Tiger'] },
      { id: 'ev3', kind: 'activity', name: 'Webelos Woods', date: '2025-10-03', dens: ['Webelos'] }
    ],
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(d.events[0].dens, [], 'a den meeting kept a den list');
  eq(d.events[1].dens, [], 'a pack meeting kept a den list');
  eq(d.events[2].dens, ['Webelos'], 'an activity lost its den list');
});

test('a stored den list is rank-ordered, deduped, and free of junk', () => {
  // It is written from tick boxes in whatever order they were tapped, and it is read back
  // into printed labels — so one canonical shape, decided on the way in.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    events: [{ id: 'ev1', kind: 'activity', name: 'Woods', date: '2025-10-03',
      dens: ['Arrow of Light', 'Webelos', 'Webelos', 'Sixth Grade', 42] }],
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(d.events[0].dens, ['Webelos', 'Arrow of Light'], 'den list');
});

test('a den-limited event narrows the roster; everything else does not', () => {
  const roster = [
    { id: 's1', name: 'Ada', den: 'Tiger' },
    { id: 's2', name: 'Ben', den: 'Webelos' },
    { id: 's3', name: 'Cal', den: 'Arrow of Light' },
    { id: 's4', name: 'Dee', den: '' }
  ];
  eq(dens.scoutsInDens(roster, []).length, 4, 'no restriction means the whole pack');
  eq(dens.scoutsInDens(roster, ['Webelos', 'Arrow of Light']).map(s => s.id), ['s2', 's3'], 'Webelos Woods');
  eq(dens.scoutsInDens(roster, ['Tiger']).map(s => s.id), ['s1'], 'Tiger Mania');
  // A scout with no den is in NO den's event. The UI says so out loud, because the
  // alternative is a family that quietly never gets billed.
  eq(dens.scoutsInDens(roster, ['Tiger', 'Webelos', 'Arrow of Light']).map(s => s.id), ['s1', 's2', 's3'],
    'a scout with no den set must not be swept into a den event');
});

test('a den list reads as English wherever it is printed', () => {
  eq(dens.denListLabel([]), '', 'no restriction says nothing');
  eq(dens.denListLabel(['Tiger']), 'Tiger', 'one den');
  eq(dens.denListLabel(['Webelos', 'Arrow of Light']), 'Webelos and Arrow of Light', 'two dens');
  eq(dens.denListLabel(['Tiger', 'Wolf', 'Bear']), 'Tiger, Wolf and Bear', 'three dens');
});

test('the restriction lives on the event, and the budget line reads it', () => {
  // Two fields holding "who is this for" is how they drift — the same reason the date left
  // the budget line in Phase 2.
  ok(/function lineDens\(l\) \{ return eventDens\(eventForLine\(l\)\); \}/.test(SCRIPT),
    'the budget line does not read the den list from its event');
  // The line must not grow a copy. (state.leaders[].dens is a different thing entirely —
  // which dens a LEADER leads — so this looks at the line's own shape, not at `l.dens`.)
  const fresh = /function freshLine\(patch\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fresh, 'freshLine() not found');
  ok(!/dens/.test(fresh[0]), 'a budget line has grown a den list of its own');
  const mig = /function migrateLineShape\(l\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(mig, 'migrateLineShape() not found');
  ok(!/dens/.test(mig[0]), 'the line migration has started writing a den list');
});

test('a den-limited line bills only the dens it is for', () => {
  // Where the money actually narrows:
  //   * the plan            linePlanned → lineRoster        (pinned above)
  //   * expected fee income computeBudget → lineRoster      (what popcorn must cover)
  //   * raised charges      an EVENT line charges from attendance, and the attendance list
  //                         is narrowed by eventRoster — see the next test
  // syncCharges asks each line for its own roster too. For an event line that argument is
  // unused (charges come from attendance), and a line with no event is the whole roster by
  // definition — so today it can only ever equal activeScouts(). It is written this way so
  // that stays true by construction rather than by luck.
  const sc = /function syncCharges\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(sc, 'syncCharges() not found');
  // lineBillingRoster IS the line's own roster, narrowed again to one scout per family where the
  // fee is priced per family. Either way it is never the whole pack.
  ok(/chargeRowsFor\(r\.line, collapseMarkedToFamilies\(r\.line, marked\), lineBillingRoster\(r\.line\)\)/.test(sc[0]),
    'syncCharges raises roster charges against one pack-wide roster');
  ok(/function lineBillingRoster\(l\) \{[\s\S]*?if \(!linePerFamily\(l\)\) return roster;/.test(SCRIPT),
    'lineBillingRoster narrows a line that is not priced per family');
  ok(!/var roster = activeScouts\(\);/.test(sc[0]), 'syncCharges still holds one pack-wide roster');
  const cb = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/lineBillingRoster\(item\)\.forEach/.test(cb[0]),
    'expected family income is counted against somebody other than whoever the line bills');
});

test('attendance and RSVP show the dens invited, and never hide a recorded reply', () => {
  const fn = /function eventRoster\(ev, recorded\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'eventRoster() not found');
  ok(/if \(recorded && recorded\[s\.id\]\) return true;/.test(fn[0]),
    'narrowing an event afterwards would hide a reply that was already given');
  ok(/ev\.kind === 'den' && ev\.den \? \[ev\.den\] : eventDens\(ev\)/.test(fn[0]),
    'a den meeting and a den-limited activity do not share one narrowing rule');
  ok(/var roster = eventRoster\(m, marked\);/.test(SCRIPT), 'attendance does not use eventRoster');
  ok(/var roster = eventRoster\(rsvpEv, map\);/.test(SCRIPT), 'the RSVP list does not use eventRoster');
  ok(/var roster = eventRoster\(getEvent\(evKey\), map\);/.test(SCRIPT),
    'the RSVP summary counts "no reply" against scouts who were never asked');
});

test('the rollover carries which dens an event was for', () => {
  // Webelos Woods is a Webelos event every year: the restriction is by den, not by the
  // scouts who happened to be in it. Losing it would quietly re-bill the whole pack.
  const fn = /function rolloverYear\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'rolloverYear() not found');
  ok(/dens: ev \? eventDens\(ev\)\.slice\(\) : \[\]/.test(fn[0]), 'the den list is not captured');
  ok(/freshEvent\(\{ kind: 'activity'[^)]*dens: c\.dens \}\)/.test(fn[0]), 'the den list is not carried');
});

test('parents are told an activity is not their den, and nothing more', () => {
  const fn = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'buildParentView() not found');
  ok(/detail: aDens \? aDens \+ ' only' : ''/.test(fn[0]),
    'the published activity does not say which dens it is for');
  ok(!/dens: /.test(fn[0]), 'the published shape grew a field instead of using the detail line');
});

/* ---------------- Families pay the council: three arrangements, one question ---------- */

test('the funding question offers all three arrangements', () => {
  // fundedBy + paidDirectTo stay two independent fields (DESIGN-money.md 3.2) — as CONTROLS
  // they made the commonest case in this pack reachable only by picking "Families pay" and
  // then noticing a text box appear underneath. Nobody found it.
  const fn = /function lineOptionControls\(l, scoutN, collectKey\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineOptionControls() not found');
  ['>Pack pays<', '>Families pay the pack<'].forEach((opt) => {
    ok(fn[0].includes(opt), 'the paid-by control is missing ' + opt);
  });
  ok(/value="direct"/.test(fn[0]), 'there is no way to say families pay somebody directly');
  // The third option names whoever is actually paid — a fixed "Council" label hid the vendor
  // case (a campground, the Scout Shop) from every pack that has one.
  ok(/>Families pay ' \+\s*\n?\s*esc\(l\.paidDirectTo \|\| 'the council or a vendor'\) \+ ' direct</.test(fn[0]),
    'the paid-directly option does not name the payee');
});

test("'direct' is a control, never a stored fundedBy value", () => {
  // A third fundedBy value reading 'council' was the wrong fix: it sounds like the council is
  // paying FOR the camp when the council is the one being paid.
  const { LINE_FUNDERS } = sandbox(['LINE_FUNDERS']);
  eq(LINE_FUNDERS, ['pack', 'families'], 'the stored funders');
  const { lineFundingMode } = sandbox(['lineFamilyFunded', 'lineFundingMode']);
  eq(lineFundingMode({ fundedBy: 'pack', paidDirectTo: '' }), 'pack', 'pack pays');
  eq(lineFundingMode({ fundedBy: 'families', paidDirectTo: '' }), 'families', 'families pay the pack');
  eq(lineFundingMode({ fundedBy: 'families', paidDirectTo: 'Council' }), 'direct', 'families pay the council');
  // The combination the model refuses to store must not be reachable from the control either.
  eq(lineFundingMode({ fundedBy: 'pack', paidDirectTo: 'Council' }), 'pack', 'pack-funded is pack-funded');
});

test('choosing "families pay Council direct" fills the payee in, and clearing it undoes it', () => {
  const fn = /if \(bk === 'name'\) \{[\s\S]*?\} else if \(bk === 'direct'\)/.exec(SCRIPT);
  ok(fn, 'the budget-line change handler was not found');
  ok(/if \(el\.value === 'direct'\) \{\s*\n\s*bl\.fundedBy = 'families';\s*\n\s*if \(!bl\.paidDirectTo\) bl\.paidDirectTo = 'Council';/.test(fn[0]),
    'picking the third option leaves the line with no payee, so it behaves as if the pack collects it');
  ok(/bl\.fundedBy = el\.value === 'families' \? 'families' : 'pack';\s*\n(\s*\/\/[^\n]*\n)*\s*bl\.paidDirectTo = '';/.test(fn[0]),
    'switching away from paid-direct leaves a stale payee behind');
});

/* ================================================================
   The pack covers scouts and leaders — owner ruling, 2026-07-27
   ================================================================ */

test('a per-leader fee migrates onto the leader rate, to the cent', () => {
  // adultsFrom:'leaders' meant "this adult rate is per REGISTERED LEADER" — the seeded adult
  // registration line. Moving it must not change a single planned figure.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Adult leader registration', basis: 'per-head', category: 'registration',
        scoutRateCents: 0, adultRateCents: 6500, adultsFrom: 'leaders', adultsPerScout: 1 }
    ] }
  });
  const reg = d.budget.expenses[0];
  eq(reg.includeLeaders, true, 'the leader box should be ticked');
  eq(reg.leaderRateCents, 6500, 'the fee moved to the leader rate');
  eq(reg.adultRateCents, 0, 'it must not also read as a family-adult billing rate');
  eq(ctx.linePlannedCents(reg, 10, 6), 39000, 'six leaders at $65 — unchanged by the migration');
});

test('an assumed parent stops being planned, but is still billable', () => {
  // adultsFrom:'assumption' × adultsPerScout invented one parent per scout and charged the
  // PACK for every one. The rate survives as what a FAMILY owes; the plan drops it. Planned
  // figures on these lines fall on upgrade, and that is the correction being asked for.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Blue & Gold', basis: 'per-head', category: 'events', fundedBy: 'families',
        scoutRateCents: 1500, adultRateCents: 1500, siblingRateCents: 800,
        adultsFrom: 'assumption', adultsPerScout: 1 }
    ] }
  });
  const bg = d.budget.expenses[0];
  eq(bg.includeLeaders, false, 'a family rate must not become a leader rate');
  eq(bg.leaderRateCents, 0, 'no leader rate is invented');
  eq(bg.adultRateCents, 1500, 'the family-adult rate survives — families still owe it');
  eq(bg.siblingRateCents, 800, 'the sibling rate survives');
  eq(ctx.linePlannedCents(bg, 10, 4), 15000, 'ten scouts at $15 and nobody else');
});

test('the old head-count fields are gone, and the migration runs once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const once = ctx.normalizeState({
    version: 1, scouts: [],
    budget: { programYear: 2025, activities: [], expenses: [
      { id: 'e1', name: 'Camp', basis: 'per-head', scoutRateCents: 4000,
        adultRateCents: 4000, adultsFrom: 'leaders', adultsPerScout: 2 }
    ] }
  });
  const l1 = once.budget.expenses[0];
  ok(!('adultsFrom' in l1) && !('adultsPerScout' in l1), 'an old head-count field survived');
  const twice = ctx.normalizeState(JSON.parse(JSON.stringify(once)));
  const l2 = twice.budget.expenses[0];
  eq([l2.includeLeaders, l2.leaderRateCents, l2.adultRateCents], [true, 4000, 0],
    'running the migration twice moved the rate again');
});

test('family heads are charged from who came, never from the plan', () => {
  // The other half of the ruling: taking parents out of the PLAN must not take them out of
  // the BILL. §3.4's worked example — scout, both parents, one sibling — is unchanged.
  const { chargeRowsFor } = sandbox(['chargeRowsFor']);
  const line = { id: 'L1', eventId: 'E1', scoutRateCents: 1500, adultRateCents: 1500, siblingRateCents: 800 };
  const rows = chargeRowsFor(line, { s1: { scout: 1, adults: 2, siblings: 1 } }, []);
  eq(rows.length, 4, 'four heads, four charges');
  eq(rows.reduce((n, r) => n + r.amountCents, 0), 5300, '$15 + 2 × $15 + $8');
  eq(rows.filter(r => r.who === 'adult').length, 2, 'both parents');
});

test('ticking "include leaders" starts the leader rate at the scout rate', () => {
  // A campsite or a plate of food costs the same whoever it is for, so one tick should be
  // enough. Registration is the exception, and the field is right there.
  const fn = /if \(bk === 'name'\) \{[\s\S]*?\} else if \(bk === 'direct'\)/.exec(SCRIPT);
  ok(fn, 'the budget-line change handler was not found');
  ok(/bl\.includeLeaders = el\.checked;/.test(fn[0]), 'the checkbox does not set the flag');
  ok(/if \(bl\.includeLeaders && !bl\.leaderRateCents\) bl\.leaderRateCents = bl\.scoutRateCents \|\| 0;/.test(fn[0]),
    'ticking the box leaves the leader rate at zero, so it silently costs nothing');
});

test('the editor asks for a per-scout price, not a per-head guess', () => {
  const fn = /function lineOptionControls\(l, scoutN, collectKey\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineOptionControls() not found');
  ok(fn[0].includes('>per scout<'), 'the scout rate is not labelled per scout');
  ok(fn[0].includes('Include registered leaders'), 'there is no way to include leaders');
  ok(!/adults\/scout|an assumption/.test(fn[0]), 'the invented-parents assumption is still on screen');
  // The family rates are asked for on every line a family is billed for — whether the pack
  // collects it or the council does — but never on a per-family fee, which has no separate heads.
  const fam = /if \(\(mode === 'families' \|\| mode === 'direct'\) && !perFamily\) \{[\s\S]*?\n    \}/.exec(fn[0]);
  ok(fam, 'the family-heads group was not found, or is back to families-pay only');
  ok(/data-ch="line-adult-rate"/.test(fam[0]) && /data-ch="line-sibling-rate"/.test(fam[0]),
    'the family billing rates are outside that branch');
});

test('a scout’s name can be corrected', () => {
  // It was set once at add time and then fixed. A Trail's End import arrives with whatever
  // the parent typed into their own account, and a typo in a child's name is not something
  // anybody should have to live with.
  ok(/data-ch="scout-name"/.test(SCRIPT), 'there is no name field on the roster');
  ok(/if \(ch === 'scout-name'\) scEd\.name = el\.value\.trim\(\);/.test(SCRIPT),
    'the name field has no handler, or does not trim like a leader’s does');
  // Everything keys off the id, so a rename must not need to touch anything else.
  ok(!/scoutId === .*\.name|name === c\.scoutId/.test(SCRIPT), 'something is matching a scout by name');
});

/* ================================================================
   Reward tiers as a planning assumption — owner ask, 2026-07-27
   ================================================================ */

test('no tier is planned on until the pack names one', () => {
  // Planning on a tier is an optimistic claim about ten families. No pack record's goal may
  // move on its own because the app decided to be hopeful.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({ version: 1, scouts: [], budget: { programYear: 2025, activities: [], expenses: [] } });
  eq(d.rewardTiers.planOnTierId, '', 'a tier is planned on by default');
  const kept = ctx.normalizeState({
    version: 1, scouts: [], rewardTiers: { duesCents: 0, tiers: [], planOnTierId: 'T2' },
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(kept.rewardTiers.planOnTierId, 'T2', 'a pack that chose one loses the setting');
  // A stale id must not crash or silently plan on something: plannedTier resolves against the
  // real list and returns null when it does not match.
  ok(/function plannedTier\(\) \{[\s\S]*?return sortedTiers\(\)\.filter\(function \(t\) \{ return t\.id === id; \}\)\[0\] \|\| null;/.test(SCRIPT),
    'the planned tier is not resolved against the tier list');
});

test('the old "assume every tier" switch migrates to planning on the top one', () => {
  // Same figures the pack was already being shown, and from there it can pick a lower level.
  const ctx = sandbox(NORMALIZE_FNS);
  const on = ctx.normalizeState({
    version: 1, scouts: [],
    rewardTiers: { duesCents: 0, assumeAllEarn: true, tiers: [
      { id: 'T1', name: 'Dues', thresholdCents: 30000, covers: ['dues'] },
      { id: 'T2', name: 'Shirt', thresholdCents: 60000, covers: ['shirt'] },
      { id: 'T3', name: 'Prize', thresholdCents: 90000, covers: [] }
    ] },
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(on.rewardTiers.planOnTierId, 'T2', 'the highest tier that COVERS something is the migration target');
  ok(!('assumeAllEarn' in on.rewardTiers), 'the old switch survived the migration');
  const off = ctx.normalizeState({
    version: 1, scouts: [],
    rewardTiers: { duesCents: 0, assumeAllEarn: false, tiers: [
      { id: 'T1', name: 'Dues', thresholdCents: 30000, covers: ['dues'] }
    ] },
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(off.rewardTiers.planOnTierId, '', 'a pack that had it off must not start planning on a tier');
});

test('the assumption moves fees onto popcorn, and only ever raises the goal', () => {
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'fundingSummary() not found');
  ok(/var assumeCov = plannedCoverKeys\(\);/.test(fn[0]),
    'the fees loop does not consult the planned tier');
  // B falls by what the pack picks up, so C = A − B rises by the same amount. The subtraction
  // is floored against what is actually owed, so fees can never go negative and "raise the
  // goal" can never turn into "lower the goal".
  ok(/mine = Math\.min\(mine, owed\);/.test(fn[0]), 'the assumption could subtract more than is owed');
  ok(/tierAssumed \+= mine;/.test(fn[0]), 'what the assumption moved is not reported');
  ok(/tierAssumed: tierAssumed,/.test(fn[0]), 'tierAssumed is not returned for the worksheet to show');
});

test('a charge already waived is not taken off twice', () => {
  // A scout who really earned coverage left `standing` when the charge was waived. Counting
  // their share again would understate family income by that much a second time.
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/return \(chargeIsOpen\(c\) && c\.who === who\) \? n \+ \(c\.amountCents \|\| 0\) : n;/.test(fn[0]),
    'the deduction counts settled charges, or charges for a head the tier did not cover');
  // With nothing charged yet only the SCOUT share has a planning figure to fall back on: an
  // adult head nobody has recorded is not money any family owes.
  ok(/: \(who === 'scout' \? tierScoutShareForLine\(r\) : 0\);/.test(fn[0]),
    'an unrecorded adult head is being treated as forgone family income');
});

test('the plan is priced at the CHOSEN tier, and checked against the sales that earn it', () => {
  // The first cut assumed the top covering tier, which for Pack 569 meant "if all 13 scouts
  // sell $350 each" — true, useless, and reported as short by $2,021.50. The pack names the
  // level it actually expects instead, and the check follows that choice.
  const fn = /function tierAssumption\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierAssumption() not found');
  ok(!/tiers\[tiers\.length - 1\]/.test(fn[0]), 'the check still assumes the top tier');
  ok(/var pt = plannedTier\(\);/.test(fn[0]), 'the check does not read the chosen tier');
  ok(/var commission = pt \? \(pt\.thresholdCents \|\| 0\) \* roster : 0;/.test(fn[0]),
    'the promise is not the chosen threshold × the roster');
  ok(/var sales = salesForCommission\(commission\);/.test(fn[0]),
    'the sales that back the promise are not derived from it');
  ok(/var pct = commissionRates\(\)\.goal;/.test(fn[0]),
    'the check values the sales at a rate other than the one the goal uses');
  ok(/net: commission - cost\.picked/.test(fn[0]), 'there is no self-funding verdict');
  ok(!/Math\.round\(sales \* pct \/ 100\)/.test(fn[0]),
    'the promise is still being derived from a rate rather than being the threshold');
  const cost = /function coverCostForKeys\(keys\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/coverableLines\(\)\.forEach/.test(cost),
    'the price walks lines that are not coverable at all');
  ok(/if \(!keys\[coverKeyOf\(r\.key, who\)\]\) return;/.test(cost),
    'the price includes shares no tier covers');
  const able = /function coverableLines\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(able && /lineRaisesCharges\(r\.line\) \|\| lineIsFamilyDirect\(r\.line\)/.test(able[0]),
    'a council-paid line cannot be covered, or a pack-funded line can');
  // The scout share is priced across the line's own roster — a den-limited line bills its dens.
  const share = /function tierScoutShareForLine\(r\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
});

test('the choice is per tier, one at a time, and the worksheet says why B dropped', () => {
  ok(/data-ch="tier-plan-on"/.test(SCRIPT), 'there is no per-tier control');
  ok(/data-ch="tier-plan-on" data-id="' \+ t\.id \+ '"/.test(SCRIPT),
    'the control does not carry the tier it belongs to');
  ok(/state\.rewardTiers\.planOnTierId = el\.checked \? \(el\.dataset\.id \|\| ''\) : '';/.test(SCRIPT),
    'choosing a tier does not replace the last choice, or unticking does not clear it');
  ok(/>Plan on this tier</.test(SCRIPT), 'the control is unlabelled');
  ok(/Not asked for &mdash; reward tiers cover it|Not asked for \u2014 reward tiers cover it/.test(SCRIPT),
    'B drops with no line on the worksheet to say why');
  ok(/clears it|short by/.test(SCRIPT), 'the self-funding verdict is never shown');
});

test('the worksheet says why A grew when a tier buys adult shirts', () => {
  // A covered adult share is real pack spending that no line's planned cost contains. It goes
  // into A — and A silently growing is exactly the sort of thing this document keeps refusing.
  ok(/of which reward tiers buy for adults or siblings/.test(SCRIPT),
    'A grows with nothing on the worksheet to explain it');
  ok(/fs2\.tierExtra/.test(SCRIPT), 'the worksheet never reads the figure');
});

test('tiers above the planned one are stretch, and judged at the margin', () => {
  // A stretch tier is honoured when earned but never budgeted, so the question is not "can the
  // pack afford it for everybody" — it is "does one scout getting there pay for itself".
  ok(/function tierIsStretch\(t\) \{[\s\S]*?return !!pt && t\.thresholdCents > pt\.thresholdCents;/.test(SCRIPT),
    'stretch is not defined as "above the planned tier"');
  const planned = /function plannedTiers\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(planned && /if \(t\.thresholdCents <= pt\.thresholdCents\) out\.push\(t\);/.test(planned[0]),
    'planning on a tier does not include the tiers below it, which coverage stacks onto');
  const keys = /function plannedCoverKeys\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(keys && /plannedTiers\(\)\.forEach/.test(keys[0]),
    'the budgeted keys come from somewhere other than the planned tiers');
  ok(!/sortedTiers\(\)\.forEach/.test(keys[0]), 'a stretch tier is still being budgeted for');
  const fn = /function tierAssumption\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/stretch: sortedTiers\(\)\.filter\(tierIsStretch\)/.test(fn[0]), 'the stretch tiers are not reported');
  ok(/var gap = Math\.max\(0, \(t\.thresholdCents \|\| 0\) - \(below \? below\.thresholdCents \|\| 0 : 0\)\);/.test(fn[0]),
    'the margin is not the gap up from the tier below');
  // The gap between two thresholds IS the extra commission that level earns, so the margin is
  // a subtraction — no rate, and nothing for the copy to disagree with.
  ok(/tier: t, gap: gap, earns: gap,/.test(fn[0]),
    'the margin still converts the gap through a rate instead of being it');
  ok(/net: gap - perScout/.test(fn[0]), 'there is no per-scout margin verdict');
  ok(/>stretch</.test(SCRIPT) && /Stretch tiers/.test(SCRIPT), 'nothing on screen marks a tier as a stretch');
});

/* ================================================================
   Tier deadlines, and the two rates — owner asks, 2026-07-27
   ================================================================ */

test('a tier with a deadline is measured on sales dated up to it', () => {
  // "A hard deadline, where they either have to hit goal target by the date or pay the
  // difference." A sale on the 2nd cannot satisfy a deadline of the 1st.
  const ctx = coverageSandbox(`
     var TIERS = [{ id:'t1', thresholdCents: 30000, covers:['dues'], dueBy: '2025-11-01' }];
     var SALES    = { early: tot(40000), late: tot(40000), never: tot(5000) };   // season totals
     var SALES_AT = { '2025-11-01': { early: tot(35000), late: tot(10000), never: tot(5000) } };`);
  eq(Object.keys(ctx.RESULT.dues).sort(), ['early'],
    'the late seller was covered on money that arrived after the deadline');
  eq(ctx.EARNED.t1.early, 'earned', 'earned by selling');
  ok(!ctx.EARNED.t1.late, 'a season total must not satisfy a deadline');
});

test('a tier with no deadline still counts the whole season', () => {
  const ctx = coverageSandbox(`
     var TIERS = [{ id:'t1', thresholdCents: 30000, covers:['dues'], dueBy: '' }];
     var SALES = { a: tot(40000), b: tot(10000) };`);
  eq(Object.keys(ctx.RESULT.dues), ['a'], 'the no-deadline tier stopped working');
});

test('paying the difference counts as reaching the tier', () => {
  const ctx = coverageSandbox(`
     var TIERS = [{ id:'t1', thresholdCents: 30000, covers:['dues'], dueBy: '2025-11-01', madeUp: ['late'] }];
     var SALES    = { early: tot(40000), late: tot(40000) };
     var SALES_AT = { '2025-11-01': { early: tot(35000), late: tot(10000) } };`);
  eq(Object.keys(ctx.RESULT.dues).sort(), ['early', 'late'], 'a makeup payment did not satisfy the tier');
  eq(ctx.EARNED.t1.late, 'madeUp', 'the two ways in are not told apart');
});

test('the shortfall is the gap, capped at the fee it buys', () => {
  // Paying more to reach a tier than the tier saves you is not a rule anybody means.
  const fn = /function tierMissedRows\(t, map\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierMissedRows() not found');
  ok(/var totals = computeScoutTotals\(t\.dueBy\);/.test(fn[0]), 'the shortfall is measured on the wrong date');
  ok(/short = Math\.max\(0, \(t\.thresholdCents \|\| 0\) - base\)/.test(fn[0]), 'the shortfall is not the gap to the tier');
  // On the commission basis the gap is money, so paying it leaves the pack exactly where the
  // selling would have. Measuring it in SALES is what would over-charge the family.
  ok(/var got = scoutCommissionOf\(\{ t: totals\[s\.id\] \}\);/.test(fn[0]),
    'the shortfall is measured in sales, so a family would be asked for more than the pack lost');
  ok(/makeup: Math\.min\(short, cover\)/.test(fn[0]), 'the makeup is not capped at the fee');
  ok(/if \(!t\.dueBy\) return \[\];/.test(fn[0]), 'a tier with no deadline is reporting people as having missed it');
  const cover = /function tierCoverCentsPerScout\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(cover && /coverableLines\(\)\.forEach/.test(cover[0]),
    'the fee counts lines a tier cannot be pointed at in the first place');
});

test('making up the difference records money and a decision, separately', () => {
  const fn = /if \(act\.indexOf\('tier-makeup:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(fn, 'the makeup handler was not found');
  ok(/source: 'family'/.test(fn[0]), 'the payment is not recorded as family money');
  ok(/scoutId: mkS\.id/.test(fn[0]), "the payment does not settle that scout's account");
  ok(/amountCents: mkRow\.makeup/.test(fn[0]), 'it records something other than the capped shortfall');
  ok(/mkT\.madeUp = arrOf\(mkT\.madeUp\)\.concat\(\[mkS\.id\]\)/.test(fn[0]), 'the tier is not marked satisfied');
  ok(/if \(!mkRow \|\| mkRow\.makeup <= 0\) return;/.test(fn[0]),
    'a scout who did not miss the tier, or owes nothing, can still be charged a makeup');
  // Undoing the decision must never delete the money.
  const un = /if \(act\.indexOf\('tier-unmakeup:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(un, 'there is no way to undo a makeup');
  ok(!/state\.ledger/.test(un[0]), 'undoing a makeup deletes the payment out of the ledger');
  ok(/arm\(/.test(un[0]), 'undoing a makeup is a single unguarded tap');
});

test('the deadline drives coverage, waivers, badges and the counts from ONE map', () => {
  // Four screens disagreeing about who earned what is the failure mode here.
  ['function packCoverage', 'function applyTierWaivers', 'function rewardTierSummary'].forEach((f) => {
    const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}');
    const fn = re.exec(SCRIPT);
    ok(fn, f + '() not found');
    ok(/tierEarnedMap\(\)/.test(fn[0]), f + ' works out who earned a tier on its own');
  });
  ok(/var et = earnedTierFor\(r\.id, tiers, tierEarnedMap\(\)\);/.test(SCRIPT),
    'the standings badge still uses live sales, so it would show a tier somebody missed');
  ok(/function earnedTierFor\(scoutId, tiers, map\)/.test(SCRIPT), 'earnedTierFor() not found');
});

test('a blank online rate means the same rate, so nothing moves on upgrade', () => {
  // commissionRates() reads `state`, so it is exercised in a sandbox with one supplied.
  const ctx = vm.createContext({ state: {} });
  vm.runInContext(slice('commissionRates') + slice('cashScoutRate') + slice('cashCreditOn'), ctx);
  const run = (base, online) => {
    ctx.state.commissionPct = base; ctx.state.commissionPctOnline = online;
    return vm.runInContext('commissionRates()', ctx);
  };
  eq(run('32', ''), { base: 32, online: 32, split: false, goal: 32, goalIsOnline: false, cash: null },
    'blank must mean "the same"');
  eq(run('32', '32'), { base: 32, online: 32, split: false, goal: 32, goalIsOnline: false, cash: null },
    'the same figure typed twice is not a split');
  eq(run('', ''), { base: null, online: null, split: false, goal: null, goalIsOnline: false, cash: null },
    'no rate set at all');
  // A rate typed only for online still leaves the storefront rate unset rather than guessing.
  eq(run('', '50'), { base: null, online: 50, split: true, goal: 50, goalIsOnline: false, cash: null }, 'online-only');
});

test('the goal is worked out at the LOWER of the two rates', () => {
  // Pack 569 earns 35% at a storefront and 30% online — the opposite way round from the usual
  // assumption. A goal derived at the storefront rate would be short by 5% of every dollar that
  // came in online, which is the one direction a MINIMUM must never be wrong in. The lower rate
  // is the only choice that stays right whichever way the two fall.
  const ctx = vm.createContext({ state: {} });
  vm.runInContext(slice('commissionRates') + slice('cashScoutRate') + slice('cashCreditOn'), ctx);
  const run = (base, online) => {
    ctx.state.commissionPct = base; ctx.state.commissionPctOnline = online;
    return vm.runInContext('commissionRates()', ctx);
  };
  eq(run('35', '30').goal, 30, "Pack 569's own rates: the goal must use the online 30%");
  eq(run('35', '30').goalIsOnline, true, 'the screens cannot say which rate it used');
  eq(run('32', '50').goal, 32, 'when online pays better, the storefront rate is the floor');
  eq(run('32', '50').goalIsOnline, false, 'it named the wrong channel');
  // The goal itself must fall out of that rate, not out of state.commissionPct.
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'fundingSummary() not found');
  ok(/var rates = commissionRates\(\);\s*\n\s*var pct = rates\.goal;/.test(fn[0]),
    'the sales goal is still derived from the storefront rate alone');
  ok(!/parseFloat\(state\.commissionPct\)/.test(fn[0]), 'fundingSummary reads a raw rate of its own');
  // And nothing may claim online is the better one — Pack 569's is not.
  ok(!/online sales earn more|gets the pack there faster/.test(SCRIPT),
    'the copy still assumes online pays better than storefront');
});

test('the two rates are applied to their own channel and rounded apart', () => {
  const fn = /function computePackTotals\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'computePackTotals() not found');
  ok(/if \(e\.kind === 'online'\) \{ onlineDon \+= e\.donationsCents; onlineSales \+= e\.salesCents; \}/.test(fn[0]),
    'online sales are not separated from the rest');
  ok(/var onlineEligible = onlineSales \+ onlineDon;/.test(fn[0]), 'the online base is wrong');
  ok(/var otherEligible = teEligible - onlineEligible;/.test(fn[0]),
    'the storefront/wagon base is not the remainder, so cash donations could fall through a gap');
  ok(/Math\.round\(onlineEligible \* rates\.online \/ 100\)/.test(fn[0]) &&
     /Math\.round\(otherEligible \* pct \/ 100\)/.test(fn[0]),
    'the two halves are not rounded separately');
  ok(/\(commissionOnline \|\| 0\) \+ \(commissionOther \|\| 0\)/.test(fn[0]), 'the total is not the sum of the two');
  // A pack that never sets an online rate must see exactly what it saw before.
  ok(/d\.commissionPctOnline = typeof d\.commissionPctOnline === 'string' \? d\.commissionPctOnline : '';/.test(SCRIPT),
    'the online rate is not migrated to "same as the main rate"');
  ok(/data-ch="commission-online"/.test(SCRIPT), 'there is no field for the online rate');
  ok(/if \(ch === 'commission-online'\)/.test(SCRIPT), 'the online rate field has no handler');
});

test('what families pay directly is split by who they pay', () => {
  const fn = /function familyDirectByPayee\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'familyDirectByPayee() not found');
  ok(/if \(lineThroughPack\(l\)\) return;/.test(fn[0]), 'it counts money the pack actually handles');
  ok(/by\[l\.paidDirectTo\]/.test(fn[0]), 'it does not group by payee');
  ok(/return b\.cents - a\.cents \|\| a\.payee\.localeCompare\(b\.payee\)/.test(fn[0]), 'the split is in no order');
});

/* ================================================================
   Break-even sales, and reimbursing a council fee — owner asks, 2026-07-27
   ================================================================ */

test('a tier says what its threshold is worth in sales AND in commission', () => {
  // Owner ruling 2026-08-02: the threshold IS the commission, so "what the pack gets" needs no
  // rate at all and "does it pay for itself" is a subtraction. What still needs converting is
  // the number a scout can act on — nobody sells commission.
  const fn = /function tierBreakEven\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierBreakEven() not found');
  ok(/var earns = t\.thresholdCents \|\| 0;/.test(fn[0]),
    'what the tier earns the pack is being derived from a rate instead of being the threshold');
  ok(/needSales: salesForCommission\(earns\)/.test(fn[0]),
    'it does not work out the sales that reach the threshold');
  ok(!/\* pct \/ 100/.test(fn[0]), 'the break-even still multiplies the threshold by a rate');
  // Cumulative, because the tiers stack and so does what a scout at that level walks away with.
  const cum = /function tierCumulativeCoverCents\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(cum && /if \(o\.thresholdCents <= t\.thresholdCents\) cents \+= tierCoverCentsPerScout\(o\);/.test(cum[0]),
    'the break-even ignores what the tiers below already hand out');
  ok(/A scout gets there on/.test(SCRIPT), 'the sales figure is never shown');
  // Converted at the same rate as the goal, so the two cannot disagree.
  const conv = /function salesForCommission\(cents\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(conv, 'salesForCommission() not found');
  ok(/var pct = commissionRates\(\)\.goal;/.test(conv[0]),
    'the sales figure uses a different rate from the goal');
  ok(/Math\.ceil\(cents \/ \(pct \/ 100\)\)/.test(conv[0]),
    'a minimum is being rounded down, which can land a scout a cent short of the tier');
});

test('sales-to-reach-a-tier is quoted at the rate a scout can always beat', () => {
  // The conversion has to be a floor, not an estimate: sell this much and you are there
  // whatever the channel mix, because every other channel earns more per dollar.
  const ctx = vm.createContext({ state: {} });
  vm.runInContext(slice('commissionRates') + slice('cashScoutRate') + slice('cashCreditOn') + slice('salesForCommission'), ctx);
  const need = (base, online, cents) => {
    ctx.state.commissionPct = base; ctx.state.commissionPctOnline = online;
    return vm.runInContext(`salesForCommission(${cents})`, ctx);
  };
  // Pack 569's own rates, 35% storefront / 30% online. $150 of commission is $500 of popcorn
  // at the worse rate — quoting the storefront rate would promise the tier at $428.58 and then
  // not deliver it to a scout who sold online.
  eq(need('35', '30', 15000), 50000, 'the lower of the two rates must set the figure');
  eq(need('35', '', 15000), 42858, 'one rate: $150 / 35%, rounded up so it is never short');
  eq(need('', '', 15000), null, 'no rate set at all');
  eq(need('35', '30', 0), null, 'a tier that earns nothing has no sales figure');
  // The floor property, stated as arithmetic rather than as a comment.
  for (const cents of [15000, 25000, 30000, 33333, 99999]) {
    const sold = need('35', '30', cents);
    ok(Math.round(sold * 30 / 100) >= cents, `${sold} sold online must still reach ${cents}`);
    ok(Math.round(sold * 35 / 100) >= cents, `${sold} sold at a storefront must still reach ${cents}`);
  }
});

test('a scout earns a tier at each channel’s own rate', () => {
  // What the pack actually got, not an average — which means two scouts with identical sales
  // can land either side of a tier. That is the thing being measured, so it is pinned here.
  const ctx = coverageSandbox(`
     var RATE = '35', ONLINE_RATE = '30';
     var TIERS = [{ id:'t1', thresholdCents: 15000, covers:['dues'] }];
     var SALES = {
       storefront: tot(45000, 0),      // $450 at 35% = $157.50 — in
       online:     tot(0, 45000),      // $450 at 30% = $135.00 — out
       mixed:      tot(30000, 20000)   // $105.00 + $60.00 = $165.00 — in
     };`);
  eq(Object.keys(ctx.RESULT.dues).sort(), ['mixed', 'storefront'],
    'the tier is not being measured on what each channel actually earned');
  ok(!ctx.EARNED.t1.online, 'the same sales sold online do not earn the same commission');
  // And the split is rounded per channel, exactly as computePackTotals does it.
  const fn = /function scoutCommissionOf\(r\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'scoutCommissionOf() not found');
  ok(/Math\.round\(online \* \(rates\.online \|\| 0\) \/ 100\)\s*\n?\s*\+ Math\.round\(other \* \(rates\.base \|\| 0\) \/ 100\)/.test(fn[0]),
    'the two channels are not rounded apart');
  ok(/var other = goalBaseOf\(r\) - online;/.test(fn[0]),
    'the non-online remainder is not taken from the goal base, so cash could fall through a gap');
});

test('with no commission rate nothing is earned, and the card says why', () => {
  // A threshold in commission is unmeasurable without a rate. Silently showing every tier at
  // nought scouts would read as "nobody sold anything".
  const ctx = coverageSandbox(`
     var RATE = '', ONLINE_RATE = '';
     var TIERS = [{ id:'t1', thresholdCents: 15000, covers:['dues'] }, { id:'t0', thresholdCents: 0, covers:['patch'] }];
     var SALES = { big: tot(500000) };`);
  ok(!ctx.EARNED.t1.big, 'a tier was earned with no rate to measure it by');
  ok(ctx.EARNED.t0.big, 'a zero-threshold prize tier should still be reached by everybody');
  const fn = /function tierRateMissing\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierRateMissing() not found');
  ok(/No commission rate set, so nothing can be measured/.test(SCRIPT),
    'the card never explains why every tier sits at nought scouts');
});

test('a council-paid fee can be covered, and only ever as a reimbursement', () => {
  // Spring and fall camping: the parents pay the council directly, so there is no charge to
  // waive and the pack can only give the money back afterwards.
  const fn = /function lineIsFamilyDirect\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineIsFamilyDirect() not found');
  ok(/linePerHead\(l\) && lineFamilyFunded\(l\) && !lineThroughPack\(l\)/.test(fn[0]),
    'it does not describe a line families pay somebody else for');
  const rows = /function tierReimbursements\(map\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(rows, 'tierReimbursements() not found');
  ok(/e\.direction === 'out' && e\.lineId === s\.item\.id && e\.scoutId === sc\.id/.test(rows[0]),
    'what has already been paid back is not read from the ledger');
  ok(/left: Math\.max\(0, s\.rate - paid\)/.test(rows[0]), 'a part-paid reimbursement is not tracked');
  // The payment is a ledger entry OUT that carries the scout — that is what makes "who has been
  // paid back" answerable from the book. It must never be counted as family money coming IN.
  const act = /if \(act\.indexOf\('tier-reimburse:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(act, 'the reimburse handler was not found');
  ok(/direction: 'out'/.test(act[0]), 'a reimbursement is being recorded as money coming in');
  ok(/scoutId: rbS\.id/.test(act[0]), 'the entry does not say who was paid back');
  ok(/source: ''/.test(act[0]), 'a payment OUT is carrying an income source');
  ok(/Reimbursed /.test(act[0]), 'the entry does not describe itself as a reimbursement');
  ok(/receipt/.test(act[0]), 'nothing reminds the treasurer to keep the council receipt');
  // Money in is what settles a family's account; money out must not touch it.
  const pay = /function paymentsForScout\(ledger, scoutId\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(pay && /e\.direction === 'in' && e\.scoutId === scoutId/.test(pay[0]),
    'a reimbursement OUT would be counted as a payment from the family');
});

test('the guidance is quoted where the decision is made, not buried', () => {
  // Scouting America's Unit Budgeting Guidelines, on the two things this feature sits between.
  ok(/At no point can a unit/.test(SCRIPT) && /t write a check to a Scout or their family/.test(SCRIPT),
    'the rule against paying a family is not stated where a pack would act on it');
  ok(/Expenses can be reimbursed/.test(SCRIPT), 'the exception that makes this legitimate is not stated');
  ok(/have the PACK register and pay/.test(SCRIPT), 'the cleaner arrangement is not suggested');
  // And the pack's own numbers, against the guidance's own test.
  const pb = /function privateBenefitCheck\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(pb, 'privateBenefitCheck() not found');
  ok(/over: net != null && net > 0 && back > net \/ 2/.test(pb[0]),
    'the majority-of-net test is not applied to the pack’s own figures');
  ok(/majority of the NET PROCEEDS/.test(SCRIPT), 'the sentence the check comes from is not quoted');
});

/* ================================================================
   Per-family pricing, and the split on every line — owner asks, 2026-07-27
   ================================================================ */

test('a per-family fee is one price for whoever the family brings', () => {
  // Council camping is priced per family, not per head: no adult price, no sibling price, and
  // nothing for a higher tier to cover separately because there is nothing separate.
  const { LINE_BASES, linePerHead, linePerFamily, linePlannedCents, freshLine } =
    sandbox(['LINE_BASES', 'linePerHead', 'linePerFamily', 'linePlannedHeads', 'linePlannedCents',
      'centsOf', 'uid', 'freshLine', 'LINE_FUNDERS']);
  ok(LINE_BASES.indexOf('per-family') !== -1, 'per-family is not a basis a line can have');
  const camp = freshLine({ basis: 'per-family', scoutRateCents: 7500, fundedBy: 'families', paidDirectTo: 'Council' });
  ok(linePerFamily(camp), 'linePerFamily does not recognise it');
  // It shares ALL the per-head math — one charge per scout, planned = rate x roster — so nothing
  // downstream has to learn a third shape.
  ok(linePerHead(camp), 'a per-family line is not treated as per-head by the planning math');
  eq(linePlannedCents(camp, 13, 4), 97500, 'thirteen families at $75');
  // An adult rate on it is meaningless, and switching a line to per-family clears any it had.
  const fn = /\} else if \(bk === 'basis'\) \{[\s\S]*?\n      \}/.exec(SCRIPT);
  ok(fn, 'the basis handler was not found');
  ok(/if \(bl\.basis === 'per-family'\) \{\s*\n\s*bl\.adultRateCents = 0; bl\.siblingRateCents = 0;/.test(fn[0]),
    'switching to per-family leaves a stale adult rate behind for a tier to cover');
  ok(/bl\.basis = LINE_BASES\.indexOf\(el\.value\) === -1 \? 'flat' : el\.value;/.test(fn[0]),
    'the basis select cannot reach per-family');
});

test('a per-family fee counts FAMILIES, and a link is what makes that possible', () => {
  // It used to count one per scout and say so, because there was no family link. Now there is,
  // and the count follows it.
  const fam = sandbox(['familyKeyOf', 'familiesOf']);
  const roster = [
    { id: 'a', name: 'Ada Dougherty' },
    { id: 'b', name: 'Ben Dougherty', familyId: 'a' },
    { id: 'c', name: 'Cal Smith' }
  ];
  eq(fam.familiesOf(roster).length, 2, 'two Doughertys and a Smith is two families');
  eq(fam.familiesOf(roster).map((f) => f.members.map((s) => s.id)), [['a', 'b'], ['c']], 'membership');
  eq(fam.familyKeyOf({ id: 'z' }), 'z', 'an unlinked scout is a family of one');
  eq(fam.familyKeyOf({ id: 'b', familyId: 'a' }), 'a', 'a linked scout takes the family key');
  // The plan counts families for a per-family line, and scouts for everything else.
  const { linePlannedCents, freshLine } = sandbox(['centsOf', 'uid', 'freshLine', 'LINE_BASES',
    'LINE_FUNDERS', 'linePerHead', 'linePerFamily', 'linePlannedHeads', 'linePlannedCents']);
  const camp = freshLine({ basis: 'per-family', scoutRateCents: 7500 });
  eq(linePlannedCents(camp, 13, 4, 11), 82500, 'eleven families, not thirteen scouts');
  eq(linePlannedCents(camp, 13, 4), 97500, 'with no family count it falls back to one per scout');
  const dues = freshLine({ basis: 'per-head', scoutRateCents: 8000 });
  eq(linePlannedCents(dues, 13, 4, 11), 104000, 'a per-head line still counts every scout');
});

test('linking scouts pools the family fee and NOTHING else', () => {
  // Owner rule, 2026-07-27: "if a family has two scouts, each scout is allowed a parent, so both
  // parents are still eligible". The link exists for family-priced fees; every per-head
  // entitlement stays per scout.
  const fn = /function collapseMarkedToFamilies\(line, marked\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'collapseMarkedToFamilies() not found');
  ok(/if \(!marked \|\| !linePerFamily\(line\)\) return marked;/.test(fn[0]),
    'a line that is not priced per family is having its attendance collapsed');
  ok(/\/\/ The scout mark moves to the family's billing scout; the heads they brought do not move\./.test(fn[0]),
    'the rule that heads stay put is not stated where it is enforced');
  ok(/out\[sid\]\.adults \+= r\.adults \|\| 0;/.test(fn[0]),
    'a parent recorded against one sibling is being merged onto the other — two scouts, two parents');
  ok(!/out\[to\]\.adults/.test(fn[0]), 'adult heads are still being pooled onto the billing scout');
  // And the roster says the same thing where a leader does the linking.
  ok(/place, their own dues and their own parent/.test(SCRIPT),
    'the roster does not say what linking leaves alone');
});

test('the scout/adult split is available on every billed line, not just shirts', () => {
  // It was only ever asked for where the pack collects, which quietly made it a feature of
  // shirts and dinners: a council-paid campout had nowhere to put an adult price, so no tier
  // could cover an adult's place at one.
  const fn = /function lineOptionControls\(l, scoutN, collectKey\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/if \(\(mode === 'families' \|\| mode === 'direct'\) && !perFamily\) \{/.test(fn[0]),
    'a council-paid line still has nowhere to enter an adult price');
  ok(/straight to/.test(fn[0]), 'the direct case does not say who the family pays');
  // And a line with no adult price yet says what setting one would buy you.
  ok(/gives a reward tier something separate to cover/.test(fn[0]),
    'nothing tells a pack that setting an adult price makes it coverable');
});

test('a family link is one field, and survives the scout it points at leaving', () => {
  // The smallest model that fixes the double count: no family entity to create, name, rename or
  // leave orphaned. normalizeState never resolves references, so a link to a scout who left
  // simply stops matching anybody and they are a family of one again.
  const ctx = sandbox(NORMALIZE_FNS);
  const d = ctx.normalizeState({
    version: 1, scouts: [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Ben', familyId: 'a' }],
    budget: { programYear: 2025, activities: [], expenses: [] }
  });
  eq(d.scouts[0].familyId, '', 'an unlinked scout must migrate to no link');
  eq(d.scouts[1].familyId, 'a', 'a link that was set is lost');
  ok(!/familyId.*=.*getScout|resolve/.test(/if \(typeof s\.familyId !== 'string'\) s\.familyId = '';/.exec(SCRIPT)[0]),
    'the migration is resolving a reference');
  // Joining somebody joins their family, so a third scout linked to either sibling joins both.
  const fn = /if \(ch === 'scout-family'\) \{[\s\S]*?\n      \}/.exec(SCRIPT);
  ok(fn, 'the family handler was not found');
  ok(/scEd\.familyId = tgt \? familyKeyOf\(tgt\) : '';/.test(fn[0]),
    'linking copies a scout id rather than joining that scout’s family');
  ok(/if \(scEd\.familyId === scEd\.id\) scEd\.familyId = '';/.test(fn[0]),
    'a scout can be linked to themselves, which would mean two things at once');
  ok(/data-ch="scout-family"/.test(SCRIPT), 'there is no way to link two scouts');
});

/* ================================================================
   Covering the leaders, and the deadline box — 2026-07-28
   ================================================================ */

test('a leader’s place is the pack’s cost, never family income', () => {
  // The bug this pins: with no charges raised yet, expected family income fell back to the whole
  // planned cost — leaders included. A pack covering its leaders was told to raise LESS than it
  // needed by exactly what the leaders cost, which is the one direction that leaves it short.
  const fn = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'fundingSummary() not found');
  ok(/: lineFamilyPlanned\(l\);/.test(fn[0]), 'the fees fallback is not the family share');
  ok(!/: linePlanned\(l\);/.test(fn[0]), 'the fees fallback still counts the leaders’ places');
  // A one-liner, so match to the end of ITS line — a greedy block match would swallow the next
  // function, which does mention a leader rate, and the assertion would pass for the wrong reason.
  const fam = /function lineFamilyPlanned\(l\) \{[^\n]*\}/.exec(SCRIPT);
  ok(fam && /scoutRateCents/.test(fam[0]) && !/leaderRateCents/.test(fam[0]),
    'what families are billed includes a leader rate');
  // A is still the whole cost — the pack really is spending it.
  const cb = /function computeBudget\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/actPlanned \+= linePlanned\(a\);/.test(cb[0]), 'the planned figure stopped counting the leaders');
});

test('covering the leaders is shown, and priced per scout on the goal', () => {
  // "Split those costs amongst each scout" is what the plan already does — popcorn carries what
  // families are not billed for — but a pack cannot act on that unless it can see the number.
  const fn = /function leaderPlannedCents\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'leaderPlannedCents() not found');
  ok(/if \(!lineThroughPack\(r\.line\) \|\| !r\.line\.includeLeaders\) return;/.test(fn[0]),
    'it counts lines that do not include leaders, or money the pack never handles');
  ok(/\(r\.line\.leaderRateCents \|\| 0\) \* activeLeaders\(\)\.length/.test(fn[0]),
    'the leader cost is not the leader rate across the ACTIVE leader roster');
  ok(/leaderPerScout: \(salesGoal != null && scouts > 0 && leaderPlanned > 0\)/.test(SCRIPT),
    'the per-scout share of the leaders’ cost is not worked out');
  ok(/of which leaders/.test(SCRIPT), 'the worksheet never shows it');
  ok(/a scout on the goal/.test(SCRIPT), 'it does not say what that is per scout');
});

test('a tier with no deadline shows no date box', () => {
  // A native date input that has been touched can sit there showing a date the tier does not
  // have. No deadline, no box — and the box comes back the moment somebody asks for one.
  ok(/\(\(t\.dueBy \|\| ui\.tierDueOpen\[t\.id\]\)/.test(SCRIPT),
    'the date box renders whether or not there is a deadline');
  ok(/data-act="tier-due-open:/.test(SCRIPT), 'there is no way to add a deadline');
  ok(/data-act="tier-due-clear:/.test(SCRIPT), 'there is no way to take one off');
  const clear = /if \(act\.indexOf\('tier-due-clear:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(clear && /dcT\.dueBy = '';/.test(clear[0]), 'clearing does not clear the deadline');
  ok(clear && /ui\.tierDueOpen\[dcId\] = false;/.test(clear[0]),
    'clearing leaves the empty box behind, which is the thing being fixed');
  ok(/tierDueOpen: \{\},/.test(SCRIPT), 'the open-box flag is not part of ui state');
});

/* ========================================================================
   Cash donations can earn a scout something — 2026-08-02
   ===================================================================== */

test('a kept cash donation credits the scout, and only while the pack keeps it', () => {
  const ctx = vm.createContext({ state: {} });
  vm.runInContext(slice('cashScoutRate') + slice('cashCreditOn') + slice('cashScoutCredit'), ctx);
  const credit = (pct, viaTE, cents) => {
    ctx.state.cashScoutPct = pct; ctx.state.cashThroughTrailsEnd = viaTE;
    return vm.runInContext(`cashScoutCredit(${cents})`, ctx);
  };
  eq(credit('30', false, 50000), 15000, '30% of $500');
  eq(credit('', false, 50000), 0, 'no rate set means cash earns a scout nothing');
  eq(credit('0', false, 50000), 0, 'zero is the same as blank');
  eq(credit('30', false, 0), 0, 'nothing in, nothing credited');
  eq(credit('33.3', false, 10000), 3330, 'a fractional rate rounds to the cent');
  eq(credit('150', false, 10000), 10000, 'a scout cannot be credited more than the pack was given');
  // The one that matters: with the toggle ON that same cash is already earning real commission.
  eq(credit('30', true, 50000), 0, 'a donation run through Trail’s End is being credited twice');
});

test('the cash credit lands in what a scout earned, not in what they sold', () => {
  // A scout who hands over $500 in cash at a table earned the pack more than one who rang up
  // $500 of product — and until this rate existed the board had them at $175 and $0.
  const donor = "{ sales: 0, onS: 0, onD: 0, storeD: 50000, wagonD: 0 }";
  const on = coverageSandbox(`
     var RATE = '35', ONLINE_RATE = '30', CASH_RATE = '30';
     var TIERS = [{ id:'t1', thresholdCents: 15000, covers:['dues'] }];
     var SALES = { seller: tot(50000), donor: ${donor} };`);
  ok(on.EARNED.t1.seller, '$500 of storefront popcorn at 35% is $175, which clears $150');
  ok(on.EARNED.t1.donor, '$500 of cash at a 30% credit is $150, which reaches it too');
  eq(vm.runInContext('goalBaseOf({ t: SALES.donor })', on), 0,
    'the donation leaked into the sales base, so the Trail’s End goal thinks it was sold');
  const off = coverageSandbox(`
     var RATE = '35', ONLINE_RATE = '30';
     var TIERS = [{ id:'t1', thresholdCents: 15000, covers:['dues'] }];
     var SALES = { donor: ${donor} };`);
  ok(!off.EARNED.t1.donor, 'with no credit rate set, a donation still earned a tier');
});

test('cash run through Trail’s End is never paid for twice', () => {
  // Toggle on, the donation IS commissionable and goalBaseOf already carries it. Adding a
  // credit on top would hand the scout the money twice over for the same twenty-dollar bill.
  const ctx = coverageSandbox(`
     var RATE = '35', ONLINE_RATE = '30', CASH_RATE = '30', CASH_VIA_TE = true;
     var TIERS = [{ id:'t1', thresholdCents: 15000, covers:['dues'] }];
     var SALES = { donor: { sales: 0, onS: 0, onD: 0, storeD: 50000, wagonD: 0 } };`);
  eq(vm.runInContext('scoutCommissionOf({ t: SALES.donor })', ctx), 17500,
    'the commission and the credit are both being counted');
  eq(vm.runInContext('commissionRates().cash', ctx), null,
    'the effective cash rate must read as "none" while Trail’s End is handling the cash');
});

test('the pack-wide split only credits cash that reached a scout', () => {
  const ctx = vm.createContext({
    state: { cashScoutPct: '30', cashThroughTrailsEnd: false },
    // $1000 kept, but only $250 of it was ever credited to a scout — the rest sits on a
    // storefront block nobody was assigned to.
    computePackTotals: () => ({ cashKept: 100000 }),
    computeScoutTotals: () => ({ a: { storeD: 20000, wagonD: 5000 }, b: { storeD: 0, wagonD: 0 } })
  });
  vm.runInContext(slice('cashScoutRate') + slice('cashCreditOn') + slice('cashScoutCredit') +
    slice('cashCreditTotals'), ctx);
  const out = vm.runInContext('cashCreditTotals()', ctx);
  eq(out.credited, 7500, '30% of the $250 that actually reached a scout');
  eq(out.free, 92500, 'unassigned cash is free money — no tier has a claim on it');
  eq(out.kept, 100000, 'kept is the pack figure, not the scouts’ share of it');
  ctx.state.cashScoutPct = '';
  eq(vm.runInContext('cashCreditTotals()', ctx), { on: false, rate: null, kept: 100000, credited: 0, free: 100000 },
    'with no rate the whole kept figure is free and nothing is credited');
});

test('a cash credit rate alone is enough to measure tiers', () => {
  const fn = /function tierRateMissing\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn && /rates\.cash == null/.test(fn[0]),
    'a donations-only pack is told nothing can be measured while its credit rate sits there');
});

test('the cash credit is described as credit, never as a payout', () => {
  // Scouting America's unit budgeting guidance: money raised in the pack's name belongs to the
  // pack. This rate decides tier progress and nothing else — the copy must not imply otherwise.
  ok(/nothing is paid out and no scout has an account of their own/.test(SCRIPT),
    'the field never says the money is not handed over');
  ok(/It is credit, not a payout/.test(SCRIPT), 'the standings board never says it either');
  ok(!/paid out to (a|the) scout|into the scout’s account|the scout’s own account/.test(SCRIPT),
    'the copy describes an individual scout account, which is the thing to avoid');
  ok(/<strong>reward tiers<\/strong> of the scout who brought it in/.test(SCRIPT),
    'the field never says what the credit is actually for');
});

test('a checkbox and its label are styled wherever they are used', () => {
  // .perscout was defined three times, each scoped to a row class — so Season setup's copy of
  // the same markup fell through to the global `input` rule and drew a 40px padded box.
  ok(/\n  \.perscout \{ display: inline-flex;/.test(SCRIPT_CSS), 'there is no unscoped .perscout rule');
  ok(/\n  \.perscout input\[type="checkbox"\] \{[^}]*min-height: auto;/.test(SCRIPT_CSS),
    'the checkbox still inherits the 40px min-height from the global input rule');
  ok(!/\.(erow|lrow|arow) \.perscout input \{/.test(SCRIPT_CSS),
    'a row-scoped copy of the input reset is back — the base rule already does it');
  ok(!/\.(erow|lrow|arow) \.perscout \{ display: inline-flex/.test(SCRIPT_CSS),
    'a row-scoped copy of the whole rule is back');
});

/* ========================================================================
   Camping — a page per campout, published to parents. 2026-08-02
   ===================================================================== */

test('campText escapes first and only ever emits tags it built', () => {
  // A section body is prose a leader typed into a textarea and it is republished verbatim to
  // every parent in the pack. If anything here can emit an attacker-chosen tag, the parent
  // view is the delivery mechanism.
  const ctx = sandbox(['esc', 'campText']);
  const run = (s) => ctx.campText(s);
  ok(!/<script>/.test(run('<script>alert(1)</script>')), 'a script tag survived');
  ok(run('<b>hi</b>').includes('&lt;b&gt;hi&lt;/b&gt;'), 'markup is not escaped');
  ok(!/onerror/.test(run('<img src=x onerror=alert(1)>').replace(/&[a-z]+;/g, '')) === false ||
    run('<img src=x onerror=alert(1)>').indexOf('<img') === -1, 'an img tag was emitted');
  eq(run(''), '', 'empty in, empty out');
  eq(run('   \n  '), '', 'whitespace only is empty');
  eq(run('one'), '<p>one</p>', 'a bare line is a paragraph');
  eq(run('one\ntwo'), '<p>one<br>two</p>', 'a single newline is a line break, not a paragraph');
  eq(run('one\n\ntwo'), '<p>one</p><p>two</p>', 'a blank line starts a new paragraph');
  eq(run('- a\n- b'), '<ul class="camp-list"><li>a</li><li>b</li></ul>', 'a run of dashes is a list');
  // A mixed block is NOT a list — a heading line followed by bullets must not lose the heading.
  ok(run('Sleeping\n- pad\n- bag').indexOf('<ul') === -1, 'a mixed block was flattened into a list');
  ok(run('Sleeping\n- pad').includes('Sleeping<br>- pad'), 'the mixed block lost its bullets');
  eq(run('a\r\nb'), '<p>a<br>b</p>', 'CRLF from a pasted document is not handled');
});

test('the seeded trips are real content, and are seeded exactly once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const trips = ctx.seedCampingTrips();
  eq(trips.length, 2, 'two council family weekends are seeded');
  trips.forEach((t) => {
    ok(t.id && t.name && t.where && t.address, `${t.name}: missing header fields`);
    ok(t.sections.length >= 6, `${t.name}: only ${t.sections.length} sections`);
    t.sections.forEach((s) => ok(s.id && s.title && s.body, `${t.name}: an empty section was seeded`));
    // Every id distinct, or the sub-tab strip and every data-sec lookup collide.
    const ids = t.sections.map((s) => s.id);
    eq(new Set(ids).size, ids.length, `${t.name}: duplicate section ids`);
  });
  eq(new Set(trips.map((t) => t.id)).size, 2, 'the two trips share an id');
  // The camp is spelled Rainey. Getting this wrong sends a family to the wrong search result.
  ok(/Rainey Mountain/.test(JSON.stringify(trips)), 'Camp Rainey Mountain is not named');
  ok(!/Rainy Mountain/.test(JSON.stringify(trips)), 'the camp is misspelled "Rainy"');

  // A record with no camping key gets the seed...
  const fresh = ctx.normalizeState(preMigrationState());
  eq(fresh.camping.trips.length, 2, 'a pre-camping pack record was not seeded');
  // ...and a pack that has DELETED both trips must never have them pushed back.
  const emptied = ctx.normalizeState(Object.assign(preMigrationState(), { camping: { trips: [] } }));
  eq(emptied.camping.trips.length, 0, 'the seed came back after the pack deleted every trip');
  // Junk is coerced rather than thrown away or trusted.
  const messy = ctx.normalizeState(Object.assign(preMigrationState(), {
    camping: { trips: [{ name: 7, sections: [{ title: 'ok' }, null, 'nope'] }, null, 'nope'] }
  }));
  eq(messy.camping.trips.length, 1, 'non-object trips were kept');
  eq(messy.camping.trips[0].name, '', 'a non-string name was kept');
  eq(messy.camping.trips[0].sections.length, 1, 'non-object sections were kept');
  eq(messy.camping.trips[0].sections[0].body, '', 'a missing body was not defaulted');
  ok(messy.camping.trips[0].id && messy.camping.trips[0].sections[0].id, 'ids were not filled in');
});

test('the seeded content states the rules a pack actually has to follow', () => {
  // Not a style check — these are the four things a BALOO course exists to make sure somebody
  // on the trip knows. If a rewrite drops them the page becomes a packing list with a
  // reassuring tone, which is worse than nothing.
  const ctx = sandbox(NORMALIZE_FNS);
  const all = JSON.stringify(ctx.seedCampingTrips());
  [
    ['BALOO', 'the BALOO requirement'],
    ['Hazardous Weather', 'the Hazardous Weather training requirement'],
    ['parts A and B', 'the medical form requirement'],
    ['not approved unit activities', 'why shooting sports only happen at a council camp'],
    ['No adult shares a tent with a youth who is not their own child', 'the tenting rule'],
    ['Safeguarding Youth', 'the current name for Youth Protection training'],
    ['Lions do not shoot BB guns', 'the Lion range restriction'],
    ['Fire building is Webelos and up', 'the fire-building age rule']
  ].forEach(([needle, what]) => ok(all.includes(needle), `the seed no longer states ${what}`));
});

test('Camping sections are one per trip, and a trip id is never a route', () => {
  const ctx = vm.createContext({ state: { camping: { trips: [] } } });
  vm.runInContext(slice('campingTrips') + slice('tripTabLabel') + slice('sectionsOf'), ctx);
  const secs = (trips) => {
    ctx.state.camping.trips = trips;
    return vm.runInContext('sectionsOf({ id: "camping", dynamic: "camping", sections: [] })', ctx);
  };
  eq(secs([]).length, 1, 'an empty Camping tab must still offer a section to render');
  eq(secs([{ id: 'a', name: 'Fall' }, { id: 'b', name: 'Spring' }]).map((s) => s.id), ['a', 'b'],
    'one section per trip, in order');
  const long = secs([{ id: 'a', name: 'A very long campout name indeed' }])[0].label;
  ok(long.length <= 22 && long.endsWith('…'), `a long name is not shortened for the strip: ${long}`);
  eq(secs([{ id: 'a', name: 'Fall Family Camping' }])[0].label, 'Fall Family Camping',
    'a name that already fits was truncated');
  eq(secs([{ id: 'a', name: '' }])[0].label, 'Untitled trip', 'a nameless trip has no label');
  // A static workspace is untouched by any of this.
  const stat = vm.runInContext('sectionsOf({ id: "money", sections: [{ id: "budget" }] })', ctx);
  eq(stat.length, 1, 'a static workspace lost its sections');
  // Trip ids must NOT be registered as routes: SECTION_HOME is built from the literal
  // `sections` array, and Camping declares an empty one precisely so nothing lands there.
  ok(/\{ id: 'camping', label: 'Camping', dynamic: 'camping', sections: \[\] \}/.test(SCRIPT),
    'the Camping workspace declares static sections, which would put trip ids in SECTION_HOME');
});

test('camping edits are behind canEdit, and deletes are two-tap with an undo', () => {
  const actBlock = (a) => {
    const lit = a.replace(/[-:]/g, '\\$&');
    const re = a.endsWith(':')
      ? new RegExp(`act\\.indexOf\\('${lit}'\\) === 0\\)[\\s\\S]{0,900}`)
      : new RegExp(`act === '${lit}'\\)[\\s\\S]{0,900}`);
    return re.exec(SCRIPT);
  };
  ['camp-add-trip', 'camp-add-sec:', 'camp-del-sec:', 'camp-del-trip:'].forEach((a) => {
    const m = actBlock(a);
    ok(m, `the ${a} action is missing`);
    ok(/if \(!canEdit\(\)\) return;/.test(m[0]), `${a} does not check canEdit()`);
  });
  ['camp-del-sec:', 'camp-del-trip:'].forEach((a) => {
    const m = actBlock(a);
    ok(/arm\(act, function/.test(m[0]), `${a} deletes on a single tap`);
    ok(/deleteWithUndo\(/.test(m[0]), `${a} cannot be undone`);
  });
  // Deleting the trip you are looking at must clear the remembered sub-tab.
  ok(/if \(ui\.sections\.camping === dtId\) ui\.sections\.camping = '';/.test(SCRIPT),
    'deleting the open trip leaves its id remembered as the current section');
});

test('every trip is published to parents, rebuilt field by field', () => {
  const fn = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'buildParentView() not found');
  ok(/var camping = campingTrips\(\)\.map/.test(fn[0]), 'the trips are not published');
  // Never a spread: a field added to a trip in some later wave must not ride along unseen.
  ok(!/\.\.\.t\b/.test(fn[0]), 'the published trip spreads the source object');
  ['name', 'where', 'address', 'when', 'arrive', 'depart', 'cost', 'url', 'intro'].forEach((k) => {
    ok(new RegExp(`${k}: String\\(t\\.${k} \\|\\| ''\\)`).test(fn[0]), `the published trip drops ${k}`);
  });
  ok(/return \{ title: String\(s\.title \|\| ''\), body: String\(s\.body \|\| ''\) \};/.test(fn[0]),
    'a section is published with more than its title and body');
  ok(/if \(camping\.length\) out\.camping = camping;/.test(fn[0]),
    'an empty camping list still publishes a key, so parents get an empty tab');
  // A trip a leader has only just created carries nothing worth reading. It must not reach a
  // parent's phone, and the only thing keeping it off is that freshTrip leaves the name BLANK
  // — a placeholder name would be truthy and would sail straight through this filter.
  ok(/return t\.name \|\| t\.where \|\| t\.when \|\| t\.intro \|\| t\.sections\.length;/.test(fn[0]),
    'an empty trip is published');
  const ft = /function freshTrip\(name\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(ft && /id: uid\(\), name: String\(name \|\| ''\)/.test(ft[0]),
    'a new trip is born with a placeholder name, which publishes it empty');
  // And the old guarantees still hold with camping in the payload.
  ok(!/ledger/i.test(fn[0]), 'buildParentView references the ledger');
  ok(!/\bbook\b/.test(fn[0]), 'buildParentView references the book');
  // The parent tab appears only when there is something on it.
  ok(/function parentHasCamping\(\)/.test(SCRIPT), 'parentHasCamping() not found');
  ok(/Array\.isArray\(pv\.camping\) && pv\.camping\.length/.test(SCRIPT),
    'an empty published list would still show the tab');
  ok(/renderParentCamping\(pv\)/.test(SCRIPT), 'the parent app never renders the camping page');
});

test('the editor says the page is published before anyone types into it', () => {
  // The whole feature is "parents can read this". Somebody will otherwise put a phone number
  // or a family's situation in a section body, and there is no unpublish.
  ok(/<strong>Everything on this page is published to parents<\/strong>/.test(SCRIPT),
    'the editor never warns that the page is public');
  ok(/no budget, no.*dues, no roster/s.test(SCRIPT),
    'the notice does not say what is NOT published, which is the other half of the reassurance');
});

/* ========================================================================
   An adventure across several den meetings — 2026-08-02
   ===================================================================== */

// One den, one adventure tagged on several dated meetings, plus an attendance book.
function runSandbox(setup) {
  const ctx = vm.createContext({});
  vm.runInContext(
    `${setup}
     ${slice('evAdventure')}
     ${slice('meetingRoster')}
     ${slice('wasCheckedIn')}
     ${slice('adventureRuns')}
     ${slice('runProgress')}
     ${slice('runForMeeting')}
     ${slice('sessionLabel')}
     ${slice('nextPackMeetingAfter')}
     ${slice('programYearStartISO')}
     ${slice('programYearEndISO')}
     ${slice('PROGRAM_START_MONTH')}
     ${slice('pad2')}
     function activeScouts() { return SCOUTS; }
     function advKindFor() { return 'req'; }
     function advStatus(sid, kind, name) { return (STATUS[sid] || {})[name] || ''; }
     function todayISO() { return TODAY; }
     var state = { events: EVENTS, attendance: ATT, budget: { programYear: 2026 } };`, ctx);
  return ctx;
}

const RUN_SETUP = `
  var TODAY = '2026-08-13';
  var SCOUTS = [{ id: 'a', name: 'Ada', den: 'Wolf' }, { id: 'b', name: 'Ben', den: 'Wolf' },
                { id: 'c', name: 'Cy', den: 'Bear' }];
  var STATUS = {};
  var EVENTS = [
    { id: 'm1', kind: 'den', den: 'Wolf', date: '2026-08-05', time: '19:00', adventure: 'Bobcat' },
    { id: 'm2', kind: 'den', den: 'Wolf', date: '2026-08-12', time: '19:00', adventure: 'Bobcat' },
    { id: 'm3', kind: 'den', den: 'Wolf', date: '2026-08-19', time: '19:00', adventure: 'Bobcat' },
    { id: 'p1', kind: 'pack', den: '', date: '2026-08-26', adventure: '' },
    { id: 'x1', kind: 'den', den: 'Bear', date: '2026-08-05', adventure: 'Bobcat' }
  ];
  var ATT = {
    m1: { a: { scout: true }, b: { scout: true } },
    m2: { a: { scout: true } },
    m3: {}
  };`;

test('meetings tagged with the same adventure form one run, per den', () => {
  const ctx = runSandbox(RUN_SETUP);
  const runs = vm.runInContext('adventureRuns()', ctx);
  eq(runs.length, 2, 'Wolf and Bear each work Bobcat — two runs, not one');
  eq(runs.map((r) => r.den + ':' + r.sessions.length).sort(), ['Bear:1', 'Wolf:3'],
    'the sessions are not grouped by den');
  eq(runs.find((r) => r.den === 'Wolf').sessions.map((s) => s.id), ['m1', 'm2', 'm3'],
    'sessions are not in date order');
  // A pack meeting is not a session of anything, and an untagged meeting is not either.
  ok(!runs.some((r) => r.sessions.some((s) => s.kind === 'pack')), 'a pack meeting became a session');
});

test('a scout is 2 of 3, and the missed night is named', () => {
  const ctx = runSandbox(RUN_SETUP);
  const p = vm.runInContext("runProgress(adventureRuns().find(function (r) { return r.den === 'Wolf'; }))", ctx);
  eq(p.total, 3, 'three sessions');
  eq(p.scouts.map((r) => r.scout.name), ['Ada', 'Ben'], 'the roster is not the den');
  const ada = p.scouts.find((r) => r.scout.name === 'Ada');
  const ben = p.scouts.find((r) => r.scout.name === 'Ben');
  eq(ada.count, 2, 'Ada was at the two that have happened');
  eq(ada.missed.length, 0, 'Ada has missed nothing — the third has not happened yet');
  eq(ada.pending.map((e) => e.id), ['m3'], 'the still-to-come session is not tracked');
  ok(!ada.full, 'attending 2 of 3 is not the whole run');
  eq(ben.count, 1, 'Ben was at one');
  eq(ben.missed.map((e) => e.id), ['m2'], 'Ben missed the 12th and it is not reported');
  eq(p.onTrack.map((r) => r.scout.name), ['Ada'], 'on-track is "missed nothing so far"');
  eq(p.short.map((r) => r.scout.name), ['Ben'], 'short is "missed at least one that happened"');
  eq(p.complete.length, 0, 'nobody has been to all three yet');
});

test('a session still to come is never counted as missed', () => {
  // The trap: treating every unattended session as a miss would report every scout as behind
  // the moment a den schedules next month's meetings.
  const ctx = runSandbox(RUN_SETUP.replace("var TODAY = '2026-08-13';", "var TODAY = '2026-08-06';"));
  const p = vm.runInContext("runProgress(adventureRuns().find(function (r) { return r.den === 'Wolf'; }))", ctx);
  p.scouts.forEach((r) => eq(r.missed.length, 0, `${r.scout.name} was marked as missing a future meeting`));
  eq(p.onTrack.length, 2, 'both scouts should still be on track the day after session one');
});

test('every session attended, and the run is complete', () => {
  const ctx = runSandbox(RUN_SETUP
    .replace("var TODAY = '2026-08-13';", "var TODAY = '2026-08-20';")
    .replace('m3: {}', "m3: { a: { scout: true }, b: { scout: true } }"));
  const p = vm.runInContext("runProgress(adventureRuns().find(function (r) { return r.den === 'Wolf'; }))", ctx);
  const ada = p.scouts.find((r) => r.scout.name === 'Ada');
  ok(ada.full, 'Ada attended all three and is not marked complete');
  eq(p.complete.map((r) => r.scout.name), ['Ada'], 'only Ada was at all three');
  eq(p.onTrack.map((r) => r.scout.name), ['Ada'], 'Ben missed the 12th, so he is not on track');
});

test('a run is scoped to the program year, and a meeting knows its place in it', () => {
  const ctx = runSandbox(RUN_SETUP);
  const r2 = vm.runInContext("runForMeeting(state.events[1])", ctx);
  eq(r2.position, 2, 'the second meeting is session 2');
  eq(r2.of, 3, 'of three');
  eq(vm.runInContext('sessionLabel(2, 3)', ctx), 'session 2 of 3', 'the label is wrong');
  eq(vm.runInContext('sessionLabel(1, 1)', ctx), 'one session', 'a single session should not say "1 of 1"');
  // Undated, and a pack meeting: neither is a session.
  eq(vm.runInContext("runForMeeting({ kind: 'den', den: 'Wolf', date: '', adventure: 'Bobcat' })", ctx), null,
    'an undated meeting became a session');
  eq(vm.runInContext("runForMeeting({ kind: 'pack', den: '', date: '2026-08-05', adventure: 'Bobcat' })", ctx), null,
    'a pack meeting became a session');
  // LAST year's meeting on the same adventure must not join this year's run — the den is a
  // different set of children by then, and counting it reports a scout as finished who has
  // never been.
  const prior = runSandbox(RUN_SETUP.replace("{ id: 'm1', kind: 'den', den: 'Wolf', date: '2026-08-05'",
    "{ id: 'm1', kind: 'den', den: 'Wolf', date: '2025-08-05'"));
  const wolf = vm.runInContext("adventureRuns().find(function (r) { return r.den === 'Wolf'; })", prior);
  eq(wolf.sessions.map((s) => s.id), ['m2', 'm3'], 'a meeting outside the program year joined the run');
});

test('the award is presented at the next pack meeting', () => {
  // Researched: recognition is immediate at the den meeting, and FORMAL at the next pack
  // meeting, where the loop or pin is actually handed over. The calendar knows which one.
  const ctx = runSandbox(RUN_SETUP);
  eq(vm.runInContext("nextPackMeetingAfter('2026-08-13').id", ctx), 'p1', 'the next pack meeting is not found');
  eq(vm.runInContext("nextPackMeetingAfter('2026-09-01')", ctx), null, 'a past pack meeting was offered');
});

test('the mark-off button credits the run, not the room', () => {
  // The defect this replaces: on a three-meeting adventure the old button credited everyone
  // checked in TONIGHT, so a scout marked at session one who then missed two kept the credit.
  const m = /if \(act === 'mtg-adv-mark'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(m, 'the mtg-adv-mark action is missing');
  ok(/var mamRun = runForMeeting\(mam\);/.test(m[0]), 'it does not resolve the run');
  ok(/mamRun\.prog\.onTrack\.forEach/.test(m[0]),
    'it still credits the attendance book for this one meeting');
  ok(!/state\.attendance\[mam\.id\]/.test(m[0]), 'it still reads tonight’s attendance directly');
});

test('attendance is evidence, and the app never says a missed meeting costs the adventure', () => {
  // Researched, and it decides the wording: Cub Scout advancement is per requirement, "Do Your
  // Best" is the standard, and work done at home is signed by a parent and approved by the den
  // leader. A tracker that implied a missed den meeting forfeits the adventure would be wrong
  // about the programme, not just harsh.
  ok(/does not cost them the/.test(SCRIPT), 'the make-up path is never stated');
  ok(/“Do Your Best” is the standard/.test(SCRIPT), 'the actual standard is not named');
  ok(/Attendance is <strong>evidence, /.test(SCRIPT), 'the runs card does not say what attendance is');
  ok(!/cannot earn|missed out on the adventure|forfeit/i.test(SCRIPT),
    'the copy says a missed meeting loses the adventure');
});

/* ========================================================================
   The paid-direct prompt asks only what nobody has answered — 2026-08-02
   ===================================================================== */

test('a line the pack pays, or already has a payee, is never asked about', () => {
  // The owner's objection: the row's own Paid-by control already says "families pay the pack",
  // so why is a card asking again? Because on a carried-over line that value is what the
  // familyPays→fundedBy upgrade wrote, not a decision. fundedSet is that distinction.
  const ctx = sandbox(NORMALIZE_FNS);
  const norm = (line) => {
    const d = preMigrationState();
    d.budget.expenses = [Object.assign({ id: 'x', name: 'X' }, line)];
    return ctx.normalizeState(d).budget.expenses[0];
  };
  eq(norm({ basis: 'flat', fundedBy: 'pack' }).fundedSet, true,
    'a pack-paid line has no payee question, so it must not be asked about');
  eq(norm({ basis: 'per-head', fundedBy: 'families', paidDirectTo: 'Council' }).fundedSet, true,
    'a line that already names a payee has plainly been answered');
  eq(norm({ basis: 'per-head', fundedBy: 'families', paidDirectTo: '' }).fundedSet, false,
    'a families-pay-the-pack line with no payee is the ONE case that is genuinely unanswered');
  eq(norm({ basis: 'per-head', fundedBy: 'families', paidDirectTo: '', fundedSet: true }).fundedSet, true,
    'an answer already recorded was thrown away');
  // freshLine starts unanswered; normalize immediately settles it because it is pack-funded.
  ok(/fundedSet: false/.test(SCRIPT), 'freshLine does not carry the flag');
});

test('using the Paid-by control anywhere counts as answering', () => {
  const fn = /if \(ch\.indexOf\('line-'\) === 0\) \{[\s\S]*?\n      commit\(\); return;\n    \}/.exec(SCRIPT);
  ok(fn, 'the line change handler was not found');
  ok(/bl\.fundedSet = true;/.test(fn[0]), 'changing Paid by does not settle the question');
  ok(/bk === 'direct'\) \{ bl\.paidDirectTo = el\.value\.trim\(\); bl\.fundedSet = true; \}/.test(fn[0]),
    'typing a payee does not settle the question');
});

test('the prompt lists only unanswered lines, and Done answers them', () => {
  const card = /if \(!b\.directPrompted\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(card, 'the paid-direct card was not found');
  ok(/lineFamilyFunded\(r\.line\) && lineThroughPack\(r\.line\) && !r\.line\.fundedSet/.test(card[0]),
    'the card still lists lines somebody has already answered');
  // It has to SAY why it is asking about a row that already reads "families pay the pack",
  // or it looks like it is ignoring an answer sitting right there on the row.
  ok(/that is \n?\s*'?what the upgrade wrote, not something anybody chose/.test(card[0]) ||
    /what the upgrade wrote, not something anybody chose/.test(card[0]),
    'the card never explains why it is asking about an already-set control');
  const done = /if \(act === 'direct-prompt-done'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(done, 'the done action was not found');
  ok(/r\.line\.fundedSet = true;/.test(done[0]), 'Done does not actually answer the listed lines');
  ok(!/directPrompted = true/.test(done[0]),
    'Done still mutes the question globally, so a line added later is never asked about');
  // But the legacy flag is still READ, so a pack that dismissed the old card stays dismissed.
  ok(/if \(!b\.directPrompted\) \{/.test(SCRIPT), 'the legacy dismissal is no longer honoured');
});

test('the source is text, with no control characters hiding in it', () => {
  // A single NUL byte makes grep report NOTHING for the whole 900KB file — silently, with a
  // non-zero exit — so every "there are no matches for X" becomes a lie. It has happened
  // twice in this project now: once in the harness (a `join('\x00')`), once in index.html (a
  // NUL used as a map-key separator). Both worked perfectly and both blinded every search
  // over the file they were in. Cheap to assert, expensive to debug.
  const bad = [];
  for (let i = 0; i < HTML.length; i++) {
    const c = HTML.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad.push([i, c]);
  }
  ok(!bad.length, `${bad.length} control character(s), first at offset ${bad[0] && bad[0][0]} (code ${bad[0] && bad[0][1]})`);
});

/* ---------------- report ---------------- */
if (fails.length) {
  console.error(`\n  ${fails.length} failing, ${pass} passing\n`);
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passing\n`);
