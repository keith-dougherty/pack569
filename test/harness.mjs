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

test('per-scout charges count activities as well as expenses', () => {
  // Both render a collect grid, but only expenses were ever counted — so a scout who
  // hadn't paid for a per-scout ACTIVITY showed as owing nothing.
  const fn = /function perScoutCharges\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'perScoutCharges() not found');
  ok(/state\.budget\.expenses/.test(fn[0]), 'expenses are not counted');
  ok(/state\.budget\.activities/.test(fn[0]), 'activities are not counted');
  const owes = /function scoutOwesCents\(scoutId\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/perScoutCharges\(\)/.test(owes[0]), 'scoutOwesCents does not use perScoutCharges()');
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

test('collect keys match the convention the budget already uses', () => {
  // state.collected is keyed by the bare id for expenses but 'act:'+id for activities.
  // Getting that wrong writes ticks to a key nothing else reads, so the same activity
  // ends up with two independent collect states.
  const fn = /function perScoutCharges\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'perScoutCharges() not found');
  ok(/key: e\.id/.test(fn[0]), 'expense charges do not use the bare id');
  ok(/key: 'act:' \+ a\.id/.test(fn[0]), "activity charges do not use the 'act:' prefix");
  // Nothing downstream may rebuild the key from the item.
  const owes = /function scoutOwesCents\(scoutId\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/state\.collected\[c\.key\]/.test(owes[0]), 'scoutOwesCents does not read c.key');
  const dues = /function renderDues\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT);
  ok(/renderCollectBlock\(c\.item, c\.key\)/.test(dues[0]), 'the Dues grid does not pass c.key');
});

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

test('a covered scout neither owes nor is collectable', () => {
  const owes = /function scoutOwesCents\(scoutId\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/coverage\[c\.key\] \|\| \{\}\)\[scoutId\]\) return;/.test(owes[0]),
    'scoutOwesCents still charges a scout the pack is covering');
  const grid = /function renderCollectBlock\(e, colKey\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/paid by the pack/.test(grid[0]), 'the collect grid does not mark pack-covered scouts');
  ok(/if \(covered\[s\.id\]\) \{/.test(grid[0]),
    'the collect grid still renders a checkbox for a covered scout — ticking one would book pack money as family income');
});

test('coverage is derived, never written into state.collected', () => {
  // The collect grids stay a record of what FAMILIES paid. Mixing the two is what would
  // let the same dues be counted as both a pack cost and family income.
  const fn = /function packCoverage\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'packCoverage() not found');
  ok(!/state\.collected/.test(fn[0]), 'packCoverage writes or reads state.collected');
});

/* ---------------- report ---------------- */
if (fails.length) {
  console.error(`\n  ${fails.length} failing, ${pass} passing\n`);
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passing\n`);
