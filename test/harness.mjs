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

/* ---------------- report ---------------- */
if (fails.length) {
  console.error(`\n  ${fails.length} failing, ${pass} passing\n`);
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passing\n`);
