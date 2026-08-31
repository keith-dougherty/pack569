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

const BPV = () => {
  const m = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(m, 'buildParentView() not found');
  return m[0];
};
// Absence assertions ("this key is NEVER published") have to read CODE, not prose. The comments
// in buildParentView name the very things they forbid — "⚠ tier.madeUp NEVER publishes" — so a
// naive scan of the source finds `madeUp` and fails on the warning that exists to prevent it.
// Whole-line comments only: a trailing one is left alone, which errs towards a false FAILURE
// rather than a false pass.
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

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
  'centsOf', 'freshLine', 'LINE_BASES', 'LINE_FUNDERS', 'freshCamping',
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

/* ================================================================
   Next reward tier — owner ask, 2026-08-02: "a view somewhere that tracks and shows each
   scout's progress towards earning their next rewards tier."
   ================================================================ */

const tpCtx = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(`
    ${slice('tierProgressRows')}
    ${slice('earnedTierFor')}
    ${slice('tierIsClosed')}
    var TIERS = [], MAP = {}, SCOUTS = [], COMM = 0, NO_RATE = false, NO_SALES = false;
    var TOTALS_CALLS = [];
    function sortedTiers() { return TIERS; }
    var PLANNED = null;
    function plannedTier() { return PLANNED; }
    function tierRateMissing() { return NO_RATE; }
    function tierEarnedMap() { return MAP; }
    function activeScouts() { return SCOUTS; }
    var COMBINED = {};
    function computeScoutTotals(k) {
      TOTALS_CALLS.push(k);
      var m = {};
      SCOUTS.forEach(function (s) { m[s.id] = { combined: COMBINED[s.id] || 0 }; });
      return m;
    }
    function scoutCommissionOf() { return COMM; }
    function salesForCommission(c) { return NO_SALES ? null : (c ? Math.ceil(c / 0.30) : null); }
    // Two rates, so the row carries the shape the card now renders: biggest (safest) first.
    function sellingRoutes(c) {
      if (NO_SALES || !c) return [];
      return [{ sell: true, label: 'at a storefront or wagon', pct: 30, cents: Math.ceil(c / 0.30) },
              { sell: true, label: 'online', pct: 35, cents: Math.ceil(c / 0.35) }];
    }
    function tierCumulativeCoverCents(t) { return t.cover || 0; }
    function tierCoverCentsPerScout(t) { return t.fee == null ? (t.cover || 0) : t.fee; }
    ${slice('arrOf')}
    // Values a key set: each stub tier declares covers:['k'] and KEY_VALUE prices them, so the
    // set-difference behaviour can be tested without a budget.
    var KEY_VALUE = {};
    function coverValueOfKeys(keys) {
      var c = 0; Object.keys(keys).forEach(function (k) { c += KEY_VALUE[k] || 0; }); return c;
    }
    function todayISO() { return '2026-08-02'; }
  `, ctx);
  return ctx;
})();

function tp(opts) {
  Object.assign(tpCtx, {
    TIERS: opts.tiers, MAP: opts.map || {}, SCOUTS: opts.scouts,
    COMM: opts.comm == null ? 0 : opts.comm,
    NO_RATE: !!opts.noRate, NO_SALES: !!opts.noSales,
    KEY_VALUE: opts.keyValue || {},
    PLANNED: opts.planned || null,
    COMBINED: opts.combined || {}
  });
  tpCtx.TOTALS_CALLS = [];
  return tpCtx.tierProgressRows();
}
// Each tier covers a DISTINCT key, priced by TP_KEYS — so "what does reaching this add" is a set
// difference over keys rather than a subtraction of two running totals.
const TP_TIERS = [
  { id: 'b', name: 'Bronze', thresholdCents: 5000, covers: ['neck'], fee: 2000 },
  { id: 's', name: 'Silver', thresholdCents: 15000, covers: ['dues'], fee: 7500 },
  { id: 'g', name: 'Gold', thresholdCents: 30000, covers: ['camp'], fee: 10500, dueBy: '2026-11-30' },
  { id: 'p', name: 'Platinum', thresholdCents: 50000, covers: ['uniform'], fee: 10000, dueBy: '2026-07-01' }
];
const TP_KEYS = { neck: 2000, dues: 7500, camp: 10500, uniform: 10000 };
const TP_ONE = [{ id: 'a', name: 'Ada' }];

test('progress is measured toward the next tier a scout can still reach', () => {
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' } }, comm: 13160, keyValue: TP_KEYS });
  eq(r.earned.name, 'Bronze', 'the tier already earned');
  eq(r.next.name, 'Silver', 'the tier being worked toward');
  eq(r.short, 1840, 'the gap, in commission');
  eq(r.pct, 88, 'percent of the way there');
  // The one figure a family can act on — nobody sells commission.
  eq(r.shortSales, Math.ceil(1840 / 0.30), 'the gap said in popcorn');
  // What REACHING it adds: the dues key Silver brings, not the neckerchief Bronze already gave.
  eq(r.unlocks, 7500, 'the incremental value of the next tier');
});

test('the bar runs to the planned tier, with the rungs below it notched in', () => {
  // Owner ask, 2026-08-31. Measured rung by rung, a scout who has just cleared Bronze and a scout
  // two dollars off Gold both show a nearly empty bar — the column cannot be read down at all,
  // which is the one thing a bar is for. One denominator makes the lengths comparable.
  const planned = TP_TIERS[2];                       // Gold, $300 of commission
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' } }, comm: 13160,
    keyValue: TP_KEYS, planned });
  eq(r.anchor.name, 'Gold', 'the bar is anchored somewhere other than the planned tier');
  eq(r.anchorPct, 44, '$131.60 of a $300 planned tier is 44%');
  // Still chasing Silver — the rung ahead is unchanged, only the bar's denominator moved.
  eq(r.next.name, 'Silver', 'anchoring the bar moved which tier is next');
  // Notches: every rung BELOW the anchor. Gold is the end of the bar, not a checkpoint on it,
  // and Platinum sits off the end of it.
  eq(r.marks, [{ name: 'Bronze', pct: 17, plan: false }, { name: 'Silver', pct: 50, plan: false }],
    'the checkpoints are not the rungs below the planned tier');
  // On the plan scale the planned tier IS the end of the bar, so it is never one of the notches
  // and nothing is ever flagged. The flag only means something on the stretch scale.
  eq(r.planPct, null, 'a plan-scale row was handed a stretch boundary');
  eq(r.pastPlan, false, 'a scout below the plan was put in the stretch cohort');
});

test('a scout past the planned tier is measured to the top rung instead', () => {
  // Owner ask, 2026-08-31. Pinned to the planned tier, a scout who cleared it read a full bar and
  // 100% for the rest of the season however much more they sold, and the rungs above the plan had
  // no notch to pass. Same track, rescaled: the plan stays filled, the rest fills beyond it.
  const planned = TP_TIERS[1];                       // Silver, $150; top is Platinum, $500
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' }, s: { a: 'earned' } },
    comm: 20000, keyValue: TP_KEYS, planned });
  eq(r.pastPlan, true, 'a scout past the plan is still on the plan scale');
  eq(r.anchor.name, 'Platinum', 'the bar is not rescaled to the top rung');
  eq(r.anchorPct, 40, '$200 of a $500 top rung is 40%');
  eq(r.planPct, 30, 'the plan boundary is not at $150 of $500');
  ok(r.planPct <= r.anchorPct, 'the stretch segment would be drawn with a negative width');
  // Every rung below the top is notched on this scale, and the planned one is flagged so the
  // renderers can draw the boundary between the two fills heavier than an ordinary notch.
  eq(r.marks, [{ name: 'Bronze', pct: 10, plan: false },
               { name: 'Silver', pct: 30, plan: true },
               { name: 'Gold', pct: 60, plan: false }],
    'the stretch scale does not notch every rung below the top, or does not flag the plan');
  // The plan is done; the ladder is not. Those stay different questions.
  ok(r.next && r.next.name === 'Gold', 'a scout past the plan is treated as finished');
  ok(r.short > 0, 'a scout with a rung ahead of them is shown no gap');
});

test('a make-up payment does not put a scout on the stretch scale', () => {
  // earnedTierFor counts a tier credited by a make-up payment, so such a scout HOLDS the planned
  // tier while their commission sits below its threshold. Anchoring them to the top rung would
  // put anchorPct below planPct and hand the renderer a negative-width segment. `pastPlan` is
  // measured on `base` for exactly this reason.
  const planned = TP_TIERS[1];                       // Silver, $150
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' }, s: { a: 'madeUp' } },
    comm: 9000, keyValue: TP_KEYS, planned });       // $90 earned — below Silver
  eq(r.earned.name, 'Silver', 'the make-up credit was lost');
  eq(r.pastPlan, false, 'a scout who paid rather than sold was put on the stretch scale');
  eq(r.planPct, null, 'a plan-scale row was handed a stretch boundary');
  eq(r.anchor.name, 'Silver', 'the bar was rescaled for a scout who did not sell past the plan');
});

test('no rung above the plan means no second scale at all', () => {
  // Planning on the TOP tier, and planning on nothing, both have to fall through to exactly the
  // single-scale bar the card drew before any of this.
  const onTop = tp({ tiers: TP_TIERS, scouts: TP_ONE, comm: 60000, keyValue: TP_KEYS,
    planned: TP_TIERS[3] })[0];                      // Platinum is the top rung
  eq(onTop.ladder.stretchOn, false, 'a stretch cohort was invented above the top rung');
  eq(onTop.pastPlan, false, 'a scout was put on a scale that does not exist');
  eq(onTop.planPct, null, 'a plan boundary was published with nothing beyond it');
  const none = tp({ tiers: TP_TIERS, scouts: TP_ONE, comm: 60000, keyValue: TP_KEYS })[0];
  eq(none.ladder.stretchOn, false, 'a stretch cohort appeared with no tier planned on');
  eq(none.anchor.name, 'Platinum', 'the fallback anchor is not the top rung');
});

test('with no tier planned on, a full bar is the top of the ladder', () => {
  // A bar has to mean something. "Everything there is" is the only other honest answer, and the
  // card names which one is in force rather than leaving a reader to guess.
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, comm: 25000, keyValue: TP_KEYS });
  eq(r.anchor.name, 'Platinum', 'the fallback anchor is not the top rung');
  eq(r.anchorPct, 50, '$250 of a $500 top rung is 50%');
  eq(r.marks.map((m) => m.name), ['Bronze', 'Silver', 'Gold'], 'the lower rungs are not notched');
  const card = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/A full bar is <strong>/.test(card), 'the card never says what a full bar means');
  ok(/no tier is planned on yet/.test(card), 'the fallback anchor is presented as the planned tier');
  // The bar and the percentage beside it read off the same figure, or they contradict each other.
  // The bar's fill is still anchorPct, and the tail still carries anchorPct — but the tail now
  // NAMES it, because since 2026-08-31 it prints the next rung's percentage beside it and one
  // unlabelled figure could only ever have been one of the two.
  ok(/\(r\.planPct == null \? r\.anchorPct : r\.planPct\) \+ '%"/.test(card) &&
     /'<span class="tprog-pct">' \+ tierPctLabel\(r\)/.test(card),
    'the bar and its percentage are measured differently');
  const lbl = /function tierPctLabel\(r\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(lbl && /r\.anchorPct \+ '% of ' \+ esc\(anchorName\)/.test(lbl[0]),
    'the ladder half of the tail is measured against something other than the bar');
  // On the plan scale there is one fill and it runs to anchorPct, exactly as before.
  ok(/r\.planPct == null\s*\n?\s*\? ''/.test(card), 'a plan-scale row is drawn with a stretch segment');
});

test('a ladder with nothing to measure against draws no bar at all', () => {
  // A single tier at nought, or a threshold of nought: dividing by it would be Infinity, and an
  // empty track next to a scout who has done everything asked of them is a lie told by geometry.
  const [r] = tp({ tiers: [{ id: 'z', name: 'Free', thresholdCents: 0, covers: [] }],
    scouts: TP_ONE, comm: 5000 });
  eq(r.anchorPct, null, 'a bar was drawn against a threshold of nought');
  const card = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/r\.anchorPct == null\s*\n?\s*\? ''/.test(card), 'the bar is drawn even with nothing to measure');
});

test('a tier that covers what a scout already has adds nothing', () => {
  // Two tiers pointed at the same line is legal — Bronze and Silver both covering dues, say.
  // packCoverage unions the keys, so the second one covers nothing extra. Subtracting cumulative
  // per-tier totals (which is how tierBreakEven works, correctly, for its own question) would
  // have reported the second tier as worth another full fee.
  const overlap = [
    { id: 'b', name: 'Bronze', thresholdCents: 5000, covers: ['dues'], fee: 4000 },
    { id: 's', name: 'Silver', thresholdCents: 15000, covers: ['dues'], fee: 4000 }
  ];
  const [r] = tp({ tiers: overlap, scouts: TP_ONE, map: { b: { a: 'earned' } }, comm: 6000,
    keyValue: { dues: 4000 } });
  eq(r.next.name, 'Silver', 'the next tier');
  eq(r.unlocks, 0, 'reaching a tier that re-covers the same line is reported as worth another fee');
  // ...and a tier that adds something on top counts only the addition.
  const partial = [
    { id: 'b', name: 'Bronze', thresholdCents: 5000, covers: ['dues'], fee: 4000 },
    { id: 's', name: 'Silver', thresholdCents: 15000, covers: ['dues', 'camp'], fee: 9000 }
  ];
  const [r2] = tp({ tiers: partial, scouts: TP_ONE, map: { b: { a: 'earned' } }, comm: 6000,
    keyValue: { dues: 4000, camp: 5000 } });
  eq(r2.unlocks, 5000, 'only the newly covered share should count');
});

test('a CLOSED tier is never the next tier, and saying so is not the same as finishing', () => {
  // Platinum's deadline passed on 2026-07-01. Telling a family to chase it would be a lie, and
  // reporting Gold as the ceiling would be a different lie — they ran out of time, they did not
  // top the ladder.
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE,
    map: { b: { a: 'earned' }, s: { a: 'earned' }, g: { a: 'earned' } }, comm: 31000 });
  eq(r.next, null, 'a closed tier is being offered as reachable');
  eq(r.closedAhead, true, 'the closed tier above is not reported');
  eq(r.short, 0, 'a scout with no reachable tier has no gap');
  eq(r.pct, 100, 'the bar is not full for a scout with nothing left to reach');
});

test('a tier credited by a make-up payment is behind them, not ahead', () => {
  // tierEarnedMap marks these 'madeUp' rather than 'earned'. Either way the tier is settled, so
  // offering it as the next target would ask a family to buy something they already have.
  // This is carried by earnedTierFor (which honours any mark) plus the ascending threshold walk —
  // there is deliberately no separate check, because one was unreachable. Pinning the BEHAVIOUR
  // rather than the mechanism is what lets that stay true.
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE,
    map: { b: { a: 'earned' }, s: { a: 'madeUp' } }, comm: 6000 });
  eq(r.next.name, 'Gold', 'a made-up tier is being offered again');
});

test('the card refuses to guess when tiers cannot be measured', () => {
  // With no commission rate anywhere there is no way to turn what a scout brought in into what
  // the pack earned. Showing every scout at zero would report a rate problem as a sales problem.
  eq(tp({ tiers: TP_TIERS, scouts: TP_ONE, noRate: true }).length, 0, 'rows are built with no rate');
  eq(tp({ tiers: [], scouts: TP_ONE }).length, 0, 'rows are built with no tiers');
  // A missing GOAL rate is different: the commission gap is still true, so the row survives and
  // only the popcorn figure is withheld rather than invented.
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, comm: 0, noSales: true });
  ok(r, 'the row disappears when only the sales conversion is unavailable');
  eq(r.shortSales, null, 'a sales figure was invented with no goal rate');
  eq(r.short, 5000, 'the commission gap is still reported');
});

/* ========================================================================
   A rung you have not reached yet is exactly the thing to look at — 2026-08-31
   ===================================================================== */

// Owner, on the bar shipped in ea1ffc2: "you can't see where the lower tier notches are until a
// scout actually passes it", and "you can no longer tell what a scout needs, or how close they are
// to their next tier."

test('a notch is a gap behind the fill and a mark ahead of it', () => {
  const ctx = sandbox(['tickClass']);
  const row = { anchorPct: 44, nextMarkPct: 50 };
  eq(ctx.tickClass({ pct: 17, plan: false }, row), 'tprog-tick',
    'a rung already passed is drawn as something other than a gap in the fill');
  eq(ctx.tickClass({ pct: 50, plan: false }, row), 'tprog-tick ahead is-next',
    'the rung being chased is not marked, or not marked as ahead');
  eq(ctx.tickClass({ pct: 80, plan: false }, row), 'tprog-tick ahead',
    'a rung further ahead is invisible on the empty track');
  // Exactly at the fill edge counts as passed — the fill is drawn over it either way.
  eq(ctx.tickClass({ pct: 44, plan: false }, row), 'tprog-tick', 'a notch under the fill edge is inked');
  // The plan notch keeps its own class alone. It only exists on a bar whose scout is already past
  // the plan, which puts it behind the fill, so it can never also be `ahead`.
  eq(ctx.tickClass({ pct: 30, plan: true }, { anchorPct: 40, nextMarkPct: 60 }), 'tprog-tick is-plan',
    'the plan boundary gained a treatment that fights the pale gap it is meant to be');
  // No next rung to chase, and nothing is singled out.
  eq(ctx.tickClass({ pct: 50, plan: false }, { anchorPct: 44, nextMarkPct: null }), 'tprog-tick ahead',
    'a rung is marked as the target when there is no target');
});

test('the next rung is never marked off the end of the bar', () => {
  // The make-up case, and the only way nextMarkPct can go wrong: a payment credits the planned
  // tier while `base` sits below it, so `next` is the rung ABOVE the anchor and its honest
  // position is 200%. A notch there would sit outside the track.
  const planned = TP_TIERS[1];                       // Silver $150; next would be Gold $300
  const [r] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' }, s: { a: 'madeUp' } },
    comm: 9000, keyValue: TP_KEYS, planned });
  eq(r.anchor.name, 'Silver', 'the anchor moved for a scout who did not sell past the plan');
  eq(r.next.name, 'Gold', 'the rung ahead of a made-up tier is wrong');
  eq(r.nextMarkPct, null, 'a notch was placed past the end of the bar');
  // The ordinary case still gets a position.
  const [ok2] = tp({ tiers: TP_TIERS, scouts: TP_ONE, map: { b: { a: 'earned' } }, comm: 13160,
    keyValue: TP_KEYS, planned: TP_TIERS[2] });      // Gold $300 planned, Silver $150 next
  eq(ok2.nextMarkPct, 50, 'the next rung is not placed at its share of the anchor');
  eq(ok2.pct, 88, 'the distance to the next rung is wrong');
  // And it lands exactly on that rung's own notch, or the renderer marks the wrong one.
  ok(ok2.marks.some((m) => m.pct === ok2.nextMarkPct && m.name === 'Silver'),
    'the marked position does not coincide with the next rung’s notch');
});

test('the row prints one percentage when the rungs agree and two when they differ', () => {
  const ctx = sandbox(['esc', 'tierPctLabel']);
  const GOLD = { id: 'g', name: 'Gold' }, SILVER = { id: 's', name: 'Silver' };
  // The common case — heading straight for the tier the bar ends at. One figure; two identical
  // ones side by side would read as a mistake.
  eq(ctx.tierPctLabel({ anchor: SILVER, next: SILVER, pct: 70, anchorPct: 70 }), '70% to Silver',
    'a scout heading straight for the anchor is given the same figure twice');
  // A nearer rung than the anchor: both, each naming its own, the actionable one first.
  const split = ctx.tierPctLabel({ anchor: GOLD, next: SILVER, pct: 88, anchorPct: 44 });
  ok(/^88% to Silver/.test(split), 'the row does not lead with the rung being chased');
  ok(/44% of Gold/.test(split), 'the ladder reading lost the rung it is measured against');
  ok(split.indexOf('88% to Silver') < split.indexOf('44% of Gold'),
    'the ladder figure is printed ahead of the actionable one');
  // Top of the ladder: nothing to chase, so only the ladder reading, and it still names its rung.
  eq(ctx.tierPctLabel({ anchor: GOLD, next: null, anchorPct: 100 }),
    '<span class="muted">100% of Gold</span>', 'a finished scout is told they are 100% of nothing');
  // A tier name is escaped like everything else a leader typed.
  ok(/&lt;b&gt;/.test(ctx.tierPctLabel({ anchor: GOLD, next: { id: 'x', name: '<b>' }, pct: 5, anchorPct: 2 })),
    'a tier name goes into the row unescaped');
});

test('the standings row carries no deadline, and the deadline is still enforced', () => {
  // Owner, 2026-08-31: "we do not need the due by date on the standings." It is a property of the
  // TIER, not of the scout, so it repeated identically down every row chasing the same rung — and
  // it was the longest segment on the line.
  const card = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(card, 'renderTierProgress() not found');
  // codeOnly, because the ⚠ comment recording this ruling names the very field it forbids —
  // the same trap the absence assertions over buildParentView are built around.
  ok(!/dueBy/.test(codeOnly(card[0])), 'the deadline is back on the standings row');
  // ⚠ Dropped from THIS card only. It still has to reach a leader somewhere, and it still has to
  // decide who earned what — removing the display must not have quietly removed the rule.
  ok(/t\.dueBy \|\| ''/.test(/function tierEarnedMap\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0]),
    'tiers are no longer measured against their own deadline');
  ok(/tierDeadlineText\(t\)/.test(/function renderRewardTiers\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0]),
    'the rung itself no longer states its deadline on Popcorn · Rewards');
  ok(/dueBy \? esc\(fmtDate\(String\(t\.dueBy\)\)\) : '<span class="muted">any time/.test(SCRIPT),
    'the family ladder card lost its By column');
  ok(/dueBy: String\(t\.dueBy \|\| ''\)/.test(SCRIPT), 'the deadline is no longer published to families');
  // The printout is the family page now, and its ladder card keeps the By column — asserted just
  // above. There is no separate handout left to check.
});

test('the three notch treatments are three treatments, not three shades of one', () => {
  // No single colour survives all three backgrounds a notch lands on, and the failures are exactly
  // complementary: against the empty track / gold fill / stretch fill in light, --surface-2 is
  // 1.00 / 4.77 / 5.19 and --ink-soft is 4.60 / 1.04 / 1.13. So the notch is painted for the
  // ground it lands on, which anchorPct always tells us.
  ok(/\.tprog-tick \{[^}]*background: var\(--surface-2\)/.test(SCRIPT_CSS),
    'a notch behind the fill no longer reads as a gap in it');
  ok(/\.tprog-tick\.ahead \{[^}]*background: var\(--ink-soft\)/.test(SCRIPT_CSS),
    'a notch ahead of the fill is invisible on the empty track again');
  ok(/\.tprog-tick\.is-next \{[^}]*background: var\(--ink\)/.test(SCRIPT_CSS),
    'the rung being chased is not the strongest mark on the bar');
  ok(/\.tprog-tick\.is-next \{[^}]*width: 3px/.test(SCRIPT_CSS), 'the next rung is not drawn wider');
  // ⚠ --ink-soft and --ink are the two that clear 3:1 on the TRACK. --surface-2 there is 1.00:1,
  // which is the whole bug; anything painting an `ahead` notch in a surface token restores it.
  ok(!/\.tprog-tick\.ahead \{[^}]*var\(--surface/.test(SCRIPT_CSS),
    'a notch ahead of the fill is painted in a track colour, which is invisible on the track');
  // Both legends describe all three states — a mark nobody can name is decoration.
  for (const fn of ['renderTierProgress', 'renderParentStandings']) {
    const src = new RegExp(`function ${fn}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT);
    ok(src, `${fn}() not found`);
    ok(/gap<\/strong>/.test(src[0]) && /mark<\/strong>/.test(src[0]) && /chasing/.test(src[0]),
      `${fn} does not say what the three notch states mean`);
    // ⚠ NOT "pale" and "dark". --ink is #22303F in light and #ECE5D3 in dark, so a notch ahead of
    // the fill is dark on one theme and light on the other — the words were literally backwards
    // half the time. What IS true in every theme is that a passed rung reads as a gap in the fill
    // and one ahead reads as a mark on the track.
    ok(!/\bpale\b/.test(src[0]) && !/\bdark(est)?\b/.test(src[0]),
      `${fn} names a lightness that inverts between themes`);
    // Two WIDE notches exist now — the plan gap and the next-rung mark. "the heavy notch" no
    // longer identifies either of them.
    ok(!/the heavy notch/.test(src[0]), `${fn} still calls the plan boundary "the heavy notch"`);
  }
});

test('rows are ordered by what a scout has brought in, exactly as the family board is', () => {
  // Owner ask, 2026-08-31. It was closest-to-the-next-rung first, which made this card and the
  // family-facing board list the same scouts in two different orders — a leader reading one while
  // a parent read the other had to re-find every child.
  const scouts = [{ id: 'far', name: 'Far' }, { id: 'done', name: 'Done' }, { id: 'near', name: 'Near' }];
  const rows = tp({
    tiers: TP_TIERS, scouts,
    map: { b: { far: 'earned', near: 'earned', done: 'earned' },
           s: { near: 'earned', done: 'earned' },
           g: { done: 'earned' } },
    comm: 14000,
    combined: { far: 20000, done: 90000, near: 50000 }
  });
  eq(rows.map((r) => r.scout.name), ['Done', 'Near', 'Far'], 'the board is not ordered by what came in');
  eq(rows.map((r) => r.combined), [90000, 50000, 20000], 'the row does not carry the figure it is sorted on');
  // Same tiebreak as rankBy(), so no two rows swap places between renders.
  const tied = tp({
    tiers: TP_TIERS, scouts: [{ id: 'b', name: 'Bo' }, { id: 'a', name: 'Al' }],
    comm: 0, combined: { a: 5000, b: 5000 }
  });
  eq(tied.map((r) => r.scout.name), ['Al', 'Bo'], 'equal totals do not fall back to the name');
  // Unfiltered by any tier deadline — it is what they have brought in, not what counted toward
  // a rung that closed in November.
  const fn = /function tierProgressRows\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/combined: \(totalsFor\(''\)\[s\.id\] \|\| \{\}\)\.combined/.test(fn[0]),
    'the sort figure is measured against a deadline');
});

test('the tier-progress rows never recompute what "earned" means', () => {
  // tierEarnedMap's own comment: ONE map read by coverage, the waivers, the badges and the
  // deadline report, "so those four can never disagree about who earned what". This is the fifth
  // reader. A private threshold comparison here would let this card promise a tier the budget
  // does not waive fees for.
  const fn = /function tierProgressRows\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierProgressRows() not found');
  ok(/tierEarnedMap\(\)/.test(fn[0]), 'it no longer reads the shared earned map');
  ok(/earnedTierFor\(/.test(fn[0]), 'it no longer uses the shared "highest tier reached" helper');
  ok(/tierIsClosed\(/.test(fn[0]), 'a closed tier can be offered as reachable again');
  // activeScouts, matching every other tier function — visibleScoutRows deliberately keeps an
  // archived scout who has sales, and history is not a future tier.
  ok(/activeScouts\(\)/.test(fn[0]), 'it no longer walks the active roster');
  ok(!/visibleScoutRows/.test(fn[0]), 'archived scouts are being offered future tiers');
  // Sorts what .map() just built. Sorting a stored array would reorder the saved record.
  ok(/\}\)\.sort\(function/.test(fn[0]), 'the sort is no longer applied to a freshly built array');
  ok(!/state\.scouts\.sort/.test(fn[0]), 'it sorts the stored roster in place');
});

test('a scout can cover the remaining cost out of pocket, at the capped amount', () => {
  // Owner ask, 2026-08-02. The mechanism already existed but was reachable only after a deadline.
  const rows = tp({ tiers: [{ id: 'b', name: 'Bronze', thresholdCents: 5000, cover: 2000, fee: 2000 }],
    scouts: TP_ONE, map: {}, comm: 4000 });
  eq(rows[0].short, 1000, 'the gap');
  eq(rows[0].makeup, 1000, 'the gap is payable when it is below the fee');
  // Capped at the fee: a scout $50 short of a tier that saves them $20 pays $20, not $50.
  const capped = tp({ tiers: [{ id: 'b', name: 'Bronze', thresholdCents: 5000, cover: 2000, fee: 2000 }],
    scouts: TP_ONE, map: {}, comm: 0 });
  eq(capped[0].short, 5000, 'the gap is the whole threshold');
  eq(capped[0].makeup, 2000, 'the makeup is not capped at the fee the tier buys');
  // A prize-only tier picks up no cost, so there is nothing to pay and no button to show.
  const prize = tp({ tiers: [{ id: 'b', name: 'Bronze', thresholdCents: 5000, cover: 0, fee: 0 }],
    scouts: TP_ONE, map: {}, comm: 0 });
  eq(prize[0].makeup, 0, 'a prize-only tier is offering something to pay for');
  // A scout with nothing ahead of them has nothing to buy.
  const done = tp({ tiers: TP_TIERS, scouts: TP_ONE,
    map: { b: { a: 'earned' }, s: { a: 'earned' }, g: { a: 'earned' } }, comm: 31000 });
  eq(done[0].makeup, 0, 'a scout at the ceiling is offered a payment');
});

test('the amount on the button is the amount written to the ledger', () => {
  // Two code paths compute it — the card, and the handler recomputing from tierShortfallRows on
  // click. If they ever disagree the button becomes a lie about a real payment, so both must be
  // the same expression over the same inputs.
  const prog = /function tierProgressRows\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  const shortfall = /function tierShortfallRows\(t, map\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/makeup: next \? Math\.min\(short, cover\) : 0/.test(prog), 'the card no longer caps at the fee');
  ok(/makeup: Math\.min\(short, cover\)/.test(shortfall), 'the handler path no longer caps at the fee');
  // Both derive `short` the same way, from the same date basis.
  ok(/Math\.max\(0, need - base\)/.test(prog) || /Math\.max\(0, \(next\.thresholdCents \|\| 0\) - base\)/.test(prog),
    'the card computes the gap differently');
  ok(/Math\.max\(0, \(t\.thresholdCents \|\| 0\) - base\)/.test(shortfall), 'the handler path computes the gap differently');
  ok(/scoutCommissionOf\(/.test(prog) && /scoutCommissionOf\(/.test(shortfall),
    'one path measures commission and the other does not');
  // And the button carries the tier the card says is next, not some other tier.
  const card = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/data-act="tier-makeup:' \+\s*esc\(r\.next\.id\) \+ ':' \+ esc\(r\.scout\.id\)/.test(card),
    'the pay button targets something other than the next tier and this scout');
  // Anchored to the BUTTON's own condition. A bare /r\.makeup > 0/ also matches the lead-in
  // paragraph's rows.some(...) check, so it passed while the button itself was ungated.
  // Anchored to the BUTTON's own condition. A bare /r\.makeup > 0/ also matches the lead-in
  // paragraph's rows.some(...) check, so it passed while the button itself was ungated.
  ok(/\(r\.makeup > 0 && r\.unlocks > 0\s*\n?\s*\? '<button type="button" class="btn small ghost tprog-pay"/.test(card),
    'the button shows even when there is nothing to pay, or nothing to gain');
  // Both halves matter. makeup>0 alone would offer a payment for a tier that re-covers a line the
  // scout already holds — the cap is justified as "the fee the tier saves you", so where it saves
  // nothing the amount is arbitrary.
  ok(/r\.unlocks > 0/.test(card), 'a tier that adds no coverage can be sold again');
  // It spends a family's money, so it takes the 36px floor rather than .btn.small's 32px.
  // The SELECTOR is the assertion, not just the declaration: `.btn.small` sets 32px at (0,2,0),
  // so a bare `.tprog-pay` rule at (0,1,0) loses and the button renders 32px while the stylesheet
  // claims 36. Measured in a browser to confirm; pinned here so it cannot silently regress.
  ok(/\.btn\.small\.tprog-pay \{[^}]*min-height: 36px/.test(SCRIPT_CSS),
    'the pay button rule no longer outranks .btn.small, so it is back to a 32px target');
});

test('paying the difference is money and a decision, and undo keeps the money', () => {
  // Re-pinned from the progress card's side: the handler is shared, so the new entry point must
  // not have introduced a second writer of tier credit.
  const writers = (SCRIPT.match(/\.madeUp = arrOf\(/g) || []).length;
  eq(writers, 2, 'there is more than one place that grants or revokes tier credit');
  const mk = /if \(act\.indexOf\('tier-makeup:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT)[0];
  ok(/tierShortfallRows\(mkT\)/.test(mk), 'the handler no longer validates against the shared shortfall');
  ok(/if \(!mkRow \|\| mkRow\.makeup <= 0\) return;/.test(mk),
    'the handler would charge a scout who owes nothing');
  const un = /if \(act\.indexOf\('tier-unmakeup:'\) === 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT)[0];
  ok(!/state\.ledger = state\.ledger\.filter/.test(un), 'undo deletes the payment');
  ok(/arm\('unmakeup-/.test(un), 'undo is a single tap');
});

test('the tier-progress card states each reason it can say nothing', () => {
  const fn = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'renderTierProgress() not found');
  ok(/No reward tiers set yet/.test(fn[0]), 'no tiers is not explained');
  ok(/no commission rate set/.test(fn[0]), 'a missing rate is not explained');
  ok(/No active scouts/.test(fn[0]), 'an empty roster is not explained');
  // Owner ask, 2026-08-31: the card talks in SELLING. A tier is still defined in commission —
  // Popcorn · Rewards sets it there and the budget counts it there — but nobody sells commission,
  // and making a leader do that conversion on a phone call was the complication being removed.
  ok(/still has to ' \+\s*'<strong>sell<\/strong>/.test(fn[0]) || /has to <strong>sell<\/strong>/.test(fn[0]),
    'the card no longer says its figures are what a scout has to sell');
  ok(!/earned ' \+ fmt\(r\.base\) \+ ' of ' \+ fmt\(r\.need\) \+ '<\/span>/.test(fn[0]),
    'the commission running total is back on every row');
  // Each rate spelled out, so a scout can pick the cheaper road rather than being handed one number.
  ok(/r\.sellRoutes\.forEach\(routeSeg\)/.test(fn[0]), 'the card shows a single rate instead of each one');
  ok(/esc\(String\(rt\.pct\)\) \+ '%\)/.test(fn[0]), 'the rates are unnamed, so the two figures look arbitrary');
  ok(/Ordered by <strong>what they have brought in<\/strong>, same as the family board/.test(fn[0]),
    'the row order is unlabelled, so it reads as random');
  // Reuses the shared segment idiom rather than a private copy that can drift.
  ok(/class="bseg"/.test(fn[0]), 'the meta line no longer uses the shared .bseg segments');
  // The bar restates the percentage already in the text, so it must not be announced twice.
  ok(/<div class="bar tprog-bar" aria-hidden="true">/.test(fn[0]),
    'the progress bar is not hidden from screen readers');
  // The fill has to be visible against its own track in BOTH themes. --accent on --surface-2 is
  // 2.54:1 in light, under the 3:1 non-text floor — a progress bar you cannot read the length of.
  ok(/\.bar-fill \{[^}]*background: var\(--accent-text\)/.test(SCRIPT_CSS),
    'the bar fill is back on --accent, which is 2.54:1 on its own track in light mode');
  // It is on Popcorn · Standings, above the leaderboards.
  const rt = /function renderTotals\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(rt && /renderTierProgress\(\)/.test(rt[0]), 'the card is not rendered on Standings');
  const at = rt[0].indexOf('renderTierProgress()');
  const boards = rt[0].indexOf('Trail’s End standings');
  ok(at > -1 && boards > -1 && at < boards, 'the card is no longer above the leaderboards');
});

/* ================================================================
   Trail's End shift import — owner, 2026-08-02: "I just tried to import this file, but since the
   storefronts already exist, nothing got imported. What I want is for the shifts to populate from
   the report if they are not already set."
   ================================================================ */

const shiftCtx = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(['detectReport', 'mapShiftReport', 'teParseShiftTime', 'teShiftMinutes',
    'teStorefrontKey', 'teMissingShifts', 'parseLegacyTime', 'pad2'].map(slice).join('\n'), ctx);
  return ctx;
})();
// The real report's shape: a row per SCOUT, so a shift two scouts signed up for appears twice.
const SHIFT_ROWS = [
  ['Master Shift Report'],
  ['Date', 'Site Name', 'Address Line 1', 'Shift', 'Scout Name'],
  ['2026-08-23', 'Kroger', '2100 Riverside Pkwy', '10:00 AM - 12:00 PM US/Eastern', 'Bowie G'],
  ['2026-08-23', 'Kroger', '2100 Riverside Pkwy', '10:00 AM - 12:00 PM US/Eastern', 'Phoenix G'],
  ['2026-08-23', 'Kroger', '2100 Riverside Pkwy', '12:00 PM - 02:00 PM US/Eastern', 'Logan D'],
  ['2026-08-29', 'Kroger', '950 Herrington Rd', '10:00 AM - 12:00 PM US/Eastern', ''],
];

test('one block per SHIFT, not one per scout who signed up for it', () => {
  // The report prints a row per scout. Two sign-ups on one slot is not two shifts, and this used
  // to emit the 10:00 AM slot twice — two identical blocks on the schedule, every import.
  const mapped = shiftCtx.mapShiftReport(SHIFT_ROWS, shiftCtx.detectReport(SHIFT_ROWS));
  const first = mapped.storefronts[0];
  eq(first.shifts.map((s) => s.start), ['10:00 AM', '12:00 PM'], 'a shift was duplicated per scout');
  eq(mapped.totalShifts, 3, 'the shift count double-counts a shared slot');
  // Same site at two addresses is still disambiguated by address.
  eq(mapped.storefronts.map((sf) => sf.name),
    ['Kroger – 2100 Riverside Pkwy', 'Kroger – 950 Herrington Rd'], 'two addresses were merged');
});

test('an existing storefront gets the shifts it is missing, matched on start time', () => {
  const mapped = shiftCtx.mapShiftReport(SHIFT_ROWS, shiftCtx.detectReport(SHIFT_ROWS));
  const shifts = mapped.storefronts[0].shifts;
  // The owner's case: the storefront is on the schedule with no shifts set at all.
  eq(shiftCtx.teMissingShifts({ blocks: [] }, shifts).length, 2, 'an empty storefront gains nothing');
  // A storefront that already has one of them keeps it and gains only the other.
  const partial = { blocks: [{ start: '10:00', assignments: [{ scoutId: 's1' }], salesCents: 12345 }] };
  const miss = shiftCtx.teMissingShifts(partial, shifts);
  eq(miss.length, 1, 'a shift already on the schedule was going to be added again');
  eq(miss[0].start, '12:00 PM', 'the wrong shift was picked as missing');
  // ...and nothing about the block it already had was read as replaceable.
  eq(partial.blocks[0].salesCents, 12345, 'teMissingShifts mutated an existing block');
  // Re-importing the same file is a no-op, which is what makes this safe to run twice.
  const full = { blocks: shifts.map((sh) => ({ start: shiftCtx.parseLegacyTime(sh.start) })) };
  eq(shiftCtx.teMissingShifts(full, shifts).length, 0, 're-importing the same report duplicates blocks');
  // A shift with an unreadable time is skipped rather than added blind — it can never be matched
  // on a later import, so adding it would duplicate it every single time.
  eq(shiftCtx.teMissingShifts({ blocks: [] }, [{ start: 'whenever', end: '' }]).length, 0,
    'an unparseable shift time is added anyway, and will duplicate on every re-import');
});

test('a sign-up matches the roster on "First L", and refuses to guess', () => {
  // The report abbreviates: "Bowie G", not "Bowie Gladden". teMatchScouts, which the SALES import
  // uses, compares whole names and would match almost nobody here.
  const ctx = vm.createContext({});
  vm.runInContext(slice('teMatchShiftScout') + '\nvar ROSTER = []; function activeScouts() { return ROSTER; }', ctx);
  ctx.ROSTER = [{ id: 's1', name: 'Bowie Gladden' }, { id: 's2', name: 'Logan Dougherty' }];
  eq(ctx.teMatchShiftScout('Bowie G'), 's1', 'first name plus last initial does not match');
  eq(ctx.teMatchShiftScout('Bowie Gladden'), 's1', 'an exact full name does not match');
  eq(ctx.teMatchShiftScout('bowie  g'), 's1', 'case and spacing are not normalised');
  eq(ctx.teMatchShiftScout('Bowie G.'), 's1', 'a trailing full stop on the initial breaks it');
  // Assigning the wrong child to a shift is worse than assigning none: the shift is who turns up,
  // and once sales land on the block it is who gets the credit. So ambiguity refuses.
  ctx.ROSTER = [{ id: 'a', name: 'Bowie Gladden' }, { id: 'b', name: 'Bowie Greene' }];
  eq(ctx.teMatchShiftScout('Bowie G'), null, 'it guessed between two scouts who both fit');
  ctx.ROSTER = [{ id: 'a', name: 'Bowie Gladden' }];
  eq(ctx.teMatchShiftScout('Casey T'), null, 'a name nobody on the roster fits was matched anyway');
  eq(ctx.teMatchShiftScout(''), null, 'an empty name matched something');
  eq(ctx.teMatchShiftScout('Bowie'), null, 'a bare first name was matched on its own');
});

test('sign-ups never re-split money that has already been recorded', () => {
  // blockShares divides a block's takings across its assignees by weight, so adding one to a block
  // that already holds sales silently changes what every scout on it earned. This is the guard
  // that makes importing sign-ups safe to do at any point in the season.
  const ctx = vm.createContext({});
  vm.runInContext([slice('teNewSignups'), slice('teMatchShiftScout')].join('\n') +
    '\nvar ROSTER = []; function activeScouts() { return ROSTER; }', ctx);
  ctx.ROSTER = [{ id: 's1', name: 'Bowie Gladden' }, { id: 's2', name: 'Phoenix Gladden' }];
  const shift = { start: '10:00 AM', scouts: ['Bowie G', 'Phoenix G'] };
  eq(ctx.teNewSignups({ assignments: [], salesCents: 0, donationsCents: 0 }, shift).length, 2,
    'an empty block did not take its sign-ups');
  eq(ctx.teNewSignups({ assignments: [], salesCents: 48000, donationsCents: 0 }, shift).length, 0,
    'a block with recorded SALES took a new assignee, re-splitting the money');
  eq(ctx.teNewSignups({ assignments: [], salesCents: 0, donationsCents: 2500 }, shift).length, 0,
    'a block with recorded DONATIONS took a new assignee');
  // Someone already on the block is not added twice, however many times the report is imported.
  eq(ctx.teNewSignups({ assignments: [{ scoutId: 's1', weight: 1 }], salesCents: 0, donationsCents: 0 }, shift)
    .map((m) => m.scoutId), ['s2'], 'a scout already signed up was added again');
  // A name that matches nobody is skipped rather than dropped in as a blank assignment.
  ctx.ROSTER = [{ id: 's1', name: 'Bowie Gladden' }];
  eq(ctx.teNewSignups({ assignments: [], salesCents: 0, donationsCents: 0 },
    { start: '10:00 AM', scouts: ['Nobody Q'] }).length, 0, 'an unmatched name became an assignment');
});

test('the shift report carries its sign-ups through the parser', () => {
  // The rows that used to be discarded as duplicate shifts ARE the sign-ups.
  const mapped = shiftCtx.mapShiftReport(SHIFT_ROWS, shiftCtx.detectReport(SHIFT_ROWS));
  const first = mapped.storefronts[0];
  eq(first.shifts[0].scouts, ['Bowie G', 'Phoenix G'], 'both scouts on one shift were not collected');
  eq(first.shifts[1].scouts, ['Logan D'], 'the second shift lost its scout');
  eq(mapped.storefronts[1].shifts[0].scouts, [], 'an unstaffed shift invented a scout');
});

test('the preview discloses what the sign-up import will NOT do', () => {
  const fn = /function renderTePreview\(o\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  // Pin the CONDITIONS. Matching the strings alone passed while the branches were disabled — a
  // source scan cannot see reachability, so assert the thing that makes them reachable.
  // These two strings exist ONLY in the shifts branch. `o.unmatched` does not — the sales and
  // inventory branches have their own, so a guard aimed at it passed by matching theirs.
  //
  // ⚠ KNOWN LIMIT, stated rather than papered over: these assertions catch the copy being
  // DELETED, which is the regression that actually happens. They cannot catch the branch being
  // switched off — `if (false)` leaves every string in the file, and a source scan has no idea
  // what runs. Proving reachability needs the rendered output, and this harness has no DOM (see
  // the header). It was checked in a browser instead; if this ever needs to be automated it
  // belongs in test/scenario-browser.js, not here.
  ok(/Not signed up<\/span>/.test(fn), 'names that matched nobody are not surfaced');
  ok(/Left alone<\/span>/.test(fn), 'sign-ups skipped for landing on paid blocks are not surfaced');
  ok(/re-split money already/.test(fn), 'the reason a sign-up was held back is not given');
  ok(/refuses to guess/.test(fn), 'the preview does not say it declines ambiguous names');
  const build = /function teBuildShiftPreview\(mapped\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/signUps:/.test(build) && /unmatched:/.test(build) && /heldBack:/.test(build),
    'the preview data does not carry the sign-up outcome');
});

test('the shift import never edits a block that is already there', () => {
  // The old rule was "never edit an existing storefront", which is why a pack that had typed its
  // dates in imported nothing. The rule that actually matters is narrower: never touch an existing
  // BLOCK, because a block carries sign-ups and recorded sales.
  const fn = /function teCommitShiftImport\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'teCommitShiftImport() not found');
  ok(/teMissingShifts\(match, it\.shifts\)/.test(fn[0]), 'it no longer fills only the missing shifts');
  ok(/match\.blocks = \(match\.blocks \|\| \[\]\)\.concat\(/.test(fn[0]),
    'existing blocks are replaced rather than appended to');
  ok(!/match\.blocks = it\.shifts\.map/.test(fn[0]), 'an existing storefront has its blocks overwritten');
  // The dead skip that caused the whole complaint must not come back.
  ok(!/if \(existing\[key\]\) return;/.test(fn[0]),
    'an existing storefront is skipped whole again, so its shifts never import');
  // Both outcomes are reported, so "nothing happened" can never be silent again.
  // Anchored to the CONDITION, not just the string: a bare match on the message still passed when
  // the branch was disabled to `if (false)`. A source scan cannot see reachability, so pin the
  // guard that makes it reachable.
  ok(/if \(filled\) say\.push\('filled in ' \+ filled/.test(fn[0]),
    'filling shifts is not reported to the user');
  ok(/Every shift on this report is already on your schedule/.test(fn[0]),
    'a genuine no-op is not explained');
});

test('the shift preview says what it is about to do', () => {
  const fn = /function renderTePreview\(o\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/o\.fillCount/.test(fn), 'the preview does not count the shifts it will fill in');
  ok(/Everything here is already on your schedule/.test(fn),
    'the disabled button still claims the storefronts were the problem');
  // ⚠ This assertion used to read `No existing block is changed, renamed, moved or removed`, and
  // was CORRECTLY broken by the 2026-08-15 change that lets the report remove sign-ups. The old
  // sentence went on to promise "nothing you have recorded against one — sign-ups, sales,
  // donations — can be lost", which became a lie the moment a scout could come off. The promise
  // that survives is narrower and is the one that still holds: the BLOCK and its MONEY are safe.
  // Do not restore the old wording to make this pass.
  ok(/No existing block is renamed, moved, retimed or removed, and no sales or donations are/.test(fn),
    'the preview no longer promises that existing blocks and recorded money are safe');
  ok(!/can be lost by importing this/.test(fn),
    'the preview is back to promising sign-ups can never be lost, which removal made false');
  const build = /function teBuildShiftPreview\(mapped\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/addCount:/.test(build) && /fillCount:/.test(build), 'the preview data carries no fill counts');
});

/* ================================================================
   Owner, 2026-08-15: "it is only adding scouts from the report that are not on the website, it
   does not remove scouts from the website if no longer on the schedule from the report" — and,
   on which side wins: "The report from Trails Ends wins."
   ================================================================ */

const dropCtx = (() => {
  const ctx = vm.createContext({});
  vm.runInContext([slice('teDroppedSignups'), slice('teMatchShiftScout')].join('\n') +
    '\nvar ROSTER = []; function activeScouts() { return ROSTER; }', ctx);
  ctx.ROSTER = [{ id: 's1', name: 'Bowie Gladden' }, { id: 's2', name: 'Phoenix Gladden' },
    { id: 's3', name: 'Logan Dougherty' }];
  return ctx;
})();
const emptyBlock = (ids) => ({ assignments: ids.map((id) => ({ scoutId: id, weight: 1 })), salesCents: 0, donationsCents: 0 });

test('a scout the report has dropped comes off the block', () => {
  // The complaint: Logan is on the block here, the report no longer has him on that shift, and
  // the import left him standing there. The block is who turns up on the day.
  const shift = { start: '10:00 AM', scouts: ['Bowie G', 'Phoenix G'] };
  eq(dropCtx.teDroppedSignups(emptyBlock(['s1', 's2', 's3']), shift).map((a) => a.scoutId), ['s3'],
    'a scout no longer on the report was left signed up');
  // A shift the report has emptied out clears the block — the modal case, since a blank Scout Name
  // row is exactly what a dropped shift looks like on the report.
  eq(dropCtx.teDroppedSignups(emptyBlock(['s1', 's2']), { start: '10:00 AM', scouts: [] }).length, 2,
    'a shift nobody is signed up for on the report kept its old sign-ups');
  // Nobody is removed when the report and the block already agree, so re-importing is a no-op.
  eq(dropCtx.teDroppedSignups(emptyBlock(['s1', 's2']), shift).length, 0,
    're-importing the same report churns the assignments');
  // A scout the report added but the block does not have yet is teNewSignups' job, not this one.
  eq(dropCtx.teDroppedSignups(emptyBlock([]), shift).length, 0, 'an empty block invented a removal');
});

test('removal never re-splits money that has already been recorded', () => {
  // Symmetric with teNewSignups' guard, and for the identical reason: blockShares divides takings
  // by weight, so taking somebody OFF a paid block changes what everybody left on it earned.
  const shift = { start: '10:00 AM', scouts: ['Bowie G'] };
  eq(dropCtx.teDroppedSignups({ assignments: [{ scoutId: 's3', weight: 1 }], salesCents: 48000, donationsCents: 0 }, shift).length, 0,
    'a block with recorded SALES lost an assignee, re-splitting the money');
  eq(dropCtx.teDroppedSignups({ assignments: [{ scoutId: 's3', weight: 1 }], salesCents: 0, donationsCents: 2500 }, shift).length, 0,
    'a block with recorded DONATIONS lost an assignee');
});

test('removal refuses on a shift carrying a name it could not resolve', () => {
  // "Bowie G" with two Bowie G's on the roster resolves to nobody — and the scout already on the
  // block may BE the one the report meant. Removing on a guess deletes a sign-up the report is
  // still asking for, and nothing here can tell the difference. So the whole shift is left alone.
  const ctx = vm.createContext({});
  vm.runInContext([slice('teDroppedSignups'), slice('teMatchShiftScout')].join('\n') +
    '\nvar ROSTER = []; function activeScouts() { return ROSTER; }', ctx);
  ctx.ROSTER = [{ id: 'a', name: 'Bowie Gladden' }, { id: 'b', name: 'Bowie Greene' }];
  eq(ctx.teDroppedSignups(emptyBlock(['a']), { start: '10:00 AM', scouts: ['Bowie G'] }).length, 0,
    'an ambiguous name on the shift still removed somebody');
  // A name matching nobody at all is the same problem: it may be a roster spelling difference.
  ctx.ROSTER = [{ id: 'a', name: 'Bowie Gladden' }];
  eq(ctx.teDroppedSignups(emptyBlock(['a']), { start: '10:00 AM', scouts: ['Bowy Gladden'] }).length, 0,
    'a name that matched nobody was treated as "the shift is empty" and cleared the block');
});

test('the commit removes as well as adds, and only where the report has an opinion', () => {
  const fn = /function teCommitShiftImport\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'teCommitShiftImport() not found');
  ok(/teDroppedSignups\(b, sh\)/.test(fn[0]), 'the commit never asks what the report has dropped');
  ok(/b\.assignments = \(b\.assignments \|\| \[\]\)\.filter\(/.test(fn[0]),
    'the dropped sign-ups are computed and then not actually removed');
  // A block whose start matches no shift on the report is skipped before any of this — the report
  // says nothing about that slot, so it has no opinion to win with.
  ok(/var sh = byStart\[b\.start\];\s*\n\s*if \(!sh\) return;/.test(fn[0]),
    'a block the report does not cover is reconciled anyway, so an unrelated shift loses its scouts');
  ok(/removed ' \+ dropped \+ ' scout/.test(fn[0]), 'removals happen silently, with no toast');
});

test('the preview discloses the removals before the button is pressed', () => {
  const fn = /function renderTePreview\(o\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/Coming off<\/span>/.test(fn), 'the scouts about to be removed are not surfaced');
  ok(/schedule of record/.test(fn), 'the preview does not say the report wins');
  ok(/Anything you added by hand that the report does not/.test(fn),
    'the preview hides that hand-typed sign-ups are removed too');
  ok(/o\.dropCount/.test(fn), 'the preview does not count the sign-ups it will remove');
  // The one thing worse than not removing is removing without saying so on the button.
  ok(/'remove ' : 'Remove '/.test(fn), 'the confirm button does not name the removals');
  const build = /function teBuildShiftPreview\(mapped\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/dropCount:/.test(build) && /dropHeld:/.test(build),
    'the preview data does not carry the removal outcome');
});

test('the parent view never carries the ledger', () => {
  // Parents get a sanitized calendar. The pack's transactions are not theirs to see, and
  // the published doc is world-readable to anyone the pack has approved as a parent.
  const fn = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'buildParentView() not found');
  ok(!/ledger/i.test(fn[0]), 'buildParentView references the ledger');
  ok(!/\bbook\b/.test(fn[0]), 'buildParentView references the book (opening/statement balances)');
});

test('a meeting\u2019s internal note never reaches ANY outbound surface', () => {
  // Owner ask, 2026-08-02: two notes on a meeting, one for parents and one for leaders only.
  // A meeting note leaves the app FOUR ways, and only one of them is the parent app — so
  // checking buildParentView alone would be checking a quarter of the boundary:
  //   buildParentView  the published doc parents read
  //   monthlyDigest    the copy-to-parents newsletter text
  //   the .ics export  imported into BAND, or subscribed in Google/Apple/Outlook
  //   agendaDetail     the printed leader sheet — the ONE place it is meant to appear
  const outbound = ['buildParentView', 'monthlyDigest'];
  outbound.forEach(function (name) {
    const fn = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}').exec(SCRIPT);
    ok(fn, name + '() not found');
    ok(!/noteInternal/.test(fn[0]), name + ' publishes the leaders-only note');
  });
  // The ICS builder is not a single named function, so scan the block that writes DESCRIPTION.
  const ics = /function buildICS\(\)[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(ics, 'buildICS() was not found — the ICS guard is not scanning anything');
  ok(/icsEscape\(ev\.note\)/.test(ics[0]), 'buildICS no longer writes the published note, so this guard is aimed at the wrong code');
  ok(!/noteInternal/.test(ics[0]), 'the .ics export carries the leaders-only note');
  // ...and it DOES appear where it is supposed to: the leader-facing printable agenda.
  ok(/m\.noteInternal/.test(SCRIPT), 'the internal note is never rendered anywhere');
  ok(/line\('Leaders only', esc\(m\.noteInternal\)\)/.test(SCRIPT),
    'the printable agenda no longer shows the internal note');
  // The published field keeps its meaning. Flipping which field publishes would silently
  // un-publish every note already written — including the location parents rely on.
  const pv = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/detail: String\(e\.note \|\| ''\)/.test(pv), 'the published meeting detail is no longer e.note');
  // The handler must not route an unknown mtg-* key into the PUBLISHED note. It used to end in a
  // catch-all `else mtg.note = el.value`, which would have caught mtg-note-internal itself.
  const h = /if \(ch === 'mtg-kind'\)[\s\S]{0,700}/.exec(SCRIPT);
  ok(h, 'the meeting change handler was not found');
  ok(/else if \(ch === 'mtg-note'\) mtg\.note = el\.value;/.test(h[0]),
    'the published note is assigned from a catch-all else again');
  ok(/else if \(ch === 'mtg-note-internal'\) mtg\.noteInternal = el\.value;/.test(h[0]),
    'the internal note has no handler branch');
  // ...AND that it is reachable. The branch chain sits inside a gate that is itself an
  // allowlist of mtg-* keys, so the branch above can exist and never run. It did: the first
  // version of this change added the branch, not the gate, and typing in the field saved
  // nothing — while this very test passed on dead code. Assert the gate too.
  const gate = /if \(ch === 'mtg-kind' \|\|[\s\S]{0,240}?\) \{/.exec(SCRIPT);
  ok(gate, 'the meeting handler gate was not found');
  ok(/ch === 'mtg-note-internal'/.test(gate[0]),
    'mtg-note-internal is not in the handler gate, so its branch is unreachable');
  // Both fields say who reads them — the whole point of the split.
  ok(/Parents see this/.test(SCRIPT), 'the published note field does not name its audience');
  ok(/Leaders only \\u00b7 never published/.test(SCRIPT), 'the internal note field does not name its audience');
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
  eq(bg.includeAdults, false, 'a new line must not plan for parents until somebody says so');
  eq(linePlannedHeads(bg, 10, 4), { scouts: 10, leaders: 0, adults: 0 }, 'planned heads');
  eq(linePlannedCents(bg, 10, 4), 15000, 'ten scouts at $15 — the parents are not the pack’s to plan');
  // OWNER ASK 2026-08-02: an event priced PER PERSON at the door can opt in, per line. The ruling
  // above is intact — what it forbade was inventing a parent on every line at once, and that is
  // exactly what this asserts is still off by default. A sibling rate is never planned either way.
  bg.includeAdults = true;
  eq(linePlannedHeads(bg, 10, 4), { scouts: 10, leaders: 0, adults: 10 }, 'one parent per SCOUT, not per family');
  eq(linePlannedCents(bg, 10, 4), 30000, 'ten scouts and ten parents at $15 — the sibling rate stays out');
  // A per-family fee is one fee for whoever comes, so it has no parent head to add even ticked.
  const fam = freshLine({ basis: 'per-family', scoutRateCents: 3500, adultRateCents: 9900, includeAdults: true });
  eq(linePlannedHeads(fam, 10, 4, 8), { scouts: 8, leaders: 0, adults: 0 }, 'a per-family fee gained a parent head');
  eq(linePlannedCents(fam, 10, 4, 8), 28000, 'eight families at $35, and nothing for the adult rate');
});

test('the pack plans for leaders only when it is paying for them', () => {
  // Registration is genuinely two prices, which is why leaders carry their own rate rather
  // than sharing the scout's.
  const { linePlannedCents, linePlannedHeads, freshLine } = sandbox(PRICE_FNS);
  const camp = freshLine({ basis: 'per-head', scoutRateCents: 2000 });
  eq(linePlannedCents(camp, 10, 4), 20000, 'unticked: scouts only');
  camp.includeLeaders = true; camp.leaderRateCents = 2000;
  eq(linePlannedHeads(camp, 10, 4), { scouts: 10, leaders: 4, adults: 0 }, 'planned heads');
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
  eq(linePlannedHeads(charter, 50, 9), { scouts: 0, leaders: 0, adults: 0 }, 'no heads are counted');
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
  // THREE destinations, not two. A scout share of a line the pack collects leaves B; an adult or
  // sibling share adds to A; and ANY share of a paid-direct line adds to A as a reimbursement,
  // the scout's included — the pack never collected it, so paying it back is spending. The last
  // two used to be summed and printed under one label reading "…for adults or siblings", which
  // described a council-fee refund as buying something for a parent.
  ok(/if \(reimb\) \{ extra \+= cents; extraReimburse \+= cents; \}/.test(cost[0]),
    'a reimbursement is not tracked apart from an adult or sibling share');
  // "Not planned" rather than "not the scout" since 2026-08-02: with one-parent-per-scout ticked,
  // that parent's fee IS in the plan, so covering it must reduce expected income like a scout
  // share rather than invent a second cost on top of the one already sitting in A.
  ok(/var planned = who === 'scout' \|\| \(who === 'adult' && r\.line\.includeAdults && !linePerFamily\(r\.line\)\);/.test(cost[0]),
    'the rule is not "did the plan count on income for this share?"');
  ok(/else if \(!planned\) \{ extra \+= cents; extraHeads \+= cents; \}/.test(cost[0]),
    'an unplanned adult or sibling share is not tracked as its own kind of pack spending');
  ok(/else fees \+= cents;/.test(cost[0]),
    'a covered scout share no longer leaves expected fees');
  ok(/extraHeads: extraHeads, extraReimburse: extraReimburse/.test(cost[0]),
    'the split is computed but not returned');
  ok(/lineRateForWho\(r\.line, who\) \* lineBillingRoster\(r\.line\)\.length/.test(cost[0]),
    'a share is not priced at its own rate across whoever the line actually bills');
  const fs2 = /function fundingSummary\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var tierCost = coverCostForKeys\(assumeCov\);\s*\n\s*var tierExtra = tierCost\.extra;\s*\n\s*expenses \+= tierExtra;/.test(fs2[0]),
    'a covered adult share never reaches A, so the pack plans to buy shirts with no money for them');
  ok(/tierExtra: tierExtra,/.test(fs2[0]), 'the figure is not reported for the worksheet to show');
  ok(/tierExtraHeads: tierCost\.extraHeads, tierExtraReimburse: tierCost\.extraReimburse,/.test(fs2[0]),
    'the worksheet cannot tell an adult share from a council-fee refund');
  // And the worksheet prints them as two separate, correctly-named rows.
  ok(/…of which reward tiers buy for adults or siblings<\/td>' \+\s*\n\s*'<td class="num money">' \+ fmt\(fs2\.tierExtraHeads\)/.test(SCRIPT),
    'the adults-or-siblings row still prints the combined figure');
  ok(/…of which reward tiers pay a council fee back to families/.test(SCRIPT),
    'a reimbursement has no row of its own, so it is reported as buying something for an adult');
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
  // ...and the fallback is the scout share PLUS a planned parent where the line says one comes
  // (2026-08-02), never the whole planned cost: a leader's place is in linePlanned and no family
  // is ever billed for one.
  const famFn = /function lineFamilyPlanned\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(famFn, 'lineFamilyPlanned() not found');
  ok(/linePlannedShare\(l, 'scout'\) \+ linePlannedShare\(l, 'adult'\)/.test(famFn[0]),
    'expected family income is not the scout share plus the planned parent');
  ok(!/leaderRateCents/.test(famFn[0]), 'what families are billed includes a leader rate');
  // And the planned parent only exists where the line says one comes.
  const shareFn = /function linePlannedShare\(l, who\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(shareFn && /l\.includeAdults && !linePerFamily\(l\)/.test(shareFn[0]),
    'a line that plans one parent per scout does not expect that parent’s fee as income');
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
  //
  // ⚠ This guard used to be a bare /stretch/i scan, and it can no longer be: 2026-08-31 gave the
  // ladder a STRETCH TIER scale, which is a different thing entirely and is published on purpose.
  // The two have always been unrelated in code — stretchGoalOf/pack.stretch touch no tier function
  // and tierIsStretch touches no goal — so the guard now names the goal's own identifiers instead
  // of the word they happen to share.
  const GOAL = /stretchGoalCents|stretchGoalOf|pack\.stretch\b|\.stretch\s*>\s*0|Stretch goal/;
  const pv = /function buildParentView\(src, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(pv, 'buildParentView() not found');
  ok(!GOAL.test(pv[0]), 'the stretch goal leaked into the parent view');
  const dg = /function monthlyDigest\(mk\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(dg, 'monthlyDigest() not found');
  ok(!GOAL.test(dg[0]), 'the stretch goal leaked into the family digest');
  // And the guard still has teeth: it fires on the real thing.
  ok(GOAL.test(/function renderTotals\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0]),
    'the goal guard no longer matches the stretch goal it is protecting');
  // The ladder's stretch block is a TIER scale — no money in it, only names and percentages.
  const lad = /ladderProg\.stretch = \{[\s\S]*?\n          \};/.exec(SCRIPT);
  ok(lad, 'the published ladder lost its stretch scale');
  ok(/topName:/.test(lad[0]) && /planPct:/.test(lad[0]), 'the stretch scale is published without its bounds');
  ok(!/Cents/.test(lad[0]), 'a money figure reached the published ladder');
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
   Making the budget list scannable — owner, 2026-08-02: "make our budget line list easier to
   read and scan, the way it currently looks, it's kind of hard on the eyes."

   Every test here pins a DECISION about the list, because each one is a change somebody could
   undo in good faith while tidying up. The first is not typography at all: no amount of it
   rescues a list whose ORDER is arbitrary.
   ================================================================ */

const inSlotCtx = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(`
    ${slice('activitiesInSlot')}
    ${slice('dateInProgramYear')}
    ${slice('programYearStartISO')}
    ${slice('programYearEndISO')}
    ${slice('PROGRAM_START_MONTH')}
    ${slice('pad2')}
    function eventForLine(a) { return EVENTS.find(function (e) { return e.id === a.eventId; }) || null; }
    function lineSlot(a) { var ev = eventForLine(a); return ev ? ev.slot : -1; }
    var EVENTS = [];
    var state = { budget: { programYear: 2026, activities: [] } };`, ctx);
  return ctx;
})();

function inSlotNames(rows) {
  inSlotCtx.EVENTS = rows.map((r, i) => ({ id: 'e' + i, slot: r.slot === undefined ? 3 : r.slot, date: r.date }));
  inSlotCtx.state.budget.activities = rows.map((r, i) => ({ id: 'a' + i, name: r.name, eventId: 'e' + i }));
  return inSlotCtx.activitiesInSlot(3).map((a) => a.name);
}

test('a month lists its activities in DATE order, not the order they were added', () => {
  // Keith's real October, in the array order his record actually held it: the group read
  // "Oct 17, Oct 24, Oct 25, Oct 10, Oct 2".
  eq(inSlotNames([
    { name: 'Jamboree', date: '2026-10-17' },
    { name: 'Fishing Derby', date: '2026-10-24' },
    { name: 'Trunk or Treat', date: '2026-10-25' },
    { name: 'Corn Maze', date: '2026-10-10' },
    { name: 'Fall Camping', date: '2026-10-02' }
  ]), ['Fall Camping', 'Corn Maze', 'Jamboree', 'Fishing Derby', 'Trunk or Treat'],
  'the month group is still in whatever order the array happens to hold');
});

test('an undated line sorts after the dated ones, and ties are stable', () => {
  // Undated last matches unbudgetedActivities(). Same-date lines fall back to the NAME so the
  // order does not depend on which was typed first — two rows swapping places between renders
  // is its own kind of unreadable.
  eq(inSlotNames([
    { name: 'No date at all', date: '' },
    { name: 'Zebra', date: '2026-10-09' },
    { name: 'Apple', date: '2026-10-09' }
  ]), ['Apple', 'Zebra', 'No date at all'], 'undated/tied ordering is wrong');
});

test('sorting the month group does not reorder the stored budget', () => {
  // .filter() hands back a fresh array, so .sort() on it is safe — but only as long as it stays
  // a filter. Sorting state.budget.activities in place would silently reorder the saved record
  // and sync that reordering to every other leader.
  const fn = /function activitiesInSlot\(slot\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/state\.budget\.activities\.filter\(/.test(fn), 'no longer filters into a new array');
  ok(!/state\.budget\.activities\.sort\(/.test(fn), 'sorts the stored array in place');
});

test('the money is one column whether the row shows a figure or a field', () => {
  // These were a <span> and an <input> with different box geometry and an 11px padding fudge to
  // fake the alignment, so the right edge of the column moved from row to row.
  const rule = /\.brow \.bmoney \{[^}]*\}/.exec(SCRIPT_CSS);
  ok(rule, '.brow .bmoney rule not found');
  ok(/width:/.test(rule[0]) && /padding:/.test(rule[0]) && /text-align: right/.test(rule[0]),
    'the shared money box no longer sets width, padding and alignment in one place');
  ok(!/span\.bmoney \{[^}]*padding-right: 11px/.test(SCRIPT_CSS),
    'the padding fudge that faked the alignment is back');
  ok(/\.brow span\.bmoney \{[^}]*border: 1px solid transparent/.test(SCRIPT_CSS),
    'the figure does not reserve the border width the field spends, so they cannot line up');
});

test('the row fields are quiet at rest and reveal themselves on demand', () => {
  // A month of activities was ten bordered input boxes stacked up, and the boxes were the
  // highest-contrast marks on the card — louder than any figure inside them.
  ok(/\.brow input\.bname, \.brow input\.bmoney \{[^}]*border-color: transparent/.test(SCRIPT_CSS),
    'the name and cost fields are bordered at rest again');
  ok(/\.brow:hover input\.bname[^{]*\{[^}]*border-color: var\(--line\)/.test(SCRIPT_CSS),
    'hover no longer reveals that the row is editable');
  ok(/\.brow input\.bname:focus[^{]*\{[^}]*border-color: var\(--line\)/.test(SCRIPT_CSS),
    'focus no longer draws the field it is in — quiet must not mean invisible to the keyboard');
  // The one exception: an EMPTY name has no text to read, so on a touch screen (no hover) there
  // would be nothing at all to say it is a field.
  ok(/\.brow input\.bname:placeholder-shown \{[^}]*border-color: var\(--line\)/.test(SCRIPT_CSS),
    'a brand-new unnamed row gives no sign it can be typed into');
  ok(!/\.brow input\.bmoney:placeholder-shown/.test(SCRIPT_CSS),
    'every free activity is back to wearing a box around the word "Cost"');
});

test('the payer rail is legible in BOTH themes', () => {
  // --navy is a BACKGROUND token in dark mode — it is what the topbar is filled with — so
  // #1C2F47 on a #202935 card measured 1.08:1 and the rail simply did not exist on the theme
  // the app opens in by default. --good is a foreground token in both.
  ok(/\.brow\.pays-families::after \{[^}]*var\(--good\)/.test(SCRIPT_CSS),
    'the families-pay rail is painted in something other than --good');
  ok(!/\.brow\.pays-families::after \{[^}]*var\(--navy\)/.test(SCRIPT_CSS),
    'the rail is back on --navy, which is invisible on a dark card');
  // Solid vs dashed is what actually separates the two, because they are within 1.2:1 of each
  // other in luminance in both themes.
  ok(/\.brow\.pays-direct::after \{[^}]*dashed/.test(SCRIPT_CSS),
    'paid-direct is no longer told apart by anything but colour');
  // And pack-pays gets NO rail: it is the default and the majority, and a marker on every row
  // marks nothing.
  ok(!/\.brow\.pays-pack::after/.test(SCRIPT_CSS), 'the default arrangement has grown a marker');
  const fn = /function budgetLineRow\(l, scoutN, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/lineFamilyFunded\(l\) \? \(l\.paidDirectTo \? ' pays-direct' : ' pays-families'\) : ''/.test(fn),
    'the rail no longer follows who actually pays');
  // Redundant encoding: the words stay in the sentence, so nothing here depends on colour.
  const sum = /function lineSummarySegments\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/families pay the pack/.test(sum) && /pack pays/.test(sum),
    'who pays is now carried by the rail alone');
});

test('the summary breaks between facts, never through one', () => {
  // Unscoped, so a second surface (Next reward tier) builds the same sentence from the same
  // rules rather than a copy that can drift. Assert the RULE, not where it is scoped.
  ok(/\n  \.bseg \{[^}]*white-space: nowrap/.test(SCRIPT_CSS),
    'a segment can wrap inside itself again — "Activities & outings" comes apart');
  // The separator belongs to the segment AFTER it. Emitted between them it can end a line,
  // which leaves a dot pointing at nothing.
  ok(/\.bseg \+ \.bseg::before \{[^}]*content:/.test(SCRIPT_CSS),
    'the interpunct is not drawn inside the following segment');
  const fn = /function lineSummaryHtml\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'lineSummaryHtml() not found');
  ok(!/join\(' <span class="bdot">/.test(fn[0]),
    'the segments are joined by a dot element again, which can dangle at a line break');
  // Segments are the single source and lineSummaryHtml is the only consumer. There is no
  // plain-text twin: splitting one sentence across two builders is how they drift, and keeping
  // an uncalled one alive behind a passing test is worse than not having it.
  ok(!/function lineSummaryText\(/.test(SCRIPT),
    'a second, uncalled builder for the same sentence is back');
});

test('the summary is sized so the actions never get pushed onto their own line', () => {
  // With flex-wrap on, a line breaks on items' hypothetical sizes BEFORE any of them is allowed
  // to shrink. A summary sized to its own content therefore pushed the whole action cluster down
  // and left a band of empty row beside it — worse than the ragged version it replaced.
  const rule = /\.brow-meta \.bsum \{[^}]*\}/.exec(SCRIPT_CSS);
  ok(rule, '.brow-meta .bsum rule not found');
  ok(/flex: 1 1 \d+px/.test(rule[0]),
    'the summary is back on a content-sized basis, so the actions will wrap away from it');
});

test('the three row actions travel as one cluster', () => {
  // Ragged is the enemy of scanning: five rows of "Record actual" starting at five different
  // x-positions read as five different things.
  const fn = /function budgetLineRow\(l, scoutN, opts\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  const acts = /<span class="bacts">[\s\S]*?<\/span>'/.exec(fn);
  ok(acts, 'the actions are no longer wrapped in one cluster');
  ok(/actualBtn\(l\.id\)/.test(acts[0]), 'Record actual left the cluster');
  ok(/data-act="line-options"/.test(acts[0]), 'Options left the cluster');
  ok(/tinyDangerBtn\(opts\.delAct/.test(acts[0]), 'the remove button left the cluster');
  ok(/\.brow-meta \.bacts \{[^}]*margin-left: auto/.test(SCRIPT_CSS),
    'the cluster no longer holds a column of its own');
  // ...and it goes back to the left edge on a phone, where the row is read down its left side.
  ok(/@media \(max-width: 520px\) \{[\s\S]*?\.brow-meta \.bacts \{[^}]*margin-left: -4px/.test(SCRIPT_CSS),
    'on a phone the actions are stranded at the far right of a full-width sentence');
});

test('destroying a line is not the loudest thing on the card', () => {
  // Red answers "am I about to destroy something?", which is a question asked on the way to the
  // control — not from across the page by five ✕s in a list where nothing is wrong.
  // In the BASE rule, so it reaches all 20 call sites and — critically — cannot outrank
  // `.btiny.armed`. A descendant copy at (0,3,0) beat `.btiny.armed { color: #FFF }` at (0,2,0)
  // and computed --bad on a --bad fill: the confirm step was invisible in light mode. Dark mode
  // survived on a (0,4,0) theme override, which is why it went unseen.
  ok(/\n  \.btiny \{[^}]*color: var\(--ink-soft\)/.test(SCRIPT_CSS),
    'the remove button is red at rest again');
  ok(/\.btiny:hover, \.btiny:focus-visible \{[^}]*color: var\(--bad\)/.test(SCRIPT_CSS),
    'reaching for it no longer turns it red');
  // The lookbehind is load-bearing: without it `border-color: var(--bad)` satisfies the pattern,
  // and .btiny.armed legitimately sets that. Only the INK is forbidden here.
  ok(!/\.btiny[^{]*\.armed \{[^}]*(?<![-\w])color: var\(--bad\)/.test(SCRIPT_CSS),
    'an .armed selector sets color:--bad again — that is --bad text on the --bad fill .armed draws');
  ok(/\.btiny\.armed \{[^}]*background: var\(--bad\)/.test(SCRIPT_CSS),
    '.armed no longer fills itself, so there is nothing to read the ink against');
  // No local copies left to drift or to re-open the specificity fight.
  ok(!/\.brow-meta \.btiny/.test(SCRIPT_CSS), 'a per-list copy of the rule is back');
  ok(!/\.adult-chip \.btiny \{[^}]*color:/.test(SCRIPT_CSS), 'the .adult-chip copy is back');
  // It is a destructive control and it keeps its 36px target.
  ok(/\n  \.btiny \{[^}]*min-height: 36px/.test(SCRIPT_CSS),
    'the delete target has been shrunk below the 36px the rest of the app uses');
});

test('a month heading reads as a label, not as another activity', () => {
  // At body size and body weight it was indistinguishable from an activity name, so the eye had
  // to work out which lines were headings. All four group headings use the one treatment.
  ok(/\.bmonth-head \.bmonth-name \{[^}]*text-transform: uppercase/.test(SCRIPT_CSS),
    'the group heading is no longer set apart from the rows under it');
  const rb = /function renderBudget\(\) \{[\s\S]*?\n    return h;\n  \}/.exec(SCRIPT)[0];
  eq((rb.match(/class="spread bmonth-head"/g) || []).length, 4,
    'not every budget group heading uses the shared treatment');
  ok(!/<div class="bmonth"><div class="spread" style="margin-bottom:4px">/.test(rb),
    'a group heading is back to a bare <strong> at body size');
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
  // The July ruling killed `adultsFrom: 'assumption'` + `adultsPerScout` — a NUMBER of invented
  // parents, applied to every per-head line at once. A per-line CHECKBOX is the sanctioned way
  // back (owner ask, 2026-08-02: the Christmas party is priced per person), so this guard now
  // names the thing it forbids instead of matching the loose phrase "an assumption", which my own
  // explanatory comment tripped.
  ok(!/adultsPerScout|adultsFrom|adults\/scout/.test(fn[0]),
    'the invented-parents assumption is back in the editor');
  ok(!/data-ch="line-adults-per-scout"/.test(fn[0]), 'a per-scout adult COUNT input is back');
  ok(/type="checkbox" data-ch="line-include-adults"/.test(fn[0]),
    'the per-person option is not a checkbox — a count would be the old bug again');
  ok(fn[0].includes('One parent per scout'), 'there is no way to price a line per person');
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
  // With nothing charged yet, a covered share falls back to what the PLAN expects from it. That
  // used to be "the scout share or nothing", which was the same thing until a line could plan one
  // parent per scout — so this now asserts the behaviour rather than the old expression, and
  // linePlannedShare is what guarantees an UNPLANNED adult head still falls back to zero.
  ok(/: linePlannedShare\(r\.line, who\);/.test(fn[0]),
    'the fallback is not what the plan expects from that share');
  const shareCtx = vm.createContext({});
  vm.runInContext(
    `${slice('linePerHead')}\n${slice('linePerFamily')}\n${slice('linePlannedShare')}\n${slice('freshLine')}\n` +
    `${slice('uid')}\nfunction lineBillingRoster() { return [1, 2, 3]; }`, shareCtx);
  const linePlannedShare = shareCtx.linePlannedShare;
  const line = shareCtx.freshLine({ basis: 'per-head', scoutRateCents: 1200, adultRateCents: 1500, siblingRateCents: 800 });
  eq(linePlannedShare(line, 'adult'), 0,
    'an unrecorded adult head is being treated as forgone family income');
  eq(linePlannedShare(line, 'sibling'), 0, 'a sibling head is never planned income');
  ok(linePlannedShare(line, 'scout') > 0, 'the scout share must still have a planning figure');
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
  const fn = /function tierShortfallRows\(t, map\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'tierShortfallRows() not found');
  ok(!/function tierMissedRows/.test(SCRIPT),
    'the old name is back — a function called "missed" must not answer for a tier still open');
  ok(/var totals = computeScoutTotals\(t\.dueBy\);/.test(fn[0]), 'the shortfall is measured on the wrong date');
  ok(/short = Math\.max\(0, \(t\.thresholdCents \|\| 0\) - base\)/.test(fn[0]), 'the shortfall is not the gap to the tier');
  // On the commission basis the gap is money, so paying it leaves the pack exactly where the
  // selling would have. Measuring it in SALES is what would over-charge the family.
  ok(/var got = scoutCommissionOf\(\{ t: totals\[s\.id\] \}\);/.test(fn[0]),
    'the shortfall is measured in sales, so a family would be asked for more than the pack lost');
  ok(/makeup: Math\.min\(short, cover\)/.test(fn[0]), 'the makeup is not capped at the fee');
  // The gate `if (!t.dueBy) return []` used to live here, and its reason was sound: a tier that is
  // still open has not been MISSED by anybody, and a function named for missing one must not
  // answer for it. That requirement is unchanged — it is now met by the NAME (a shortfall is what
  // every scout below a threshold has, deadline or not) and by keeping the deadline framing at the
  // one call site that prints it. Pin those two things instead of the refusal, because the refusal
  // also blocked the owner's ask: let a scout cover the remaining cost out of pocket at any time.
  ok(!/if \(!t\.dueBy\) return \[\];/.test(fn[0]),
    'the deadline gate is back, so an open tier offers no shortfall to pay');
  const report = /Missed the ' \+ esc\(fmtDate\(t\.dueBy\)\)[\s\S]{0,80}/.exec(SCRIPT);
  ok(report, 'the deadline report heading was not found');
  ok(/if \(tierIsClosed\(t\) && tierCoverCentsPerScout\(t\) > 0\) \{/.test(SCRIPT),
    'the "Missed the deadline" report is no longer gated on the deadline having passed');
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
  // Cumulative, because the tiers stack and so does what a scout at that level walks away with —
  // and UNIONED, not summed. ⚠ This test used to require the sum (`cents += tierCoverCentsPerScout`),
  // which counts a line named on two rungs twice: Pack 569's break-even claimed $629 handed back
  // against a real $582, $47 of coverage the pack was asked to fund twice.
  const cum = /function tierCumulativeCoverCents\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(cum && /if \(o\.thresholdCents <= t\.thresholdCents\) arrOf\(o\.covers\)/.test(cum[0]),
    'the break-even ignores what the tiers below already hand out');
  ok(cum && /return coverValueOfKeys\(keys\);/.test(cum[0]),
    'the break-even sums per-rung figures, double-counting a line two rungs both name');
  ok(/A scout gets there on/.test(SCRIPT), 'the sales figure is never shown');
  // Converted at the same rate as the goal, so the two cannot disagree.
  const conv = /function salesForCommission\(cents\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(conv, 'salesForCommission() not found');
  ok(/salesAtRate\(cents, commissionRates\(\)\.goal\)/.test(conv[0]),
    'the sales figure uses a different rate from the goal');
  // The arithmetic moved to salesAtRate when the progress card started quoting every rate.
  // Both readers round the same way or a scout lands a cent short of the tier at one of them.
  const rate = /function salesAtRate\(cents, pct\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(rate, 'salesAtRate() not found');
  ok(/Math\.ceil\(cents \/ \(pct \/ 100\)\)/.test(rate[0]),
    'a minimum is being rounded down, which can land a scout a cent short of the tier');
  ok(/if \(pct == null \|\| pct <= 0 \|\| !cents\) return null;/.test(rate[0]),
    'a rate of nought would divide by zero rather than declining to answer');
});

/* ========================================================================
   A commission gap, said in selling — 2026-08-31
   ===================================================================== */

// Owner ask: "instead of showing what they need to earn in commission, just show what they need
// to sell, at each commission rate." sellingRoutes is that conversion.
function routesCtx(base, online, cashPct, viaTE) {
  const ctx = vm.createContext({
    state: { commissionPct: base, commissionPctOnline: online, cashScoutPct: cashPct, cashThroughTrailsEnd: !!viaTE }
  });
  vm.runInContext(slice('commissionRates') + slice('cashScoutRate') + slice('cashCreditOn') +
    slice('salesAtRate') + slice('sellingRoutes'), ctx);
  return (cents) => vm.runInContext(`sellingRoutes(${cents})`, ctx);
}

test('a gap is quoted at every rate the pack earns at, safest figure first', () => {
  // $60 of commission short. At 30% that is $200 of popcorn; at 35%, $171.43 — and the bigger
  // number leads, because it is the one that gets there whatever the scout sells.
  const routes = routesCtx(30, 35, '', false)(6000);
  eq(routes.map((r) => r.cents), [20000, 17143], 'the shortcut is quoted ahead of the safe figure');
  eq(routes.map((r) => r.pct), [30, 35], 'the rates do not match their figures');
  eq(routes.map((r) => r.label), ['at a storefront or wagon', 'online'],
    'the channels are unnamed, so two bare figures look arbitrary');
  // Same floor as the goal conversion: a minimum that lands a cent short is not a minimum.
  ok(routes[1].cents * 0.35 >= 6000, 'the online figure rounds down, landing a scout short of the tier');
});

test('one rate is one figure, and the row says so instead of repeating it', () => {
  const routes = routesCtx(30, 30, '', false)(6000);
  eq(routes.length, 1, 'a pack with one rate is offered a choice it does not have');
  eq(routes[0].label, 'in popcorn', 'the single-rate label reads as a channel');
  eq(routes[0].pct, 30, 'the rate is wrong');
  // A pack that typed only an online rate earns nothing at a storefront, so calling that figure
  // "in popcorn" would send a scout to the wrong shift.
  const onlineOnly = routesCtx('', 40, '', false)(6000);
  eq(onlineOnly.map((r) => [r.label, r.cents]), [['online', 15000]],
    'an online-only pack is told to work a storefront');
});

test('which channel pays better is derived, never assumed to be online', () => {
  // Owner correction, 2026-08-31: this pack's ONLINE rate is the LOWER of the two, and copy that
  // told a scout to sell online to arrive sooner was sending them the slower way round. The app
  // already knew — commissionRates().goalIsOnline is true exactly when online is the lower rate —
  // the prose just was not asking.
  const tiers = /function renderRewardTiers\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(tiers, 'renderRewardTiers() not found');
  ok(/be\.goalIsOnline \? 'at a storefront or on a wagon' : 'online'/.test(tiers[0]),
    'the better-rate sentence names a channel without checking which one it is');
  // tierBreakEven has to carry the flag, or the branch above is reading undefined and always
  // taking the same side — which is the bug, silently restored.
  const be = /function tierBreakEven\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(be && /goalIsOnline: rates\.goalIsOnline/.test(be[0]), 'the break-even drops the flag the copy branches on');
  // And nowhere on these surfaces is "online" hard-wired to the encouraging half of a sentence.
  for (const fn of ['renderRewardTiers', 'renderTierProgress', 'sellingRoutes']) {
    const src = new RegExp(`function ${fn}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT);
    ok(!/online[^']*(sooner|faster|better|ahead)/i.test(codeOnly(src[0])),
      `${fn} still promises that selling online gets a scout there sooner`);
  }
  // The progress card's own two figures are ordered by SIZE, not by channel, so the safe one
  // leads whichever rate happens to be lower.
  const routes = routesCtx(35, 30, '', false)(6000);   // online the LOWER rate, as this pack has it
  eq(routes.map((r) => r.label), ['online', 'at a storefront or wagon'],
    'the bigger figure does not lead when online is the lower rate');
  eq(routes[0].cents, 20000, 'the safe figure is not the one worked out at the lower rate');
});

test('the cash credit rate is never quoted as a rate of its own', () => {
  // Owner ruling, 2026-08-31: it is always set to the storefront rate, so a third line quoting
  // the same figure under another name is clutter — and worse, it implies a difference that
  // never exists. The credit itself is untouched; only the copy is.
  eq(routesCtx(30, 35, 50, false)(6000).map((r) => r.label), ['at a storefront or wagon', 'online'],
    'cash is quoted as a route of its own');
  eq(routesCtx(30, 30, 50, false)(6000).length, 1, 'cash reappears as a second route on a one-rate pack');
  ok(routesCtx(30, 35, 50, false)(6000).every((r) => r.sell),
    'a non-selling route is being handed to the card, which takes its headline from the first entry');
  // Nor anywhere else on the tier surfaces. The forbidden thing is the RATE, not the word: the
  // channel is still called "cash donations" wherever the pack runs it through Trail's End, and
  // cashScoutCredit still pays the credit. Reads CODE, not prose — the warning comments that
  // record this ruling name the very field they forbid.
  for (const fn of ['renderRewardTiers', 'sellingRoutes', 'renderTierProgress']) {
    const src = new RegExp(`function ${fn}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT);
    ok(src, `${fn}() not found`);
    ok(!/\.cash\b|cashScoutRate|cashScoutPct/.test(codeOnly(src[0])),
      `${fn} still quotes the cash credit rate`);
  }
});

test('a pack with no usable rate is offered no figure at all, rather than a wrong one', () => {
  eq(routesCtx('', '', '', false)(6000), [], 'a sell figure was invented with no rate to derive it from');
  // 0% divides to Infinity. tierRateMissing() does NOT catch this — 0 is a rate that was typed —
  // so the routes list is the thing that has to decline, and the card falls back to commission.
  eq(routesCtx(0, 0, '', false)(6000), [], 'a nought rate produced a figure');
  const card = /function renderTierProgress\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/if \(!r\.routes\.length\) segs\.push/.test(card), 'the row says nothing at all when no rate can convert the gap');
  ok(/r\.sellRoutes\.length \? r\.sellRoutes\[0\]\.cents : r\.short/.test(card),
    'the headline figure has no fallback, so it prints a dash for a pack with a nought rate');
});

test('sales-to-reach-a-tier is quoted at the rate a scout can always beat', () => {
  // The conversion has to be a floor, not an estimate: sell this much and you are there
  // whatever the channel mix, because every other channel earns more per dollar.
  const ctx = vm.createContext({ state: {} });
  vm.runInContext(slice('commissionRates') + slice('cashScoutRate') + slice('cashCreditOn') + slice('salesForCommission') + slice('salesAtRate'), ctx);
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
  // It became a block when it learned about a planned parent, so match to its own closing brace
  // at function indent — the previous single-line match would now silently find nothing.
  const fam = /function lineFamilyPlanned\(l\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fam, 'lineFamilyPlanned() not found');
  ok(/linePlannedShare\(l, 'scout'\)/.test(fam[0]) && !/leaderRateCents/.test(fam[0]),
    'what families are billed includes a leader rate');
  const shareBlk = /function linePlannedShare\(l, who\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(shareBlk && !/leaderRateCents/.test(shareBlk[0]), 'a planned SHARE includes a leader rate');
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

test('proseText escapes first and only ever emits tags it built', () => {
  // A section body is prose a leader typed into a textarea and it is republished verbatim to
  // every parent in the pack. If anything here can emit an attacker-chosen tag, the parent
  // view is the delivery mechanism.
  const ctx = sandbox(['esc', 'proseText']);
  const run = (s) => ctx.proseText(s);
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
  // A HEADING LINE FOLLOWED BY BULLETS MUST NOT LOSE THE HEADING. That requirement is unchanged
  // and is what these assertions exist for. What changed is how it is met.
  //
  // It used to be met by refusing to build a list at all: the old all-or-nothing test
  // (`bullets.length === lines.length`) failed on any mixed block, so the whole thing fell to
  // <p>…<br>…</p> and the heading was safe because NOTHING was marked up. The old assertions
  // pinned that symptom — `indexOf('<ul') === -1`, and the literal `'Sleeping<br>- pad'` — rather
  // than the requirement. The cost was that the shape people actually write came out as a solid
  // paragraph with literal hyphens in it, on the page a parent reads once, on a phone, while the
  // textarea's own placeholder promised "start a line with - for a bullet".
  //
  // Runs honour the requirement properly: the heading becomes its own element and the bullets
  // become a real list. So the assertions now pin the requirement — the heading survives, and it
  // is never swallowed into an <li> — plus the thing the old shape could not deliver.
  const mixed = run('Sleeping\n- pad\n- bag');
  ok(mixed.includes('Sleeping'), 'the mixed block lost its heading');
  ok(!/<li>[^<]*Sleeping/.test(mixed), 'the heading was swallowed into a list item');
  ok(mixed.includes('<ul class="camp-list">'), 'the bullets under a heading are still not a list');
  ok(!/[-•]\s/.test(mixed), 'a literal dash is still being rendered to the reader');
  eq(run('Sleeping\n- pad'),
    '<p class="camp-sub">Sleeping</p><ul class="camp-list"><li>pad</li></ul>',
    'a one-line heading over a list is not a label plus a list');
  // The label treatment must not swallow a real lead-in SENTENCE — terminal punctuation is the
  // test, so a Youth Protection preamble stays a paragraph instead of becoming small caps.
  ok(run('This part is not flexible.\n- one').startsWith('<p>This part is not flexible.</p>'),
    'a punctuated lead-in sentence was demoted to a small-caps label');
  // Runs alternate correctly, and trailing prose after a list is its own paragraph. ('one' is
  // short, unpunctuated and introduces the list, so it IS a label — that is the heuristic, not a
  // slip. 'three' follows the list and introduces nothing, so it stays a paragraph.)
  eq(run('one\n- two\nthree'),
    '<p class="camp-sub">one</p><ul class="camp-list"><li>two</li></ul><p>three</p>',
    'runs are not being grouped by kind');
  // A long lead-in is prose even without terminal punctuation — 48 chars is the cut.
  ok(run('Everything in this list is provided by the pack for you\n- one').startsWith('<p>Everything'),
    'a long lead-in line was demoted to a small-caps label');
  eq(run('a\r\nb'), '<p>a<br>b</p>', 'CRLF from a pasted document is not handled');
});

test('the seeded trips are real content, and are seeded exactly once', () => {
  const ctx = sandbox(NORMALIZE_FNS);
  const trips = ctx.seedCampingTrips();
  eq(trips.length, 3, 'the two council weekends and the pack\u2019s own Fort Yargo trip are seeded');
  trips.forEach((t) => {
    ok(t.id && t.name && t.where && t.address, `${t.name}: missing header fields`);
    ok(t.sections.length >= 6, `${t.name}: only ${t.sections.length} sections`);
    t.sections.forEach((s) => ok(s.id && s.title && s.body, `${t.name}: an empty section was seeded`));
    // Every id distinct, or the sub-tab strip and every data-sec lookup collide.
    const ids = t.sections.map((s) => s.id);
    eq(new Set(ids).size, ids.length, `${t.name}: duplicate section ids`);
  });
  eq(new Set(trips.map((t) => t.id)).size, 3, 'two of the trips share an id');
  // The pack's own trip carries a STABLE id, because the one-time add below recognises it by id.
  // A uid() here would re-add the trip on every single load.
  ok(trips.some((t) => t.id === 'trip-fort-yargo'), 'the Fort Yargo trip has no stable id');
  // It is pack-run, and the two rules that follow from that are the whole reason it reads
  // differently from the council weekends: BALOO, and no BB or archery.
  const yargo = trips.find((t) => t.id === 'trip-fort-yargo');
  ok(/BALOO/.test(JSON.stringify(yargo)), 'the pack-run trip does not mention BALOO');
  ok(/not approved unit activities/.test(JSON.stringify(yargo)),
    'the pack-run trip does not say why it has no BB or archery');
  // Last year's dates, labelled with their year — the convention the other two already use, so a
  // reader can tell a published date from a confirmed one.
  ok(/\(2026: Fri 27 Mar/.test(yargo.when), 'the Fort Yargo dates are not labelled with their year');
  // The camp is spelled Rainey. Getting this wrong sends a family to the wrong search result.
  ok(/Rainey Mountain/.test(JSON.stringify(trips)), 'Camp Rainey Mountain is not named');
  ok(!/Rainy Mountain/.test(JSON.stringify(trips)), 'the camp is misspelled "Rainy"');

  // A record with no camping key gets the seed...
  const fresh = ctx.normalizeState(preMigrationState());
  eq(fresh.camping.trips.length, 3, 'a pre-camping pack record was not seeded');
  // FRESHCAMPING ITSELF must carry the flag, and asserting it on normalizeState's output cannot
  // show that — the migration sets the flag on the way through, so it is true either way. The path
  // that matters is load()'s OTHER branch: a brand-new record comes from freshState() and is
  // returned WITHOUT being normalized, so nothing else will ever set it.
  // Observed before this was fixed: new pack, delete Fort Yargo, reload, and it was back.
  ok(ctx.freshCamping().yargoAdded === true,
    'freshCamping does not flag the trip as offered — a new pack that deletes it gets it back');
  const freshMinusYargo = Object.assign(ctx.normalizeState(preMigrationState()), {
    camping: { yargoAdded: true, trips: [{ id: 'keep', name: 'Fall', sections: [] }] }
  });
  eq(ctx.normalizeState(freshMinusYargo).camping.trips.length, 1,
    'a pack that deleted Fort Yargo had it pushed back');
  // ...and a pack that has DELETED every trip must never have them pushed back. This covers the
  // one-time Fort Yargo add too: an empty camping tab is a decision, not a gap to fill.
  const emptied = ctx.normalizeState(Object.assign(preMigrationState(), { camping: { trips: [] } }));
  eq(emptied.camping.trips.length, 0, 'something was pushed into a camping tab the pack had cleared');
  ok(emptied.camping.yargoAdded === true, 'the one-time flag was not set, so it will try again next load');
  // A record that already has the two council trips DOES get the third, once.
  const twoTrips = () => Object.assign(preMigrationState(), {
    camping: { trips: [{ id: 'a', name: 'Fall', sections: [] }, { id: 'b', name: 'Spring', sections: [] }] }
  });
  const added = ctx.normalizeState(twoTrips());
  eq(added.camping.trips.length, 3, 'an existing pack did not receive the Fort Yargo trip');
  ok(added.camping.trips.some((t) => t.id === 'trip-fort-yargo'), 'the added trip is not Fort Yargo');
  // ...and only once, however many times normalize runs, and not again if it is then deleted.
  eq(ctx.normalizeState(added).camping.trips.length, 3, 'the trip was added twice');
  const deletedAgain = Object.assign(added, {
    camping: { yargoAdded: true, trips: added.camping.trips.filter((t) => t.id !== 'trip-fort-yargo') }
  });
  eq(ctx.normalizeState(deletedAgain).camping.trips.length, 2,
    'a deliberately deleted Fort Yargo trip came back');
  // Junk is coerced rather than thrown away or trusted.
  // yargoAdded pre-set: this case is about COERCING junk, and letting the one-time add fire here
  // too would mean counting two different behaviours in one assertion.
  const messy = ctx.normalizeState(Object.assign(preMigrationState(), {
    camping: { yargoAdded: true, trips: [{ name: 7, sections: [{ title: 'ok' }, null, 'nope'] }, null, 'nope'] }
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

test('every paid-direct line is named, however many payees there are', () => {
  // The owner, looking at "Families pay $1,040.00 straight to somebody else this year — Council":
  // "I don't know where this is coming from." Four lines fed that total and the page named none
  // of them, because the breakdown rendered only when there were TWO OR MORE payees — and a
  // pack's paid-direct lines nearly all go to the same council. An unarguable figure with
  // nothing behind it is worse than either half on its own.
  const fn = /function familyDirectByPayee\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'familyDirectByPayee() not found');
  ok(/lines: \[\]/.test(fn[0]) && /cents: cents, line: l/.test(fn[0]),
    'the payee groups do not carry each line’s own figure');
  ok(!/names: \[\]/.test(fn[0]), 'the old names-only array is still there');
  // The card must not gate the breakdown on the payee count any more.
  const card = /if \(bud\.familyDirect > 0\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(card, 'the paid-direct card was not found');
  ok(!/if \(fdBy\.length > 1\) \{/.test(card[0]),
    'the itemised list is still conditional on there being several payees');
  ok(/var fdOne = fdBy\.length === 1;/.test(card[0]), 'the single-payee case is not distinguished');
  // One payee → a flat list of lines. Several → payee subtotals with the lines nested.
  ok(/return fdOne \? kids/.test(card[0]), 'a single payee does not get a flat list of its lines');
  ok(/<ul style="margin:2px 0 0;padding-left:18px">' \+ kids/.test(card[0]),
    'several payees do not nest their lines under the subtotal');
  ok(!/this year' \+\s*\n?\s*\(fdOne \? ' — ' \+ esc\(fdBy\[0\]\.payee\) \+ '\.' : \(fdBy\.length \? ':' : '\.'\)\)/.test(card[0]),
    'the dangling colon before the next sentence is back');
});

test('what one family pays direct is computed per family, never by division', () => {
  // Owner ask: show the per-family cost too. The total divided by families would be a number no
  // family ever pays — a den-limited event reaches only some of them, a per-head fee is paid once
  // per scout, and a per-family fee once however many scouts they bring.
  const ctx = vm.createContext({});
  vm.runInContext(
    `${slice('familyKeyOf')}
     ${slice('familiesOf')}
     ${slice('activeFamilies')}
     ${slice('scoutsInDens')}
     ${slice('linePerHead')}
     ${slice('linePerFamily')}
     ${slice('lineThroughPack')}
     ${slice('familyDirectPerFamily')}
     ${slice('familyDirectPerDen')}
     ${slice('DENS')}
     function activeScouts() { return SCOUTS; }
     function allBudgetLines() { return LINES.map(function (l) { return { kind: 'activity', line: l }; }); }
     function lineDens(l) { return l.dens || []; }`, ctx);
  ctx.SCOUTS = [
    { id: 'a', den: 'Lion' }, { id: 'b', den: 'Wolf', familyId: 'a' },   // one family, two scouts
    { id: 'c', den: 'Tiger' }, { id: 'd', den: '' }
  ];
  ctx.LINES = [
    { name: 'Fall camp', basis: 'per-head', scoutRateCents: 3500, paidDirectTo: 'Council', dens: [] },
    { name: 'Spring camp', basis: 'per-family', scoutRateCents: 3500, paidDirectTo: 'Council', dens: [] },
    { name: 'Tigermania', basis: 'per-head', scoutRateCents: 2000, paidDirectTo: 'Council', dens: ['Lion', 'Tiger'] },
    { name: 'Shirts', basis: 'per-head', scoutRateCents: 1000, paidDirectTo: '', dens: [] } // through the pack
  ];
  const perFam = vm.runInContext('familyDirectPerFamily()', ctx);
  eq(perFam.length, 3, 'the two linked scouts must count as ONE family');
  const byFirstDen = {};
  perFam.forEach((f) => { byFirstDen[f.scouts[0].den || 'none'] = f.cents; });
  // Lion+Wolf: fall 35x2 + spring 35 once + tigermania 20 for the Lion only = 125
  eq(byFirstDen.Lion, 12500, 'a per-head fee is not doubled for a two-scout family, or the per-family fee is');
  eq(byFirstDen.Tiger, 9000, 'Tiger: 35 + 35 + 20');
  eq(byFirstDen.none, 7000, 'a scout with no den is in no den-limited event: 35 + 35');
  // A line the pack collects must never appear in a paid-direct figure.
  ok(!perFam.some((f) => f.cents % 1000 === 0 && f.cents === 1000), 'a through-the-pack line leaked in');
  // THE INVARIANT: with every direct line priced per head or per family, the family totals add
  // up to the pack-wide figure. If they ever diverge, one of the two is lying.
  const total = perFam.reduce((n, f) => n + f.cents, 0);
  eq(total, 12500 + 9000 + 7000, 'the per-family figures do not sum to the pack total');
  // Per den, for a one-scout family.
  const perDen = vm.runInContext('familyDirectPerDen()', ctx);
  eq(perDen.map((d) => d.den + ':' + d.cents),
    ['Lion:9000', 'Tiger:9000', 'Wolf:7000', 'no den set:7000'],
    'the per-den figures are wrong, or an empty den was quoted a price');
  // A flat line is a pack-wide figure, not a family price — it must not be attributed.
  ctx.LINES = [{ name: 'Flat thing', basis: 'flat', flatCents: 50000, paidDirectTo: 'Council', dens: [] }];
  eq(vm.runInContext('familyDirectPerFamily()', ctx).length, 0,
    'a flat paid-direct line was split across families, which invents a price nobody was quoted');
});

test('Home pairs two figures measured against the same thing', () => {
  // The owner, on a pack with last year's money banked and nothing sold: "$3,778.11 Funds in ·
  // 0% Of goal — this does not seem correct, that is our carryover, not funds earned or a
  // percent of our goal." Both halves of the objection were right. Funds in is carryover PLUS
  // commission PLUS fees collected PLUS other fundraisers — a Budget-page figure that only
  // reads correctly beside the formula the Budget page prints under it. Beside a sales-goal
  // percentage it looks like $3,778 of progress that counts for nothing.
  const card = /\/\* ----- Needs you ----- \*\/[\s\S]*?Looking ahead: /.exec(SCRIPT);
  ok(card, 'the Needs you card was not found');
  // The tile that names the goal's BASE must be there — but not under the label "Sold", which
  // claimed the figure was sales when teEligible also carries online (and sometimes cash)
  // donations. It is the numerator of the "Of goal" percentage beside it, so it is labelled for
  // that. The assertion pins the intent (a tile, off teEligible, named for what it measures)
  // rather than one particular word.
  ok(/<span class="l">Toward goal<\/span>/.test(card[0]), 'Home does not show what the goal is measured against');
  ok(!/<span class="l">Sold<\/span>/.test(card[0]), '"Sold" is back — teEligible is not sales');
  ok(/fmt\(packT\.teEligible\)/.test(card[0]), 'the goal-base tile is not the Trail’s End eligible figure');
  ok(!/fmt\(bud0\(\)\.fundsIn\)/.test(card[0]), 'the Funds in tile is back beside a goal percentage');
  ok(!/<span class="l">Funds in<\/span>/.test(card[0]), 'the Funds in label is back on Home');
  // Both tiles now come off teEligible/teGoal, so they can never disagree.
  ok(/var soldPct = packT\.teGoal > 0 \? Math\.min\(100, Math\.round\(packT\.teEligible \/ packT\.teGoal \* 100\)\)/.test(card[0]),
    'the percentage is derived from something other than the Sold figure');
  // The carryover is still reported — as what it is, and only when there is one.
  ok(/bud0\(\)\.startingBalance > 0/.test(card[0]), 'the carryover is shown even when there is none');
  ok(/carried over from last year is already in the bank, and was never part of this year’s goal/.test(card[0]),
    'the carryover is not explained as being outside the goal');
  // No goal yet is a different sentence from 0% of a goal.
  ok(/No Trail’s End goal yet/.test(card[0]), 'a pack with no goal is shown a bare em dash with no explanation');
  // The Budget page keeps Funds in — there it sits directly above its own formula.
  ok(/<span class="l">Funds in<\/span>/.test(SCRIPT), 'the Budget page lost its Funds in stat');
  ok(/<strong>Funds in<\/strong> = carryover \(/.test(SCRIPT), 'the Funds in formula is gone');
});

test('the A/B/C worksheet can wrap its labels, and groups its rows', () => {
  // The owner asked for the breakdown to be explained — because on a phone he could not SEE it.
  // The global `th, td { white-space: nowrap }` is right for the data grids (they sit in a
  // .tbl-wrap and scroll sideways), but this table has no wrapper, so the long leaders row
  // pushed it to 542px inside a 349px card and the whole amount column was clipped off-screen
  // with no scrollbar and no fade cue. Measured before: 542/349 overflowing, document 569px wide
  // in a 375px viewport. After: 321/349, document 375px.
  ok(/th, td \{[^}]*white-space: nowrap;/.test(SCRIPT_CSS),
    'the global nowrap is gone — if it was removed on purpose this test is the wrong guard');
  ok(/\.fund-tbl td:not\(\.num\) \{ white-space: normal; \}/.test(SCRIPT_CSS),
    'the worksheet labels cannot wrap, so a long one clips the amounts off-screen');
  ok(/\.fund-tbl td\.num \{[^}]*white-space: nowrap;/.test(SCRIPT_CSS),
    'money is allowed to break across lines');
  // Two kinds of indented row live here and they must not look alike: "…of which" rows break
  // A down (adding them double-counts), the rest sum to B.
  ok(/<tr class="fund-grp"><td colspan="2">Income<\/td><\/tr>/.test(SCRIPT),
    'nothing separates the rows that sum to B from the ones that break down A');
  ok(/\.fund-tbl \.fund-grp td \{/.test(SCRIPT_CSS), 'the group label row has no style');
  // The group header must sit ABOVE the first income row, not anywhere else.
  const tbl = /<table class="tbl fund-tbl">[\s\S]*?<\/table>/.exec(SCRIPT);
  ok(tbl, 'the worksheet table was not found');
  const grpAt = tbl[0].indexOf('fund-grp');
  const leadersAt = tbl[0].indexOf('leaders\\u2019 places');
  const carryAt = tbl[0].indexOf('Carryover from last year');
  ok(grpAt > leadersAt && grpAt < carryAt,
    'the Income label is not between the last "…of which" row and the first income row');
});

test('a year of Scouting, priced for a family that earns no tier', () => {
  // Owner ask: what does a year cost a family if they reach no tiers? Every other family figure
  // in this app is netted down by something (a tier's covers leave B, earned coverage stops
  // standing, the pack fronts and recovers). This one is deliberately GROSS — the most a family
  // can be asked for, which is the number you quote to somebody deciding whether they can join.
  const ctx = vm.createContext({ state: { rewardTiers: { tiers: [] } } });
  vm.runInContext(
    `${slice('scoutsInDens')}
     ${slice('linePerHead')}
     ${slice('linePerFamily')}
     ${slice('lineThroughPack')}
     ${slice('lineFamilyFunded')}
     ${slice('arrOf')}
     ${slice('sortedTiers')}
     ${slice('coverKeyOf')}
     ${slice('allTierCoverKeys')}
     ${slice('familyYearCostForDen')}
     ${slice('familyYearCost')}
     ${slice('DENS')}
     function activeScouts() { return SCOUTS; }
     function allBudgetLines() { return LINES.map(function (l) { return { kind: 'activity', line: l, key: l.name }; }); }
     function lineDens(l) { return l.dens || []; }
     function salesForCommission(c) { return c * 3; }`, ctx);
  ctx.SCOUTS = [{ id: 'a', den: 'Wolf' }, { id: 'b', den: 'Lion' }, { id: 'c', den: '' }];
  ctx.LINES = [
    { name: 'Registration', basis: 'per-head', scoutRateCents: 8500, fundedBy: 'families', paidDirectTo: '', dens: [] },
    { name: 'Blue & Gold', basis: 'per-head', scoutRateCents: 4200, adultRateCents: 5600, siblingRateCents: 2000, fundedBy: 'families', paidDirectTo: '', dens: [] },
    { name: 'Spring camp', basis: 'per-head', scoutRateCents: 3500, fundedBy: 'families', paidDirectTo: 'Council', dens: [] },
    { name: 'Tigermania', basis: 'per-head', scoutRateCents: 2000, fundedBy: 'families', paidDirectTo: 'Council', dens: ['Lion', 'Tiger'] },
    { name: 'Fall campout', basis: 'per-family', scoutRateCents: 3000, adultRateCents: 9900, fundedBy: 'families', paidDirectTo: '', dens: [] },
    { name: 'Charter fee', basis: 'flat', flatCents: 10000, fundedBy: 'pack', paidDirectTo: '', dens: [] },
    { name: 'Awards', basis: 'per-head', scoutRateCents: 4900, fundedBy: 'pack', paidDirectTo: '', dens: [] },
    { name: 'Flat family thing', basis: 'flat', flatCents: 7700, fundedBy: 'families', paidDirectTo: '', dens: [] }
  ];
  const wolf = vm.runInContext("familyYearCostForDen('Wolf')", ctx);
  // 85 + 42 + 35 + 30 = 192. NOT the Tiger-only event, NOT the two pack-funded lines, and NOT
  // the flat family line — a flat figure is a pack-wide total, not a per-family price.
  eq(wolf.scout, 19200, 'a Wolf: 85 registration + 42 banquet + 35 spring camp + 30 per-family campout');
  // OWNER RULING: one adult per scout is EXPECTED, not optional — a Cub Scout does not attend
  // alone. So the headline is scout + adult, and pricing only the scout is wrong by the whole
  // adult column.
  eq(wolf.adult, 5600, 'only Blue & Gold prices an adult; the per-family line must not');
  eq(wolf.expected, 24800, 'the expected cost is the scout AND the one adult who brings them');
  eq(wolf.throughPack, 21300, 'through the pack: 85 + (42+56) + 30');
  eq(wolf.direct, 3500, 'paid direct: the 35 spring camp, which prices no adult');
  eq(wolf.throughPack + wolf.direct, wolf.expected,
    'the two halves must add up to the EXPECTED figure, or the expansion ties to nothing on screen');
  // A per-family line prices ONE fee for whoever comes, so it contributes no adult or sibling.
  eq(wolf.lines.find((l) => l.name === 'Fall campout').adult, 0,
    'a per-family line must not add an adult price on top of its single fee');
  eq(wolf.sibling, 2000, 'only Blue & Gold prices a sibling — siblings stay out of the headline');
  ok(!wolf.lines.some((l) => l.name === 'Charter fee' || l.name === 'Awards'),
    'a line the pack pays costs a family nothing and must not be listed');
  ok(!wolf.lines.some((l) => l.name === 'Flat family thing'), 'a flat line was priced per family');
  // A den-limited event reaches only its dens.
  const lion = vm.runInContext("familyYearCostForDen('Lion')", ctx);
  eq(lion.expected - wolf.expected, 2000, 'the Lion should pay Tigermania and the Wolf should not');
  const none = vm.runInContext("familyYearCostForDen('')", ctx);
  eq(none.expected, wolf.expected, 'a scout with no den is in no den-limited event, like the Wolf');
  // One row per den that HAS scouts — never a price for an empty rank.
  const rows = vm.runInContext('familyYearCost()', ctx);
  eq(rows.map((r) => r.den), ['Lion', 'Wolf', ''], 'a den with nobody in it was quoted a price');
  eq(wolf.covered, 0, 'a pack with no tiers covers nothing');

  // WHAT THE LADDER TAKES OFF IT. Three rungs that stack, two of them pointed at the same
  // banquet — the union, valued once, den-aware, scout and adult only.
  ctx.state.rewardTiers.tiers = [
    { id: 'a', name: 'a', thresholdCents: 15000, covers: ['Registration'] },
    { id: 'b', name: 'b', thresholdCents: 33000, covers: ['Blue & Gold', 'Tigermania'] },
    { id: 'c', name: 'c', thresholdCents: 41500, covers: ['Blue & Gold', 'Blue & Gold#adult'] }
  ];
  const wolf2 = vm.runInContext("familyYearCostForDen('Wolf')", ctx);
  // 85 registration + 42 banquet + 56 the banquet's adult. NOT Tigermania — no Wolf attends it,
  // and NOT the largest single rung ($98), which is the bug this replaced.
  eq(wolf2.covered, 18300, 'the union of every rung, counting the twice-named banquet once');
  eq(wolf2.expected - wolf2.covered, 6500, 'what a Wolf family still pays with every tier earned');
  const lion2 = vm.runInContext("familyYearCostForDen('Lion')", ctx);
  eq(lion2.covered - wolf2.covered, 2000, 'a Lion, who does attend Tigermania, is covered for it');

  // RUNG BY RUNG, for this den. Wolf year = 24800; rung a covers registration (8500) → 16300 left;
  // rung b adds the banquet (4200) and Tigermania, which a Wolf does not attend → 12100; rung c
  // names the banquet AGAIN (nothing new) and its adult share (5600) → 6500.
  eq(wolf2.steps.map((s) => s.afterCents), [16300, 12100, 6500], 'what a Wolf year drops to at each rung');
  eq(wolf2.steps.map((s) => s.coveredCents), [8500, 12700, 18300], 'cover accumulates down the rungs');
  eq(wolf2.steps.map((s) => s.name), ['a', 'b', 'c'], 'the rungs are listed lowest threshold first');
  eq(wolf2.steps[0].salesCents, 45000, 'the sell figure is the threshold converted, not the threshold');
  // The Lion attends Tigermania, so the SAME rung is worth 2000 more to them.
  eq(lion2.steps.map((s) => s.afterCents), [18300, 12100, 6500], 'a Lion’s rungs price their own year');
  // A rung with no name is not listed — the ladder card hides it too — but its covers still
  // ACCUMULATE, or every rung above it would be quoted a year that is too high.
  ctx.state.rewardTiers.tiers.splice(1, 0, { id: 'x', thresholdCents: 20000, covers: ['Spring camp'] });
  const named = vm.runInContext("familyYearCostForDen('Wolf')", ctx);
  eq(named.steps.map((s) => s.name), ['a', 'b', 'c'], 'an unnamed rung was listed');
  eq(named.steps.map((s) => s.afterCents), [16300, 8600, 3000], 'an unnamed rung’s covers were dropped');
  // A covered SIBLING share must not come off a figure that never counted a sibling.
  ctx.state.rewardTiers.tiers = [{ id: 'a', thresholdCents: 15000, covers: ['Blue & Gold#sibling'] }];
  eq(vm.runInContext("familyYearCostForDen('Wolf')", ctx).covered, 0,
    'a sibling share was taken off the scout-and-adult figure');
});

test('the year-cost card says what it excludes, and points at the tiers', () => {
  const fn = /function renderFamilyYearCost\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'renderFamilyYearCost() not found');
  const flat = fn[0].replace(/'\s*\+\s*'/g, '');
  ok(/no reward tier at all/.test(flat), 'the card does not say the figure assumes no tier is earned');
  ok(/nothing the pack pays for out of its own funds/.test(flat),
    'the card does not say pack-funded lines are excluded');
  // The owner's correction: one adult per scout is expected, and the card has to say both that
  // it counts one per scout AND that a two-scout family only has to send one parent — otherwise
  // the figure looks like it is double-charging them.
  ok(/one scout and the adult who brings them/.test(flat),
    'the headline does not say it includes the accompanying adult');
  ok(/counted <strong>per scout<\/strong>/.test(flat), 'the per-scout adult rule is not stated');
  ok(/two scouts only has to send one parent/.test(flat),
    'the card does not admit that a two-scout family needs only one parent');
  ok(/Siblings are extra/.test(flat), 'the card does not say siblings are optional');
  // The three tier states, because "you have tiers but none is planned on" is the one that
  // silently makes the funding worksheet wrong — it must not read the same as having none.
  ok(/No reward tiers set yet/.test(fn[0]), 'the no-tiers case is not handled');
  ok(/none is named as the one the plan counts on/.test(fn[0].replace(/' \+\s*'/g, '')),
    'a pack with tiers but no planned tier is not warned');
  ok(/The plan counts on <strong>/.test(fn[0]), 'the planned-tier case is not named');
  // The row is the app's existing expandable pattern, which already has Enter/Space for free.
  ok(/class="list-row' \+ \(open \? ' open' : ''\) \+ '" data-act="year-cost-toggle"/.test(fn[0]),
    'the row is not a .list-row, so keyboard activation will not reach it');
  ok(/\(e\.key === 'Enter' \|\| e\.key === ' '\) && e\.target\.matches\('\.list-row\[data-act\]/.test(SCRIPT),
    'the generic keyboard handler for .list-row is gone');
  // data-name is in SIG_ATTRS, so focus survives the re-render the toggle causes.
  ok(/var SIG_ATTRS = \[[^\]]*'name'/.test(SCRIPT), 'data-name is not a focus signature attribute');
});

test('a reward tier can carry the small print the covers list cannot hold', () => {
  // Owner ask: a stretch tier that reimburses uniform items next year against an itemised
  // receipt, listing the eligible items. `covers` is charges the app can waive and could never
  // express that — so a tier gets prose too, rendered through the same escaped renderer the
  // campout pages use.
  const ctx = sandbox(NORMALIZE_FNS);
  const norm = (tier) => {
    const d = preMigrationState();
    d.rewardTiers = { duesCents: 0, planOnTierId: '', tiers: [Object.assign({ id: 't1', thresholdCents: 73000 }, tier)] };
    return ctx.normalizeState(d).rewardTiers.tiers[0];
  };
  eq(norm({}).note, '', 'a tier with no note must normalize to empty, not undefined');
  eq(norm({ note: '- Neckerchief\n- Handbook' }).note, '- Neckerchief\n- Handbook', 'the note was not kept verbatim');
  eq(norm({ note: 42 }).note, '', 'a non-string note was trusted');
  // Rendered, never trusted: the same escape-first renderer as the campout sections.
  const blk = /function tierNoteBlock\(t\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(blk, 'tierNoteBlock() not found');
  ok(/proseText\(note\)/.test(blk[0]), 'the note is not run through the escaping prose renderer');
  ok(!/innerHTML|' \+ note \+ '/.test(blk[0]), 'the note is interpolated raw somewhere');
  ok(/esc\(note\)/.test(blk[0]), 'the textarea does not escape its own value');
  // A read-only leader sees a note that exists, and no empty furniture when there is none.
  ok(/if \(!canEdit\(\)\) \{\s*\n\s*if \(!note\.trim\(\)\) return '';/.test(blk[0]),
    'a read-only screen shows an empty labelled box');
  // Stored verbatim — trimming would eat the newline before the next bullet.
  const chBlock = /if \(ch === 'tier-name' \|\| ch === 'tier-threshold'[\s\S]*?commit\(\); return;\n    \}/.exec(SCRIPT);
  ok(chBlock && /else if \(ch === 'tier-note'\) tier\.note = el\.value;/.test(chBlock[0]),
    'the note is not saved, or is trimmed on the way in');
  ok(/h \+= tierNoteBlock\(t\);/.test(SCRIPT), 'the block is never rendered');
});

test('the prose renderer is not named after the first thing that used it', () => {
  // It renders campout sections AND reward-tier notes now. A general helper called campText is
  // the kind of thing the next person copy-pastes instead of reusing.
  ok(/function proseText\(s\) \{/.test(SCRIPT), 'proseText() not found');
  // Call sites and declarations only — the comment above proseText names the old function on
  // purpose, because "why is this not called campText" is a question worth having answered.
  ok(!/campText\s*\(/.test(SCRIPT), 'something still calls campText');
  ok(!/function campText/.test(SCRIPT), 'campText is still declared');
});

test('a line priced per person plans the parent, and knows who is paying for them', () => {
  // Owner ask: "the Christmas party is budgeted at $7 per scout but it really needs to be per
  // person — scout + 1 parent + leaders." $7 x 13 scouts + 13 parents + 4 leaders = $210.
  const { linePlannedCents, freshLine } = sandbox(PRICE_FNS);
  const party = freshLine({
    basis: 'per-head', scoutRateCents: 700, adultRateCents: 700,
    includeAdults: true, includeLeaders: true, leaderRateCents: 700
  });
  eq(linePlannedCents(party, 13, 4), 21000, '13 scouts + 13 parents + 4 leaders at $7');
  // Ticking the box prefills the parent rate from the scout rate — one tick and a party is right.
  const ch = /} else if \(bk === 'include-adults'\) \{[\s\S]*?\n      \}/.exec(SCRIPT);
  ok(ch, 'the include-adults handler is missing');
  ok(/if \(bl\.includeAdults && !bl\.adultRateCents\) bl\.adultRateCents = bl\.scoutRateCents \|\| 0;/.test(ch[0]),
    'ticking per-person does not prefill the parent rate, so the line silently plans $0 parents');
  // Absent on an older record → false. It must NOT be inferred from the old assumption field,
  // or every line that once had it quietly puts parents back in the plan.
  const nctx = sandbox(NORMALIZE_FNS);
  const d = preMigrationState();
  const after = nctx.normalizeState(d);
  after.budget.activities.concat(after.budget.expenses).forEach((l) => {
    eq(l.includeAdults, false, `${l.name}: a carried-over line must not plan for parents`);
  });
  const norm = /l\.includeAdults = l\.includeAdults === true;/.exec(SCRIPT);
  ok(norm, 'includeAdults is not normalized to a boolean');
  const migrate = /if \(typeof l\.includeLeaders !== 'boolean'\) \{[\s\S]*?\n      \}/.exec(SCRIPT);
  ok(migrate && !/includeAdults/.test(migrate[0]),
    'includeAdults is inferred from the old adultsFrom field, reviving the bug the July ruling removed');
  // Who pays decides where it lands: pack-pays is spending, families-pay is expected income.
  const rep = /function adultPlannedCents\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(rep, 'adultPlannedCents() not found');
  ok(/if \(lineFamilyFunded\(l\)\) return;/.test(rep[0]),
    'a families-pay parent is reported as pack spending, which double-counts it against the fees row');
  ok(/!l\.includeAdults \|\| linePerFamily\(l\)/.test(rep[0]),
    'it counts lines that plan no parent, or a per-family fee that has no parent head');
  // A rollover must carry the flag or next year's party silently loses half its heads.
  ok((SCRIPT.match(/includeAdults: x\.includeAdults, adultRateCents: x\.adultRateCents,/g) || []).length === 2,
    'the close-out projections drop the per-person flag');
});

/* ========================================================================
   Storefront rows carry their own shift list — 2026-08-02
   ===================================================================== */

// getScout is stubbed: these functions only ever ask it for a name, and a sandbox has no state.
function shiftListCtx(roster) {
  const ctx = sandbox(['esc', 'fmtClock', 'fmtTimeRange', 'blocksInDayOrder', 'blockScoutNames',
    'storefrontShiftLines']);
  vm.runInContext(
    'var ROSTER = ' + JSON.stringify(roster || {}) + ';' +
    'function getScout(id) { return ROSTER[id] ? { id: id, name: ROSTER[id] } : null; }', ctx);
  return ctx;
}
const shiftBlk = (label, start, end, ids) => ({
  id: 'b-' + label, label: label, start: start, end: end,
  assignments: (ids || []).map((id) => ({ scoutId: id, weight: 1 }))
});

test('a storefront shows its shifts in the order the day happens, not the order they were added', () => {
  const ctx = shiftListCtx({});
  const sf = { blocks: [shiftBlk('Block 1', '12:00', '14:00'), shiftBlk('Block 2', '08:00', '10:00'),
    shiftBlk('Block 3', '', ''), shiftBlk('Block 4', '10:00', '12:00')] };
  eq(ctx.blocksInDayOrder(sf).map((b) => b.label),
    ['Block 2', 'Block 4', 'Block 1', 'Block 3'],
    'shift order');
  // The stored array must be untouched: blockShares() hands the rounding remainder to the LAST
  // element it finds, so sorting in place would move real cents onto a different scout.
  eq(sf.blocks.map((b) => b.label), ['Block 1', 'Block 2', 'Block 3', 'Block 4'],
    'blocksInDayOrder mutated the stored blocks');
});

test('the scouts on a shift read alphabetically, whatever order they signed up in', () => {
  const ctx = shiftListCtx({ s1: 'Phoenix Gladden', s2: 'Ada Reyes', s3: 'Bowie Gladden' });
  // The sign-up order here matches NEITHER the alphabetical order nor the id order. With
  // ['s1','s2','s3'] a sort-in-place by id is a no-op, so the guard below passed on code that
  // reordered the stored array — the mutation probe is the only reason that showed up.
  const b = shiftBlk('Block 1', '10:00', '12:00', ['s1', 's3', 's2']);
  eq(ctx.blockScoutNames(b), ['Ada Reyes', 'Bowie Gladden', 'Phoenix Gladden'], 'names');
  // Display only — the stored assignments keep their own order for the same reason as above.
  eq(b.assignments.map((a) => a.scoutId), ['s1', 's3', 's2'],
    'blockScoutNames mutated the stored assignments');
  eq(ctx.blockScoutNames({ assignments: [{ scoutId: 'gone' }] }), ['Unknown scout'],
    'a scout who was deleted still leaves their slot visible');
});

test('every shift gets a line, and an unstaffed one says so', () => {
  const ctx = shiftListCtx({ s1: 'Ada Reyes' });
  const html = ctx.storefrontShiftLines({ blocks: [
    shiftBlk('Block 1', '10:00', '12:00', ['s1']), shiftBlk('Block 2', '12:00', '14:00', [])] });
  // The trailing [ "] matters — the <ul class="sf-shifts"> wrapper is a prefix match otherwise.
  eq((html.match(/class="sf-shift[ "]/g) || []).length, 2, 'one line per shift');
  ok(/10:00 AM–12:00 PM<\/span><span class="sf-who">Ada Reyes/.test(html),
    'a staffed shift shows the time and who is on it');
  ok(/class="sf-shift sf-open"/.test(html), 'an unstaffed shift is marked as open');
  eq((html.match(/>Open</g) || []).length, 1, 'exactly the empty shift reads "Open"');
  // A storefront with no shifts yet must add nothing at all — the summary line already says so.
  eq(ctx.storefrontShiftLines({ blocks: [] }), '', 'no shifts, no list');
});

test('a shift with no time set still shows up, under its block name', () => {
  const ctx = shiftListCtx({});
  const html = ctx.storefrontShiftLines({ blocks: [shiftBlk('Saturday morning', '', '', [])] });
  ok(/Saturday morning/.test(html), 'an untimed shift falls back to its block name');
});

test('the storefront row names itself, instead of reading out its whole shift list', () => {
  // role="button" flattens a row's contents into its accessible NAME, so without an explicit
  // label the shift list becomes forty words of button name.
  const row = /function storefrontRow\(sf\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(row, 'storefrontRow() not found');
  ok(/role="button" tabindex="0" aria-label="/.test(row[0]),
    'the row is a button with no aria-label of its own');
  ok(/shift' \+ \(cov\.total === 1 \? '' : 's'\) \+ ' covered'/.test(row[0]),
    'the spoken label drops the coverage summary, which is the whole point of the row');
});

test('the printable day sheets list shifts in day order too', () => {
  // Both sheets used to walk sf.blocks raw, so a shift added later printed out of sequence —
  // on the sheet that gets carried to the store.
  for (const fn of ['daySheetText', 'renderDaySheet']) {
    const src = new RegExp(`function ${fn}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT);
    ok(src, `${fn}() not found`);
    ok(/blocksInDayOrder\(sf\)/.test(src[0]), `${fn} walks the stored block order`);
    ok(/blockScoutNames\(b\)/.test(src[0]), `${fn} lists the scouts in stored order`);
  }
});

test('the shift list survives a phone, and its times never wrap', () => {
  // A 17-character time range plus two names does not fit 375px, and the half-wrapped
  // two-column form reads as a bug rather than a layout.
  ok(/\.sf-when \{[^}]*white-space: nowrap/.test(SCRIPT_CSS),
    'the time column can wrap, which breaks the straight edge that makes the list scannable');
  ok(/@media \(max-width: 520px\) \{\s*\.sf-shift \{ display: block/.test(SCRIPT_CSS),
    'the shift row keeps its two columns on a narrow screen');
  // Content-sized, every storefront's shift table came out a different width — and the narrow
  // ones fell under the two columns' combined basis and wrapped every single line.
  ok(/\.sf-main \{ flex: 1 1 auto; min-width: 0; \}/.test(SCRIPT_CSS),
    'the shift list is content-sized again, so its width varies per storefront');
});

/* ========================================================================
   The parent standings board says what its two numbers mean — 2026-08-02
   ===================================================================== */

// The claim the footnote makes, tested on the two functions that decide it. Neither figure was
// ever wrong; they answer different questions, and only kept cash can make them disagree.
function goalBaseCtx(viaTE) {
  const ctx = sandbox(['cashDonOf', 'goalBaseOf']);
  vm.runInContext('var state = { cashThroughTrailsEnd: ' + (viaTE ? 'true' : 'false') + ' };', ctx);
  return ctx;
}
// storeD/wagonD are cash handed over in person; onD is an online donation, which always counts.
const donorRow = { t: { sales: 32000, onD: 1000, storeD: 6000, wagonD: 3000 } };

test('cash the pack keeps is the only thing that can split Raised from Of goal', () => {
  const kept = goalBaseCtx(false);
  const combined = donorRow.t.sales + donorRow.t.onD + donorRow.t.storeD + donorRow.t.wagonD;
  eq(kept.goalBaseOf(donorRow), 33000, 'kept cash must stay out of the goal base');
  ok(kept.goalBaseOf(donorRow) < combined,
    'with cash kept, the goal base should fall short of what the scout brought in');
  // Run it through Trail's End and the gap closes — which is why the footnote is conditional.
  const viaTE = goalBaseCtx(true);
  eq(viaTE.goalBaseOf(donorRow), combined, 'through Trail’s End the two figures must agree');
  // A scout with no cash donations never diverges either way.
  const dry = { t: { sales: 32000, onD: 1000, storeD: 0, wagonD: 0 } };
  eq(kept.goalBaseOf(dry), 33000, 'a scout with no cash donations diverges');
});

test('parents see ONE goal, not the pack’s internal cash split', () => {
  // Owner ask, 2026-08-02. Whether a dollar of cash runs through Trail's End or the pack keeps it
  // decides which of the two old bars it landed in, without any family having done anything
  // differently — so a family watched money move between bars for reasons that were not about them.
  const src = codeOnly(BPV());
  ok(/goalCents: goalCents,\s*raisedCents: pack\.combined,/.test(src),
    'the goal is not published as one combined figure');
  ok(!/teGoalCents|cashGoalCents|tePct|cashPct/.test(src),
    'the two-bar split is still published');
  // The identity that makes the single figure safe: teEligible carries cash only when the toggle
  // is ON and cashKept only when it is OFF, so sales + every donation is the whole of it with
  // nothing counted twice. pack.combined IS that sum — asserted here so a future edit cannot
  // quietly swap it for teEligible + cashKept and lose the guarantee.
  ok(/combined: sales \+ don,/.test(SCRIPT), 'pack.combined is no longer sales plus every donation');
  // The flag that explained the old two-number row goes with the column it explained.
  ok(!/cashOutsideGoal/.test(codeOnly(SCRIPT)),
    'the cash-outside-goal flag survives the column it existed to explain');
});

test('every scout on the board gets a progress bar, and it is a list so the bar has room', () => {
  const fn = /function renderParentStandings\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'renderParentStandings() not found');
  // The table this replaced was right when a row was four short figures. A bar needs width, and a
  // 10px track in a fifth column is either unreadably narrow or — on a phone, inside .tbl-wrap —
  // only reachable by swiping the table sideways to find your own scout.
  ok(/rows\.forEach\(function \(r, i\) \{ h \+= parentStandingRow\(r, i, ladder\); \}\);/.test(fn[0]),
    'the board does not render one list row per scout');
  ok(!/tbl-wrap|<th scope="col"/.test(codeOnly(fn[0])),
    'the board is a table again, which puts the bar behind a sideways scroll on a phone');
  // The percentage that needed a footnote is GONE, not hidden: it was measured on goal-eligible
  // money while the money beside it was everything, so the two could not be reconciled at all.
  ok(!/goalPct/.test(fn[0]), 'the of-goal percentage is still on the row');
});

test('the family bar runs to the planned tier, the same one the leaders’ card does', () => {
  const src = codeOnly(BPV());
  // Owner ask, 2026-08-31: both boards on one denominator. Published straight off the row rather
  // than recomputed here — a second ratio in this file is a second thing to keep in step.
  ok(/nextPct: \(p && typeof p\.anchorPct === 'number'\) \? p\.anchorPct : null/.test(src),
    'the bar is measured against something other than the planned tier');
  ok(!/Math\.round\(p\.base \/ p\.need \* 100\)/.test(src),
    'the old next-rung ratio is still being published alongside it');
  // Clamping and the top-of-ladder case moved with it, onto tierProgressRows.anchorPct.
  const rows = /function tierProgressRows\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/Math\.max\(0, Math\.min\(100, Math\.round\(base \/ anchor\.thresholdCents \* 100\)\)\)/.test(rows),
    'the percentage is not clamped to 0-100');
  ok(/anchor && anchor\.thresholdCents > 0/.test(rows),
    'a pack with nothing to measure publishes a figure instead of null');
  // The field NAME is unchanged on purpose: a payload published before this change still renders,
  // just measured the old way, rather than losing every bar until a leader next saves.
  ok(/nextPct:/.test(src), 'the field was renamed, so older payloads lose their bars');
  // The ratio is still taken in commission: salesForCommission divides both halves by the same
  // goal rate, so it is the same ratio in sales terms. Converting per scout would break it,
  // because a scout's own rate depends on their channel mix (online pays differently).
  ok(!/salesForCommission\(p\.base\)|salesForCommission\(p\.need\)/.test(src),
    'the bar converts each side to sales per scout, so it disagrees with the shortfall beside it');
});

test('the family board is told what a full bar means, and can survive not being told', () => {
  const src = codeOnly(BPV());
  ok(/out\.tierLadder = ladderProg;/.test(src), 'the ladder legend is never published');
  ok(/anchorName: String\(progLad\.plan\.name/.test(src), 'the anchor is published without its name');
  // ⚠ Read off the shared ladder, NOT off row zero's own anchor. Rows are ordered by what a scout
  // brought in, so row zero is usually a stretch-cohort row — a legend built from it would name
  // the top rung and describe the exception rather than the rule.
  ok(!/progRows\[0\]\.anchor|progAny\.anchor/.test(src),
    'the legend is built from the top seller’s own scale');
  ok(/progLad\.stretchOn/.test(src), 'the stretch scale is never published');
  ok(/pastPlan: !!\(p && p\.pastPlan\)/.test(src), 'the row does not say which scale it is on');
  ok(/planned: !!plannedTier\(\)/.test(src),
    'the payload cannot tell a planned anchor from the top-of-ladder fallback');
  // Every renderer path has to cope with the field being absent — a pack that has not republished
  // since this shipped serves a payload with no ladder on it at all.
  const list = /function renderParentStandings\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/pv\.tierLadder && typeof pv\.tierLadder === 'object' && !Array\.isArray\(pv\.tierLadder\)/.test(list),
    'the legend trusts the payload to have the shape it expects');
  // parentBar is handed the cohort's own marks rather than the whole ladder — which scale a row
  // is on is parentTierProgress's decision, and the bar should not have to know about cohorts.
  const bar = /function parentBar\(pct, label, marks, planPct\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(bar, 'parentBar() no longer takes the marks and plan boundary');
  ok(/Array\.isArray\(marks\) \? marks : \[\]/.test(bar[0]),
    'the notches are drawn without checking the payload carries any');
  // A payload whose planPct sat above the scout's own percentage would ask for a negative width.
  ok(/planPct >= 0 && planPct <= p/.test(bar[0]), 'the stretch segment can be drawn backwards');
  // And the cohort choice itself degrades: a row flagged pastPlan on a payload with no stretch
  // block published still draws the single-scale bar rather than throwing.
  const prog = /function parentTierProgress\(r, ladder\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var past = !!\(r && r\.pastPlan && stretch\);/.test(prog[0]),
    'a pastPlan row trusts a stretch block that may not have been published');
  // Notches are decoration: each is named once in the legend, so repeating them inside every
  // bar's label would read the whole ladder out once per scout.
  ok(/role="img" aria-label="/.test(bar[0]), 'the bar lost the only thing that reaches a screen reader');
});

test('the progress bar carries its figure in words, and is absent when there is nothing to measure', () => {
  const ctx = sandbox(['esc', 'fmt', 'parentBar', 'parentTierProgress']);
  const mid = ctx.parentTierProgress({ tier: 'Pack tee', nextTier: 'Camp week', nextPct: 43,
    nextReward: 'A week of summer camp, paid', nextSalesCents: 50167, nextUnlocksCents: 3500 });
  ok(/<div class="bar-fill" style="width:43%">/.test(mid), 'the fill does not follow the percentage');
  ok(/43% of the way to <strong>Camp week<\/strong>/.test(mid), 'the caption repeats the figure in words');
  ok(/A week of summer camp, paid/.test(mid), 'the prize in words is dropped — the tier name is only a label');
  ok(/\$501\.67<\/strong> more to sell/.test(mid), 'what is still to sell');
  ok(/\$35\.00<\/span> off your costs/.test(mid), 'what reaching it is worth to this family');
  // A bar carries no text of its own: role="img" plus a label is the only way it reaches a screen
  // reader, and the caption beneath serves everyone else.
  ok(/role="img" aria-label="43 percent of the way to Camp week"/.test(mid),
    'the bar has no accessible label, so it is invisible to a screen reader');
  // Top of the ladder: full bar, plain statement.
  const done = ctx.parentTierProgress({ tier: 'Camp week', nextTier: '', nextPct: 100 });
  ok(/width:100%/.test(done) && /Every tier earned/.test(done), 'a finished ladder');
  // ⚠ ABSENT, not zero-width. An empty track beside a scout who has done everything asked of them
  // would be a lie told by geometry — this is the case where the pack has no tiers, or no rate.
  eq(ctx.parentTierProgress({ tier: '', nextTier: '', nextPct: null }), '',
    'a pack with nothing to measure still draws an empty bar');
  eq(ctx.parentTierProgress({}), '', 'a scout with no progress data still draws a bar');
  // No rate typed: the rung and the bar still show, the invented shortfall does not.
  const noRate = ctx.parentTierProgress({ tier: '', nextTier: 'Dues covered', nextPct: 12,
    nextReward: '', nextSalesCents: null, nextUnlocksCents: 0 });
  ok(/Dues covered/.test(noRate) && !/more to sell/.test(noRate), 'an unmeasurable shortfall invents a figure');
  ok(!/\$0\.00/.test(noRate), 'a prize-only rung claims it is worth nothing off your costs');
});

test('a family sees the stretch scale as two fills, and is told which rung it ends at', () => {
  const ctx = sandbox(['esc', 'fmt', 'parentBar', 'parentTierProgress']);
  // The ladder as published: plan scale for most rows, stretch scale for anyone past Gold.
  const LADDER = {
    anchorName: 'Gold',
    planned: true,
    marks: [{ name: 'Bronze', pct: 25, plan: false }, { name: 'Silver', pct: 50, plan: false }],
    stretch: {
      topName: 'Platinum', planPct: 60,
      marks: [{ name: 'Bronze', pct: 15, plan: false }, { name: 'Silver', pct: 30, plan: false },
              { name: 'Gold', pct: 60, plan: true }]
    }
  };
  const past = ctx.parentTierProgress({ nextTier: 'Platinum', nextPct: 80, pastPlan: true,
    nextReward: 'A week of summer camp, paid', nextSalesCents: 50167, nextUnlocksCents: 3500 }, LADDER);
  // Two fills: the plan complete, then what they have done beyond it.
  ok(/<div class="bar-fill bar-fill-part" style="width:60%">/.test(past),
    'the plan half of the bar is missing, or still drawn as a pill that stops mid-track');
  ok(/<div class="bar-fill-stretch" style="left:60%;width:20%">/.test(past),
    'the stretch segment does not run from the plan boundary to where the scout actually is');
  // The plan notch is the boundary, and is flagged so it can be drawn heavier than a rung.
  ok(/class="tprog-tick is-plan" style="left:60%"/.test(past), 'the plan boundary is an ordinary notch');
  // Caption and spoken label say the same thing, so a screen reader is not given a percentage
  // measured against a rung the sighted caption never names.
  ok(/<strong>Gold<\/strong> met · 80% of the way to <strong>Platinum<\/strong>/.test(past),
    'the caption does not say which rung the percentage is measured against');
  ok(/aria-label="Gold met, 80 percent of the way to Platinum"/.test(past),
    'the spoken label still claims the old scale');

  // A row on the plan scale is untouched by any of it — the majority case, and the regression
  // that would matter most.
  const below = ctx.parentTierProgress({ nextTier: 'Silver', nextPct: 47, nextSalesCents: 3334 }, LADDER);
  ok(/<div class="bar-fill" style="width:47%">/.test(below), 'a plan-scale bar gained a second fill');
  ok(!/bar-fill-stretch|is-plan/.test(below), 'a plan-scale bar was drawn with the stretch furniture');
  ok(/47% of the way to <strong>Gold<\/strong>/.test(below) && !/met ·/.test(below),
    'a scout below the plan is told they have met it');
  ok(/left:25%/.test(below) && /left:50%/.test(below), 'the plan-scale notches are not the plan-scale rungs');

  // A payload published before any of this: pastPlan absent, no stretch block. Must render
  // exactly the single-scale bar it always did rather than throwing.
  const oldPayload = ctx.parentTierProgress({ nextTier: 'Silver', nextPct: 43, nextSalesCents: 25000 },
    { anchorName: 'Gold', planned: true, marks: [{ name: 'Bronze', pct: 25 }] });
  ok(/<div class="bar-fill" style="width:43%">/.test(oldPayload), 'an old payload lost its bar');
  ok(!/bar-fill-stretch/.test(oldPayload), 'an old payload grew a segment it never published');
  // And a row flagged pastPlan whose payload carries NO stretch block — a half-upgraded document —
  // falls back rather than reading through undefined.
  const halfway = ctx.parentTierProgress({ nextTier: 'Platinum', nextPct: 80, pastPlan: true },
    { anchorName: 'Gold', planned: true, marks: [] });
  ok(/<div class="bar-fill" style="width:80%">/.test(halfway), 'a half-upgraded payload breaks the bar');
  ok(!/bar-fill-stretch/.test(halfway), 'a stretch segment was drawn with no scale published for it');
});

test('a family is told how close their scout is to the rung they are chasing', () => {
  const ctx = sandbox(['esc', 'fmt', 'parentBar', 'parentTierProgress']);
  const LADDER = {
    anchorName: 'Gold', planned: true,
    marks: [{ name: 'Bronze', pct: 17, plan: false }, { name: 'Silver', pct: 50, plan: false }]
  };
  // Ada: 44% of the way to Gold (the bar's anchor) but 88% of the way to Silver, the rung in
  // front of her. The caption used to lead with Gold and make Silver a muted afterthought.
  const split = ctx.parentTierProgress({
    nextTier: 'Silver', nextPct: 44, nextRungPct: 88, nextMarkPct: 50,
    nextReward: 'Dues covered', nextSalesCents: 6134
  }, LADDER);
  ok(/88% of the way to <strong>Silver<\/strong>/.test(split), 'the caption does not lead with the near rung');
  ok(/44% of Gold/.test(split), 'the ladder reading is gone, or no longer names its rung');
  ok(split.indexOf('88% of the way to') < split.indexOf('44% of Gold'),
    'the ladder figure is printed ahead of the actionable one');
  // ⚠ THE BAR IS STILL THE LADDER — 44%, not 88%. Only the caption leads with the near rung.
  // Feeding the bar the near-rung figure would rescale every family's bar to whatever rung that
  // scout happens to be chasing, throwing away the comparability the planned-tier anchor bought.
  // (I got this wrong first time round; it is the reason this assertion is here.)
  ok(/<div class="bar-fill" style="width:44%">/.test(split),
    'the bar was rescaled to the near rung instead of staying on the ladder');
  ok(!/width:88%/.test(split), 'the near-rung figure reached the bar');
  // The label describes the BAR. Both figures are in the caption, which a screen reader reads as
  // an ordinary paragraph — putting them in the label too would say each one twice.
  ok(/aria-label="44 percent of the way to Gold"/.test(split),
    'the spoken label no longer describes the bar it is attached to');
  // Silver at 50% is ahead of a 44% fill, and it is the rung being chased — so both classes. The
  // gap between the fill and this notch is how close they are.
  ok(/class="tprog-tick ahead is-next" style="left:50%"/.test(split),
    'the rung being chased is not singled out on the family bar');
  ok(/class="tprog-tick" style="left:17%"/.test(split), 'a passed rung is inked as though still ahead');

  // A scout heading straight for the anchor: one figure, exactly as before.
  const straight = ctx.parentTierProgress({
    nextTier: 'Gold', nextPct: 44, nextRungPct: 44, nextMarkPct: null, nextSalesCents: 6134
  }, LADDER);
  ok(/44% of the way to <strong>Gold<\/strong>/.test(straight), 'the single-rung caption changed');
  ok(!/% of Gold<\/span>|· 44% of/.test(straight), 'the same figure is printed twice');
  ok(/aria-label="44 percent of the way to Gold"/.test(straight), 'the spoken label gained a second rung');
  // Notches ahead of a 44% fill are inked so a family can see what is coming.
  ok(/class="tprog-tick ahead" style="left:50%"/.test(straight),
    'a rung ahead of the fill is invisible on the family board');

  // An older payload has neither field. It must render exactly the bar it always did.
  const oldPayload = ctx.parentTierProgress({ nextTier: 'Silver', nextPct: 43, nextSalesCents: 25000 }, LADDER);
  ok(/43% of the way to <strong>Gold<\/strong>/.test(oldPayload),
    'an old payload lost its caption, or invented a near-rung figure it never published');
  ok(!/is-next/.test(oldPayload), 'a rung was singled out with no position published for it');
  ok(/class="tprog-tick ahead" style="left:50%"/.test(oldPayload),
    'ahead/behind needs no new payload field — it is judged against the fill');
});

test('the two fills are not told apart by colour alone', () => {
  // --good against the gold fill measures 1.09:1 in light, 1.01:1 in dark, 1.09:1 in print — the
  // two are the same LIGHTNESS and differ only in hue, so on greyscale, on paper, or to a
  // red-green colour-blind reader they are one solid bar. Same trap .brow::after documents. No
  // token in the palette clears 3:1 against gold in every theme, so the texture has to carry it.
  ok(/\.bar-fill-stretch \{[^}]*background-image: repeating-linear-gradient/.test(SCRIPT_CSS),
    'the stretch fill is distinguished by hue alone');
  ok(/\.bar-fill-stretch \{[^}]*background: var\(--good\)/.test(SCRIPT_CSS),
    'the stretch fill lost the token that clears 3:1 against the track in all three themes');
  // --navy would be invisible in dark: it is a background token there, 1.08:1 on the dark track.
  ok(!/\.bar-fill-stretch \{[^}]*var\(--navy\)/.test(SCRIPT_CSS),
    'the stretch fill uses a background token that vanishes in dark mode');
  // The boundary is a position, not a colour, so it works for the same readers.
  ok(/\.tprog-tick\.is-plan \{[^}]*width: 3px/.test(SCRIPT_CSS), 'the plan boundary is not drawn heavier');
  // Neither legend names a colour — "the green part" fails exactly the readers it is written for.
  for (const fn of ['renderTierProgress', 'renderParentStandings']) {
    const src = new RegExp(`function ${fn}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT);
    ok(src, `${fn}() not found`);
    ok(/hatched/.test(src[0]), `${fn} does not tell a reader what the second fill looks like`);
    ok(!/\bgreen\b/i.test(codeOnly(src[0])), `${fn} names a colour a reader may not be able to see`);
  }
});

test('the published standings carry the tier progress, from the shared tier map', () => {
  const src = codeOnly(BPV());
  // One call, two readers: the per-scout map below and the pack-wide ladder legend. tierProgressRows
  // walks every storefront and every entry, so calling it twice per publish is not free.
  ok(/var progRows = tierProgressRows\(\);/.test(src) &&
     /progRows\.forEach\(function \(p\) \{ progById\[p\.scout\.id\] = p; \}\)/.test(src),
    'per-scout tier progress is not taken from tierProgressRows');
  ok((src.match(/tierProgressRows\(\)/g) || []).length === 1,
    'the publish walks every scout’s totals more than once');
  // Sales, never the commission shortfall — the same rule the ladder follows.
  ok(/nextSalesCents: \(p && p\.next && typeof p\.shortSales === 'number'\) \? p\.shortSales : null/.test(src),
    'the shortfall is published as commission, or invented when there is no rate');
  ok(!/short: p\.short|shortCents/.test(src), 'the raw commission shortfall is published');
  // tierProgressRows walks ACTIVE scouts; the board also carries archived-but-credited ones, who
  // must simply show no tier rather than crashing or borrowing somebody else's.
  ok(/var p = progById\[r\.id\];/.test(src) && /\(p && p\.earned\)/.test(src),
    'a scout with no progress row is not handled');
});

test('a family can see what the year costs, and what a tier takes off it', () => {
  const src = codeOnly(BPV());
  ok(/var familyCost = familyYearCost\(\)\.map/.test(src), 'the year cost is not published');
  ok(/if \(familyCost\.length\) out\.familyCost = familyCost;/.test(src),
    'the year cost never reaches the document');
  // The PLAN, per den — not any family's balance. None of these may be consulted.
  ok(!/scoutOwesCents|state\.charges|state\.collected|chargesFor/.test(src),
    'a family’s actual balance is reachable from the published view');
  // ⚠ The ladder must NOT publish or print a money figure: it has no den, and a tier can cover a
  // den-limited event (Tigermania is $20 to a Tiger, nothing to a Wolf). The worth is per den, on
  // familyCost[].steps, next to the bill it reduces.
  ok(!/coversCents/.test(src), 'the den-less ladder publishes a money figure again');
  const lad2 = /function parentTierLadder\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(lad2 && !/coversCents|off your costs/.test(lad2[0]), 'the ladder prints a den-blind money figure');
  ok(/steps: \(r\.steps \|\| \[\]\)\.map/.test(src), 'the per-den ladder steps are not published');
  // What the whole ladder takes off the figure, published per den.
  ok(/coveredCents: r\.covered/.test(src), 'the year cost never says what the tiers cover');
  const fn = /function parentFamilyCost\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'parentFamilyCost() not found');
  // ⚠ THIS TEST USED TO PIN THE BUG. It required `Math.max(m, t.coversCents)` across the
  // published tiers, on the reasoning that a rung's own figure is "the whole amount that rung
  // waives" — it is not. Coverage STACKS (packCoverage credits every tier reached), so a rung's
  // own figure counts only what it ADDS, and the largest single one understated Pack 569's
  // ladder by $354 of $500. The union now comes from the leaders' side, den-aware.
  ok(!/coversCents/.test(fn[0]), 'the family figure is back to reading one rung in isolation');
  ok(/var cover = d\.coveredCents \|\| 0;/.test(fn[0]), 'the published cover is not used');
  ok(/Math\.max\(0, expected - cover\)/.test(fn[0]), 'the after-tier figure can go negative');
  // A payload written before the field existed must show no claim at all, not a stale one.
  ok(/\(cover > 0/.test(fn[0]), 'an old payload still prints an after-tier figure');
  // The den-exact rung table: the only money figure a parent gets for the ladder.
  ok(/Your year drops to/.test(fn[0]), 'the den row does not say what each tier drops the year to');
  ok(/d\.steps/.test(fn[0]) && /x\.afterCents/.test(fn[0]), 'the rung table is not driven by the published steps');
  ok(/coveredCents > 0/.test(fn[0]), 'a rung that covers this den nothing still gets a row');
});

test('a rung named on two tiers is handed back once, not twice', () => {
  const ctx = vm.createContext({ state: { rewardTiers: { tiers: [] } } });
  vm.runInContext(
    `${slice('arrOf')} ${slice('sortedTiers')} ${slice('COVER_WHO')} ${slice('coverKeyOf')}
     ${slice('lineRateForWho')} ${slice('coverValueOfKeys')} ${slice('tierCumulativeCoverCents')}
     function coverableLines() { return LINES; }`, ctx);
  ctx.LINES = [
    { key: 'maze', line: { scoutRateCents: 2200, adultRateCents: 2200 } },
    { key: 'dues', line: { scoutRateCents: 8500 } }
  ];
  ctx.state.rewardTiers.tiers = [
    { id: 'a', thresholdCents: 15000, covers: ['dues', 'maze'] },
    { id: 'b', thresholdCents: 33000, covers: ['maze', 'maze#adult'] },  // maze again
    { id: 'c', thresholdCents: 90000, covers: ['dues'] }                 // above: must not count
  ];
  const at = (id) => vm.runInContext(`tierCumulativeCoverCents(state.rewardTiers.tiers.find(function (t) { return t.id === '${id}'; }))`, ctx);
  eq(at('a'), 10700, 'the first rung: 85 dues + 22 maze');
  // 85 + 22 + 22 adult. The SUM would say 15100 — the maze scout share billed to the pack twice.
  eq(at('b'), 12900, 'a line both rungs name is handed back once');
  eq(at('c'), 12900, 'the top rung adds a key it already had');
});

test('the ladder covers are unioned, not summed, and every rung counts', () => {
  const ctx = vm.createContext({ state: { rewardTiers: { tiers: [] } } });
  vm.runInContext(slice('arrOf') + slice('sortedTiers') + slice('allTierCoverKeys'), ctx);
  ctx.state.rewardTiers.tiers = [
    { id: 'a', thresholdCents: 15000, covers: ['dues', 'shirt'] },
    { id: 'b', thresholdCents: 33000, covers: ['maze', 'shirt'] },          // shirt twice
    { id: 'c', thresholdCents: 41500, covers: ['maze', 'stripers#adult'] }  // maze twice
  ];
  eq(Object.keys(vm.runInContext('allTierCoverKeys()', ctx)).sort(),
    ['dues', 'maze', 'shirt', 'stripers#adult'], 'the union of every rung');
  ctx.state.rewardTiers.tiers = [];
  eq(Object.keys(vm.runInContext('allTierCoverKeys()', ctx)), [], 'no tiers covers nothing');
});

test('the parent calendar is a real month grid, driven only by the published events', () => {
  const fn = /function parentCalendar\(pv, today\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'parentCalendar() not found');
  ok(/Array\.isArray\(pv\.events\)/.test(fn[0]), 'the grid reads something other than the published events');
  // Nothing in the parent app may reach `state` — that is the whole shape of the parent phase.
  ok(!/state\./.test(codeOnly(fn[0])), 'the parent calendar reads the leaders’ pack record');
  // Its own month, so a leader who is also a parent cannot have one view drag the other's month.
  ok(/ui\.parentCalMonth/.test(fn[0]) && !/ui\.calMonth/.test(fn[0]),
    'the parent grid shares ui.calMonth with the leader calendar');
  // A hollow storefront dot means an open shift on both sides now that parents can see coverage.
  ok(/return covered \? 'dot-store' : 'dot-store-open';/.test(fn[0]),
    'a storefront dot does not distinguish a fully staffed day');
  ok(/shifts\.every\(function \(s\) \{/.test(fn[0]), 'coverage is not computed from every shift');
  // Same tab-stop diet as the leader grid, and every focusable cell carries its own date.
  ok(/var focusable = iso === today \|\| !!dayEvs;/.test(fn[0]), 'every day in the month is a tab stop');
  ok(/aria-label="' \+ esc\(fmtDate\(iso\)\)/.test(fn[0]), 'a focusable day has no accessible date');
  // Without the allowlist entries the strip renders and does nothing.
  for (const act of ['parent-cal-prev', 'parent-cal-next', 'parent-cal-day', 'parent-cost-toggle']) {
    ok(new RegExp("var PARENT_ACTS = \\[[^\\]]*'" + act + "'").test(SCRIPT),
      `${act} is not in PARENT_ACTS, so the control is inert`);
  }
});

/* ========================================================================
   The parent camping page: one campout per sub-tab — 2026-08-02
   ===================================================================== */

test('camping anchors are unique across trips that share section names', () => {
  const ctx = sandbox(['campAnchor']);
  eq(ctx.campAnchor(2, 5), 'pc-t2-s5', 'a section anchor');
  // Every trip carries the SAME six section titles, so a slug of the title would collide on
  // every one of them and every link would jump to the wrong place. The trip index stays in the
  // id even though one trip renders at a time, so a copied link says which campout it came from.
  const ids = new Set();
  for (let t = 0; t < 3; t++) for (let s = 0; s < 6; s++) ids.add(ctx.campAnchor(t, s));
  eq(ids.size, 18, 'anchor collision across trips');
});

test('the shown campout lists its own sections, and short trips get no index', () => {
  const ctx = sandbox(['esc', 'campAnchor', 'campSectionNav']);
  const trip = (secs) => ({ name: 'Fort Yargo', sections: secs.map((t) => ({ title: t, body: 'x' })) });
  const six = ['What to expect', 'What to pack', 'Getting there', 'Meals', 'Safety', 'Cost'];
  const html = ctx.campSectionNav(trip(six), 1);
  eq((html.match(/<a href="#pc-t1-s/g) || []).length, 6, 'one link per section');
  ok(/href="#pc-t1-s4"/.test(html), 'the hrefs carry the shown trip’s index');
  ok(/<nav class="camp-toc" aria-label="On this page">/.test(html), 'the contents are not a landmark');
  // The sub-tab strip already got you to this trip; only the sections are left to index, so
  // the trip's own name has no link here.
  ok(html.indexOf('camp-toc-trip') === -1, 'the trip links to itself');
  // A page you can already see does not need an index of itself.
  eq(ctx.campSectionNav(trip(['What to pack', 'Meals', 'Safety']), 0), '',
    'a three-section trip still gets an index');
  eq(ctx.campSectionNav({ name: 'x' }, 0), '', 'a trip with no sections gets an index');
  ok(ctx.campSectionNav(trip(['a', 'b', 'c', 'd']), 0) !== '',
    'four sections is the floor and it excluded four');
});

test('parents get a campout sub-tab strip, and only on Camping', () => {
  // The leader side has had one sub-tab per campout all along; a parent got all three trips
  // stacked. Ids are the trip INDEX, because buildParentView publishes no trip id.
  const defs = /function parentSectionDefs\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(defs, 'parentSectionDefs() not found');
  ok(/if \(parentTab\(\) !== 'camping'\) return \[\];/.test(defs[0]),
    'the strip is offered on tabs that have no sections');
  ok(/parentTrips\(\)\.map\(function \(t, i\) \{ return \{ id: String\(i\), label: tripTabLabel\(t\) \}; \}\)/.test(defs[0]),
    'the sub-tabs are not one per published trip');
  // The strip is shared with the leader side, and one row must not leak the other's action.
  const rend = /var secDefs = gate \? \[\][\s\S]*?secEl\.setAttribute\('aria-label'[^;]*;/.exec(SCRIPT);
  ok(rend, 'the section-strip block has moved');
  ok(/var secAct = parent \? 'parent-camp-trip' : 'section';/.test(rend[0]),
    'a parent’s sub-tab emits the leader action');
  ok(/\(parent \? '' : ' data-tab="' \+ esc\(wsNow\.id\) \+ '"'\)/.test(rend[0]),
    'a parent sub-tab carries a workspace id, and wsNow is null for parents');
  // Without the allowlist entry the handler drops the click and the strip does nothing.
  ok(/var PARENT_ACTS = \[[^\]]*'parent-camp-trip'/.test(SCRIPT),
    'parent-camp-trip is not in PARENT_ACTS, so the sub-tabs are inert');
  // Trust nothing off the DOM: an index out of range must not select a trip that isn't there.
  const handler = /if \(act === 'parent-camp-trip'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(handler, "the parent-camp-trip handler is missing");
  ok(/if \(pcWant >= 0 && pcWant < parentTrips\(\)\.length\)/.test(handler[0]),
    'the handler takes the clicked index without checking it');
});

test('the parent camping page renders one campout, not all of them', () => {
  const fn = /function renderParentCamping\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'renderParentCamping() not found');
  ok(/var ti = parentCampTrip\(\);/.test(fn[0]) && /var t = trips\[ti\] \|\| trips\[0\];/.test(fn[0]),
    'the page does not select a single trip');
  // The give-away for a regression to the stacked page.
  ok(fn[0].indexOf('trips.forEach') === -1, 'the page still iterates every trip');
});

test('a camping jump clears the sticky topbar', () => {
  // Without this the heading you jumped to lands UNDERNEATH the header, which reads as the link
  // being broken. Sized for the tall (wrapped-wordmark) bar plus the card's own padding.
  const m = /\.camp-anchor \{ scroll-margin-top: (\d+)px; \}/.exec(SCRIPT_CSS);
  ok(m, 'the camping anchors have no scroll margin');
  ok(+m[1] >= 141, `scroll-margin-top ${m[1]}px is under the 122px topbar plus card padding`);
  // The heading has to BE the anchor, or the margin lands on nothing. Only section headings are
  // anchored now: the trip's own name is the top of its sub-tab, so nothing jumps to it.
  ok(/class="section display camp-anchor" id="' \+ campAnchor\(ti, si\)/.test(SCRIPT),
    'a camping section heading is anchored without the class that gives it clearance');
});

/* ========================================================================
   What else the parent view publishes — 2026-08-02
   ===================================================================== */

test('an activity crosses over with its time, its end time and its address', () => {
  // All three are editable, all three are shown to leaders, all three go into the .ics export —
  // and the app NAGS a leader when an upcoming activity is missing a time or a place. It then
  // published neither, so a family got a title and a date and had to text somebody.
  const src = BPV();
  ok(/var aRange = fmtTimeRange\(e\.time, e\.endTime\);/.test(src),
    'an activity publishes no time, or only its start');
  ok(/if \(aRange\) av\.times = \[aRange\];/.test(src), 'the time range never reaches the document');
  ok(/if \(e\.location\) av\.where = String\(e\.location\);/.test(src), 'the location is still dropped');
  // The nudge that chases leaders for exactly these two fields must keep matching them, or the
  // app goes back to asking for something it throws away.
  ok(/\(!a\.time \|\| !a\.location\)/.test(SCRIPT), 'the vague-activity nudge no longer checks time and place');
  // A meeting's note IS its "Where" and has always published; its internal note must not.
  ok(/kind: 'meeting'[^}]*detail: String\(e\.note \|\| ''\)/.test(src), 'a meeting stopped publishing its Where');
  // A meeting has no end-time INPUT, so fmtTimeRange degrades to exactly what fmtClock returned —
  // this is not a behaviour change today. It is pinned because the .ics importer writes endTime
  // straight onto an event, and a meeting that arrives from BAND carrying one should show the
  // range rather than silently dropping half of it.
  ok(/var mRange = fmtTimeRange\(e\.time, e\.endTime\);/.test(src),
    'a meeting imported with an end time would publish only its start');
  ok(codeOnly(src).indexOf('noteInternal') === -1,
    'the leaders-only note is reachable from the published view');
  // An ACTIVITY's free-text note is not a location and is not published — only e.location is.
  ok(!/av\.\w+ = String\(e\.note/.test(src), 'an activity now publishes its note');
});

test('a storefront publishes who is on each shift, and never a penny of it', () => {
  const src = BPV();
  ok(/var shifts = blocksInDayOrder\(sf\)\.map/.test(src),
    'the shifts publish in stored order rather than the order the day happens');
  ok(/return \{ when: fmtTimeRange\(b\.start, b\.end\), who: shiftWho\(b\) \};/.test(src),
    'a published shift no longer carries who is on it');
  ok(/if \(shifts\.length\) ev\.shifts = shifts;/.test(src), 'the shifts never reach the document');
  // The whole reason shift money was withheld in the first place. Anchored on `b.` so the tier
  // ladder's own salesCents key (a sell-through target, not a block's takings) is not a match.
  const code = codeOnly(src);
  ok(!/b\.salesCents|b\.donationsCents|blockShares\(/.test(code),
    'a block’s money is reachable from the published view');
  // First names only, and alphabetical like every other list of scouts in the app.
  const who = /function shiftWho\(b\) \{[\s\S]*?\n      \}/.exec(src);
  ok(who, 'shiftWho() not found');
  ok(/pubName\[a\.scoutId\]/.test(who[0]), 'shift names come from somewhere other than the public-name map');
  ok(/\.sort\(function \(x, y\) \{ return String\(x\)\.localeCompare\(String\(y\)\); \}\)/.test(who[0]),
    'shift names are not sorted, so a rename reshuffles a shift');
});

test('one public-name map, so no two surfaces call the same child different things', () => {
  const src = BPV();
  // Built over the WHOLE roster before anything names a child.
  ok(/var shown = shortNames\(all\.map\(function \(s\) \{ return s\.name; \}\)\);/.test(src),
    'the public-name map is not built from the full roster');
  ok(/name: pubName\[r\.id\] \|\| ''/.test(src), 'the standings board names children from its own pass');
  // A SECOND shortNames() pass over a subset is exactly how the two boards drifted apart: the
  // derby list keeps one, but only as the fallback for a racer who is not a roster scout at all
  // (a sibling in the open class), and pubRacer() prefers the shared map.
  ok(/function pubRacer\(raw, fallback\)/.test(src), 'pubRacer() not found');
  ok(/racerName: pubRacer\(aw\.racerName, derbyNames\[winners\.length \+ i\]\)/.test(src),
    'a design-award racer is not reconciled against the roster');
  ok(/scoutName: pubRacer\(w\.scoutName, derbyNames\[i\]\)/.test(src),
    'a derby winner is not reconciled against the roster');
  eq((codeOnly(src).match(/shortNames\(/g) || []).length, 2,
    'an unexpected number of shortNames() passes — every extra one can name a child differently');
});

test('the derby date is a calendar fact, not a standings one', () => {
  const src = BPV();
  const gate = src.indexOf('if (!withStandings) return out;');
  const dbyRow = src.indexOf("kind: 'derby'");
  ok(dbyRow > -1, 'no derby row is published');
  ok(dbyRow < gate, 'the derby date sits behind the standings gate, so a calendar-only pack loses it');
  // Deduped on the DATE alone — a rule a leader can predict. Fuzzy title matching would drop a
  // real event, or double a row, depending on how they spelled it.
  ok(/!events\.some\(function \(e\) \{ return e\.date === dbyDate; \}\)/.test(src),
    'a pack with its own derby event gets a second row beside it');
  ok(/if \(dbyDate && inYear\(dbyDate\)/.test(src), 'a derby outside the program year still publishes');
  // The winners stay behind the gate: they are a board of children's names.
  ok(src.indexOf('winners: winners.map') > gate, 'the derby winners escaped the standings gate');
});

test('the reward ladder publishes what a scout must SELL, and never who paid instead', () => {
  const src = BPV();
  ok(/salesCents: salesForCommission\(t\.thresholdCents\)/.test(src),
    'the ladder publishes the raw threshold, which is commission — nobody sells commission');
  const tcode = codeOnly(src);
  ok(!/thresholdCents: /.test(tcode), 'the commission threshold is published as-is');
  // madeUp names the families who paid the difference instead of selling it.
  ok(tcode.indexOf('madeUp') === -1, 'tier.madeUp is reachable from the published view');
  ok(!/t\.covers/.test(tcode), 'the tier’s internal collect keys are published');
  const gate = src.indexOf('if (!withStandings) return out;');
  ok(src.indexOf('var tiers = sortedTiers()') > gate,
    'the ladder publishes in calendar-only mode, where there is no tab to show it on');
});

test('a parent sees which shifts are open, and an old document still shows its windows', () => {
  const ctx = sandbox(['esc', 'parentShiftLines']);
  const html = ctx.parentShiftLines({ shifts: [
    { when: '10:00 AM–12:00 PM', who: ['Ada', 'Bowie G.'] },
    { when: '12:00 PM–2:00 PM', who: [] }
  ] });
  eq((html.match(/class="sf-shift[ "]/g) || []).length, 2, 'one line per shift');
  ok(/Ada, Bowie G\./.test(html), 'the names of a staffed shift');
  ok(/class="sf-shift sf-open"/.test(html) && />Open</.test(html),
    'an open shift is not marked, so a parent cannot see what needs covering');
  // A document published before this shipped has `times` instead. Those render above as chips,
  // so this adds nothing rather than blanking the storefront.
  eq(ctx.parentShiftLines({ times: ['10:00 AM–12:00 PM'] }), '', 'an old document breaks');
  eq(ctx.parentShiftLines({}), '', 'a storefront with no shifts breaks');
});

test('the ladder shows a rung with no measurable target, rather than a target of nothing', () => {
  const ctx = sandbox(['esc', 'fmt', 'fmtDate', 'parentTierLadder']);
  const rows = (html) => (html.match(/<tr>/g) || []).length;
  const full = ctx.parentTierLadder({ tiers: [
    { name: 'Dues covered', reward: 'The pack pays your dues', note: '', dueBy: '2026-10-15', salesCents: 17500 },
    { name: 'Camp week', reward: 'A week of camp', note: 'Sign up by the November meeting.', dueBy: '', salesCents: 87500 }
  ] });
  // The word "sold" left the cell when the column header became "Sell" — saying it twice is
  // noise, and the footnote under the table says it once more for anyone who scrolled past.
  ok(/>\$175\.00</.test(full), 'the sell-through target');
  ok(/<th scope="col">Sell<\/th>/.test(full), 'the column does not say what the figure is');
  ok(/any time/.test(full), 'a tier with no deadline should say so, not show a blank');
  ok(/Sign up by the November meeting\./.test(full), 'the tier note is dropped');
  eq(rows(full), 3, 'a header row and one row per tier');
  // salesForCommission returns null when the pack has typed no rate at all.
  const noRate = ctx.parentTierLadder({ tiers: [
    { name: 'Pack tee', reward: 'Pack t-shirt', note: '', dueBy: '', salesCents: null }
  ] });
  ok(/Pack t-shirt/.test(noRate), 'an unmeasurable rung is dropped entirely, reward and all');
  ok(!/\$0\.00/.test(noRate), 'an unmeasurable rung shows a target of zero');
  eq(ctx.parentTierLadder({}), '', 'a pack with no tiers gets an empty card');
});

/* ========================================================================
   An admin can look at the parent view — 2026-08-02
   ===================================================================== */

test('the preview is gated so nobody can be stranded in a view they cannot leave', () => {
  const fn = /function canPreviewParent\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'canPreviewParent() not found');
  // canEdit() as WELL as the role: if a pack demotes an admin mid-session the preview must end
  // on its own, not leave them holding a flag with no button to clear it.
  ok(/return canEdit\(\) && \(isAdmin\(\) \|\| !accountsInForce\(\)\);/.test(fn[0]),
    'the preview is not gated on both the role and edit rights');
  // previewingParent() re-checks the gate rather than trusting the flag, so a stale ui flag on a
  // demoted admin's screen resolves to false.
  ok(/function previewingParent\(\) \{ return ui\.previewParent === true && canPreviewParent\(\); \}/.test(SCRIPT),
    'the preview flag is trusted without re-checking who is holding it');
  // NOT persisted: a reload is always an escape hatch. `ui` is never written to storage, and the
  // flag lives there for exactly that reason.
  ok(/previewParent: false/.test(SCRIPT), 'the preview flag has no declared default');
  ok(!/previewParent/.test(/function normalizeState\(d\) \{[\s\S]*?\n  \}/.exec(SCRIPT)?.[0] || ''),
    'the preview flag reached the persisted pack record, so a reload could not clear it');
  // The way out is on the allowlist. Every other leader action is refused while parentMode() is
  // true, so an exit that was not allowlisted would be a trap.
  ok(/var PARENT_ACTS = \[[^\]]*'parent-preview-off'/.test(SCRIPT),
    'the exit action is not allowlisted, so the preview cannot be left');
  // Entering re-checks; leaving is unconditional.
  const on = /if \(act === 'parent-preview-on'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(on && /if \(!canPreviewParent\(\)\) return;/.test(on[0]),
    'entering the preview does not re-check who is asking');
  const off = /if \(act === 'parent-preview-off'\) \{[^}]*\}/.exec(SCRIPT);
  ok(off && !/canPreviewParent/.test(off[0]), 'leaving the preview is conditional');
});

test('the preview reads the pack record without letting it into the parent block', () => {
  // The invariant that makes the money, dues and roster unreachable from a parent's screen is
  // structural: `state` never appears in the parent render block (asserted separately above). The
  // preview needs a document built FROM state, so it is built in render() and read through
  // parentDoc() — the one place that may know about both.
  ok(/parentPreviewDoc = previewingParent\(\) \? buildParentView\(state\) : null;/.test(SCRIPT),
    'the preview document is not built in render(), or not from the pack record');
  ok(/function parentDoc\(\) \{ return previewingParent\(\) \? parentPreviewDoc : sync\.parentView; \}/.test(SCRIPT),
    'parentDoc() no longer chooses between the preview and the published copy');
  // Cleared when not previewing, so a stale build can never be served to a real parent — the
  // `: null` branch is inside the assignment asserted above. It also starts empty:
  ok(/var parentPreviewDoc = null;/.test(SCRIPT), 'the preview document does not start empty');
  // That it is REACHED on every render is not something a source scan can show, and two attempts
  // to assert it textually were both wrong (a harmless one-line `if` sits between the parent-mode
  // decision and the assignment). Verified in a browser instead: entering and leaving the preview
  // repeatedly serves a freshly built document each time, and a reload clears it.
  // EVERY reader goes through parentDoc(). A reader left on sync.parentView would make the tabs
  // and the content disagree — a preview whose Standings tab is offered from the published copy
  // and filled from the live one.
  const start = SCRIPT.indexOf('function parentHasStandings(');
  const block = SCRIPT.slice(start, SCRIPT.indexOf('function renderStorefrontList('));
  ok(!/sync\.parentView/.test(codeOnly(block)),
    'a parent-app reader still reads the published copy directly, so the preview is inconsistent');
  // Deliberately NOT a count of parentDoc() calls: the meaningful property is that no reader
  // bypasses it, which the assertion above proves directly. A count is just a number to update.
  ok(/var pv = parentDoc\(\);/.test(block), 'the parent app no longer takes its document from parentDoc()');
});

test('the preview announces itself, and the leader entry point hides from everyone else', () => {
  const banner = /function parentPreviewBanner\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(banner, 'parentPreviewBanner() not found');
  ok(/Parent view preview\./.test(banner[0]), 'the banner does not say what it is');
  ok(/data-act="parent-preview-off"/.test(banner[0]), 'the banner has no way back');
  // no-print: a parent's printed schedule should not carry a leader's scaffolding.
  ok(/class="card no-print pv-preview"/.test(banner[0]), 'the banner prints, or is not tinted');
  ok(/\.pv-preview \{ background: var\(--accent-soft\); border: 1px solid var\(--accent\); \}/.test(SCRIPT_CSS),
    'the banner is styled as an ordinary card, so it reads as part of the parent view');
  // Rendered first, before any content — a leader who forgets they are in here will report the
  // pack's money as missing.
  const app = /function renderParentApp\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(/var h = previewingParent\(\) \? parentPreviewBanner\(\) : '';/.test(app[0]),
    'the banner is not the first thing on the page');
  // The entry card renders for nobody who cannot use it, so there is no disabled control to explain.
  const card = /function renderParentPreviewCard\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(card && /if \(!canPreviewParent\(\)\) return '';/.test(card[0]),
    'the entry card renders for people who cannot use it');
  ok(/renderParentPreviewCard\(\);/.test(SCRIPT), 'the entry card is never rendered');
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

/* ========================================================================
   The printout IS the family page — 2026-08-31
   ===================================================================== */

// Owner ruling: what gets printed for a bulletin board or a parents meeting is the page families
// will read online once the site is shared, not a separately authored handout. A second rendering
// of the same ladder is a second thing to keep in step, and the standings sheet in this very file
// had already drifted four ways by the time anybody looked at it.

test('there is no separately authored tier handout left to drift', () => {
  for (const gone of ['tierSheetRungs', 'tierSheetText', 'renderTierSheet']) {
    ok(!new RegExp(`function ${gone}\\(`).test(SCRIPT), `${gone}() is back — a second source for the ladder`);
  }
  ok(!/kind: 'tiers'|o\.kind === 'tiers'/.test(SCRIPT), 'the retired tier-sheet overlay is still reachable');
  ok(!/copy-tier-sheet|data-act="tier-sheet"/.test(SCRIPT), 'the retired sheet still has controls pointing at it');
  // The affordance stays where leaders look; it just lands on the family view now.
  ok(/data-act="family-sheet"/.test(SCRIPT), 'the Rewards card lost its print affordance entirely');
  const h = /if \(act === 'family-sheet'\) \{[\s\S]*?\n    \}/.exec(SCRIPT);
  ok(h, "the family-sheet action has no handler");
  ok(/ui\.previewParent = true;/.test(h[0]) && /ui\.parentTab = 'standings';/.test(h[0]),
    'the button does not land on the family Standings tab');
  // Re-checks the role rather than trusting a button that was rendered for an admin who has since
  // been demoted — the same guard parent-preview-on carries.
  ok(/if \(!canPreviewParent\(\)\) return;/.test(h[0]), 'a demoted admin can still open the family view');
});

test('the family page can print itself, and the print reaches a parent’s own device', () => {
  const list = /function renderParentStandings\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(list, 'renderParentStandings() not found');
  ok(/data-act="parent-print"/.test(list[0]), 'the family page has no way to print itself');
  ok(/class="row no-print"/.test(list[0]), 'the print control prints itself onto the paper');
  // ⚠ The parent app ignores any action not on this list, so a button alone would be inert.
  ok(/'parent-cal-day', 'parent-cost-toggle', 'parent-preview-off', 'parent-print'/.test(SCRIPT),
    'parent-print is not allowed through the parent-mode action gate');
  ok(/if \(act === 'parent-print'\) \{ window\.print\(\); return; \}/.test(SCRIPT),
    'the print action does something other than print the page in front of it');
  // <main> has to stay visible in parent mode or the paper comes out blank — the normal print
  // rule hides it and shows only overlays, and a parent has no overlays.
  ok(/@media print \{ body\.parent-mode main \{ display: block !important; \} \}/.test(SCRIPT_CSS),
    'the family page prints blank');
});

test('paper breaks between facts, never through one', () => {
  // Owner ask, 2026-08-31: page breaks so the content fits nicer. Before this the print block had
  // no pagination rules at all, so a scout's bar could land on one sheet with their name on the
  // previous one, and a standings table running past a page lost its column headings entirely.
  const pr = /@media print \{[\s\S]*?\n  \}/.exec(SCRIPT_CSS);
  ok(pr, 'the print block was not found');
  // ⚠ SCOPED TO THE SMALL UNITS ON PURPOSE. break-inside on a container taller than a sheet
  // cannot be honoured, and the browser's fallback is to push the whole thing to a fresh page and
  // leave the previous one half empty. "What a year costs a family" runs well past a page on its
  // own, so the CARD must stay breakable and the dens are what hold together.
  ok(/\.pv-scout, \.pv-den, \.block-card, \.pv-stand, \.stat \{ break-inside: avoid; \}/.test(pr[0]),
    'the atomic units can still be split across a page break');
  ok(!/\.card \{[^}]*break-inside: avoid/.test(pr[0]),
    'a card taller than a sheet is marked unbreakable, which strands half a page');
  // A column of figures with no heading is unreadable on page two.
  ok(/thead \{ display: table-header-group; \}/.test(pr[0]), 'a long table loses its headings after page one');
  ok(/tr[^{]*\{ break-inside: avoid; \}/.test(pr[0]), 'a table row can be split in half');
  // A heading at the foot of a page points at nothing.
  ok(/h1, h2, h3, \.eyebrow \{ break-after: avoid; \}/.test(pr[0]), 'a heading can be stranded from its content');
  ok(/orphans: 3; widows: 3/.test(pr[0]), 'a single dangling line can be left at a page edge');
  // The bars carry meaning through a background colour, which browsers drop by default. Every
  // figure is also in words, so a viewer who declines still loses nothing.
  ok(/print-color-adjust: exact/.test(pr[0]), 'the progress bars print as empty outlines');
});

test('every den prints opened out, however the reader left them on screen', () => {
  // ⚠ A collapsed den used to `return` before emitting anything, so the breakdown was not in the
  // DOM and NO print rule could bring it back: paper got the headline figure and none of the
  // detail, which is most of what the card is for. The toggle now decides only what is SHOWN.
  const fn = /function parentFamilyCost\(pv\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(fn, 'parentFamilyCost() not found');
  ok(!/if \(!open\) return;/.test(fn[0]), 'a collapsed den is skipped, so print cannot expand it');
  ok(/class="pv-cost-detail' \+ \(open \? ' open' : ''\)/.test(fn[0]),
    'the detail is not wrapped in something a print rule can target');
  // Both early exits inside the loop have to close the wrapper, or a den with no priced rungs
  // leaves an unclosed div and swallows every den after it.
  // TWO wrappers now: .pv-den holds the row and its detail together so a page break cannot land
  // between them, and .pv-cost-detail is the collapsible part inside it. Both early exits have to
  // close both, or a den with no priced rungs swallows every den after it and the closing note.
  ok(/if \(!steps\.length\) \{ h \+= '<\/div><\/div>'; return; \}/.test(fn[0]),
    'a den with no priced rungs leaves a wrapper unclosed');
  eq((fn[0].match(/pv-cost-detail/g) || []).length, 1, 'the wrapper is opened more than once per den');
  eq((fn[0].match(/'<div class="pv-den">'/g) || []).length, 1, 'the den wrapper is opened more than once');
  // Balanced across the whole loop body: one <div class="pv-den"> and one .pv-cost-detail opened,
  // and every path out closes both.
  eq((fn[0].match(/<\/div><\/div>/g) || []).length, 2, 'the two exits from the den loop do not close the same tags');
  ok(/\.pv-cost-detail \{ display: none; \}/.test(SCRIPT_CSS), 'a collapsed den is visible on screen');
  ok(/@media print \{[\s\S]*?\.pv-cost-detail \{ display: block !important; \}/.test(SCRIPT_CSS),
    'the detail stays collapsed on paper');
  // The chevron points at an interaction paper does not have, and would show the collapsed glyph
  // beside content that is open.
  ok(/\[data-act="parent-cost-toggle"\] \.mo-chev \{ display: none !important; \}/.test(SCRIPT_CSS),
    'the disclosure arrow prints beside expanded content');
});

/* ========================================================================
   The shared standings sheet, brought level with the board — 2026-08-31
   ===================================================================== */

test('the shared sheet never puts one rate over a two-rate commission', () => {
  // ⚠ THE BUG THIS EXISTS FOR. pack.pct is the STOREFRONT rate alone (computePackTotals sets
  // `pct` from rates.base), so on a pack running 35% at a table and 30% online — the ordinary
  // case, and this pack's — "Commission (35%)" labelled a figure that is the sum of two separate
  // calculations. On a sheet that gets handed to a committee that is just a wrong number.
  const sheet = /if \(o\.kind === 'summary'\) \{[\s\S]*?\n      return h;/.exec(SCRIPT);
  ok(sheet, "the summary overlay branch was not found");
  ok(!/Commission \(' \+ pack\.pct \+ '%\)/.test(sheet[0]),
    'the sheet labels a two-rate commission with the storefront rate');
  ok(/pack\.ratesSplit \|\| pack\.pct == null \? '' :/.test(sheet[0]),
    'the rate is named unconditionally, so a split-rate pack is mislabelled');
  // With two rates it discloses both halves instead, exactly as the on-screen card does.
  ok(/pack\.commissionOther/.test(sheet[0]) && /pack\.commissionOnline/.test(sheet[0]),
    'a treasurer cannot reconcile the sheet against a Trail’s End statement');
  // Same fix in the copy-as-text twin, or the two disagree.
  const txt = /function summaryText\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT);
  ok(!/Pack commission \(' \+ pack\.pct \+ '%\)/.test(txt[0]),
    'the text version still labels a two-rate commission with one rate');
  ok(/pack\.ratesSplit/.test(txt[0]), 'the text version does not disclose the two halves');
});

test('the shared sheet says which tier each scout reached, and what the pack ends up with', () => {
  const sheet = /if \(o\.kind === 'summary'\) \{[\s\S]*?\n      return h;/.exec(SCRIPT)[0];
  // The reward ladder is the pack's main lever and the shared standings sheet never mentioned it,
  // while the board it is printed from shows a badge per scout.
  ok(/tierBadgesFor\(r, sumTiers, sumCovered\)/.test(sheet),
    'the sheet builds its own idea of who earned what, or shows none at all');
  ok(/var sumTiers = sortedTiers\(\);/.test(sheet) && /var sumCovered = packCoverageByScout\(\);/.test(sheet),
    'the badges are not taken from the same two calls the Standings card makes');
  // A pack with no tiers gets no empty column.
  ok(/sumTiers\.length \? '<th scope="col">Tier<\/th>' : ''/.test(sheet),
    'a pack with no reward tiers is given an empty Tier column');
  // The bottom line the sheet used to stop one figure short of.
  ok(/Total to the pack/.test(sheet), 'the sheet stops at commission and never says what the pack keeps');
  ok(/fmt\(pack\.cashKept \+ pack\.commission\)/.test(sheet),
    'the total is not commission plus the cash the pack keeps');
  // And the stretch goal, which the on-screen card shows and the sheet had dropped — on its own
  // bar, never a marker on the first one.
  ok(/Stretch goal/.test(sheet), 'the sheet omits the stretch goal the board shows');
  ok(/pack\.stretch > 0/.test(sheet), 'the stretch bar is drawn even when there is no stretch goal');
  const txt = /function summaryText\(\) \{[\s\S]*?\n  \}/.exec(SCRIPT)[0];
  ok(/earnedTierFor\(r\.id, txTiers, txEarned\)/.test(txt), 'the text version names no tiers');
  ok(/Total to the pack/.test(txt) && /Stretch goal/.test(txt),
    'the text version is behind the printed sheet');
});

/* ---------------- report ---------------- */
if (fails.length) {
  console.error(`\n  ${fails.length} failing, ${pass} passing\n`);
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passing\n`);
