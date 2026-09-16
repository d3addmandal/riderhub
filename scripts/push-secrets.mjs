// Copy the API's secrets from backend/.env into Cloud Secret Manager.
//
//   node scripts/push-secrets.mjs [project-id]
//
// The deployed function reads its keys from Secret Manager (src/function.ts declares
// them with defineSecret), while a dev machine reads the same keys from backend/.env.
// Doing that by hand in the console means pasting long keys into a web form three
// times, where a stray trailing space is invisible and breaks the deploy — so this
// does it from the file that already works locally.
//
// Values never pass through the shell or appear in output: gcloud is spawned directly
// and each value is written to its stdin.
//
// Safe to re-run. A secret that is missing is created; one that already holds the same
// value is left alone; one that differs gets a new version (which is how you rotate a
// key — edit backend/.env, run this, re-deploy).
//
// Needs gcloud logged in as someone who can administer secrets on the project
// (`gcloud auth login`). The GitHub deploy does not use this script or your login — it
// authenticates with its own service account.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PROJECT = process.argv[2] ?? JSON.parse(readFileSync('.firebaserc', 'utf8')).projects.default;

const GCLOUD = ['gcloud', 'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd',
  'C:/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd']
  .find(p => p === 'gcloud' ? spawnSync(p, ['--version'], { shell: true }).status === 0 : existsSync(p));
if (!GCLOUD) { console.error('gcloud not found. Install the Google Cloud SDK, or create the secrets by hand (DEPLOY.md step 4).'); process.exit(1); }

const gcloud = (args, input) => spawnSync(GCLOUD, [...args, `--project=${PROJECT}`], {
  input, encoding: 'utf8', shell: GCLOUD === 'gcloud',
});

// gcloud spreads one error over several lines and ends with a suggestion, so the last
// line is the least informative part. The ERROR: line is the one that says what broke.
const why = (r) => {
  const lines = (r.stderr || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => l.startsWith('ERROR:')) ?? lines[0] ?? `exit ${r.status}`).replace(/^ERROR:\s*/, '');
};

// Which secrets matter is decided by the function itself, so this cannot drift from it.
const wanted = [...readFileSync('backend/src/function.ts', 'utf8')
  .matchAll(/defineSecret\(['"]([A-Z0-9_]+)['"]\)/g)].map(m => m[1]);

const env = {};
for (const line of readFileSync('backend/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/s, '$1');
}

/*
 * Check the login before touching anything. `gcloud auth list` is not proof of
 * anything: it reads credentials off the disk, so an account whose refresh token has
 * expired still appears, active and healthy, while every API call fails with
 * "invalid_grant". One real call first turns three confusing per-secret errors into
 * one instruction.
 */
const probe = gcloud(['projects', 'describe', PROJECT, '--format=value(projectId)']);
if (probe.status !== 0) {
  const err = (probe.stderr || '').trim();
  console.error(`\nCannot reach project ${PROJECT} with your gcloud login.\n`);
  if (/invalid_grant|auth login|do not currently have an active account/i.test(err)) {
    console.error('  Your login has expired. Sign in again (this opens a browser):\n');
    console.error('      gcloud auth login\n');
    console.error('  then run this command again.');
  } else if (/PERMISSION_DENIED|does not have permission/i.test(err)) {
    console.error(`  You are signed in, but that account has no access to ${PROJECT}.`);
    console.error('  Sign in as the Google account that owns the project:\n');
    console.error('      gcloud auth login');
  } else {
    console.error(err.split('\n').slice(0, 6).map(l => '  ' + l).join('\n'));
  }
  console.error('\n  Or skip the CLI and create them in the console:');
  console.error(`  https://console.cloud.google.com/security/secret-manager?project=${PROJECT}\n`);
  process.exit(1);
}

console.log(`Project: ${PROJECT}\n`);
let created = 0, updated = 0, unchanged = 0, missing = 0;

for (const name of wanted) {
  const value = env[name];
  if (!value) {
    console.log(`  ✖ ${name} — not set in backend/.env, skipped`);
    missing++;
    continue;
  }

  const exists = gcloud(['secrets', 'describe', name, '--format=value(name)']).status === 0;
  if (!exists) {
    const r = gcloud(['secrets', 'create', name, '--replication-policy=automatic', '--data-file=-'], value);
    if (r.status !== 0) { console.log(`  ✖ ${name} — ${why(r)}`); missing++; continue; }
    console.log(`  + ${name} — created (${value.length} chars)`);
    created++;
    continue;
  }

  // Already there: only add a version if the value actually changed, so re-running
  // does not pile up identical versions (the free tier allows six).
  const current = gcloud(['secrets', 'versions', 'access', 'latest', `--secret=${name}`]);
  if (current.status === 0 && current.stdout === value) {
    console.log(`  = ${name} — already up to date`);
    unchanged++;
  } else {
    const r = gcloud(['secrets', 'versions', 'add', name, '--data-file=-'], value);
    if (r.status !== 0) { console.log(`  ✖ ${name} — ${why(r)}`); missing++; continue; }
    console.log(`  ↑ ${name} — new version added (value had changed)`);
    updated++;
  }
}

console.log(`\ncreated ${created}, updated ${updated}, unchanged ${unchanged}${missing ? `, failed ${missing}` : ''}`);
if (missing) {
  console.log('\nThe deploy will refuse to run until every secret exists.');
  console.log(`Create the rest by hand: https://console.cloud.google.com/security/secret-manager?project=${PROJECT}`);
  process.exit(1);
}
console.log('\nThe function will pick these up on its next deploy.');
