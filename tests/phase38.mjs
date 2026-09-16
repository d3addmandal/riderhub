// The browser-only deploy path: a GitHub Actions workflow that builds, guards and
// uploads to Firebase Hosting, so nobody needs the Firebase CLI installed.
//
// Static checks — the workflow cannot run here, but every way it could silently drift
// from the CLI path (skipping a guard, deploying to the wrong project, forgetting the
// settings the build needs) is visible in the file.
import { readFileSync, existsSync } from 'node:fs';

const WF = '.github/workflows/deploy-hosting.yml';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

console.log('\n=== THE WORKFLOW EXISTS AND IS TRIGGERABLE FROM THE GITHUB UI ===');
check('workflow file is present', existsSync(WF));
const wf = existsSync(WF) ? readFileSync(WF, 'utf8') : '';
check('it has a Run-workflow button (workflow_dispatch)', /^\s*workflow_dispatch:/m.test(wf));
check('it also deploys on push to main', /branches:\s*\[main\]/.test(wf));
check('two deploys cannot race each other', /concurrency:/.test(wf) && /cancel-in-progress:\s*false/.test(wf));

console.log('\n=== IT DEPLOYS THE SAME THING THE CLI WOULD ===');
const fb = JSON.parse(readFileSync('firebase.json', 'utf8'));
const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
check('it targets the project in .firebaserc', wf.includes(`--project ${rc.projects.default}`), rc.projects.default);
check('it deploys site, API function and Firestore rules in one go', /deploy --only hosting,functions,firestore:rules/.test(wf));
check('it deploys with the Firebase CLI, non-interactively', /firebase-tools@\d+ deploy/.test(wf) && /--non-interactive/.test(wf) && /--force/.test(wf));
check('it builds the directory firebase.json publishes', wf.includes('npm run build --prefix frontend') && fb.hosting.public === 'frontend/dist');
check('it builds the API before deploying', wf.indexOf('npm run build --prefix backend') < wf.indexOf('deploy --only'));
check('it installs the backend dependencies too', /npm ci --prefix backend/.test(wf));
check('the service account key comes from a secret into a job-only file', /secrets\.FIREBASE_SERVICE_ACCOUNT/.test(wf) && /GOOGLE_APPLICATION_CREDENTIALS=\$RUNNER_TEMP/.test(wf));
check('a malformed secret fails with a readable message', /not valid JSON/.test(wf));

console.log('\n=== THE RELEASE GUARDS STILL RUN ===');
// deploy:web runs phase31 and phase36 before firebase deploy; the workflow must too, or
// the browser path becomes the way secrets and broken installs slip out.
const local = JSON.parse(readFileSync('package.json', 'utf8')).scripts['deploy:web'];
for (const guard of local.match(/tests\/phase\d+\.mjs/g)) {
  check(`${guard} runs before the upload`, wf.indexOf(guard) !== -1 && wf.indexOf(guard) < wf.indexOf('deploy --only'));
}
check('tests/phase39.mjs (function wiring) runs before the upload', wf.indexOf('tests/phase39.mjs') !== -1 && wf.indexOf('tests/phase39.mjs') < wf.indexOf('deploy --only'));
check('the live site is verified after the upload',
  wf.indexOf('tests/phase37.mjs https://') > wf.indexOf('deploy --only'));

console.log('\n=== THE BUILD CANNOT SHIP WITH PLACEHOLDER SETTINGS ===');
for (const k of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
                 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID']) {
  check(`${k} is required`, wf.includes(`'${k}'`));
}
check('VITE_API_URL is optional (same-origin on Firebase) but must be https if set', !wf.includes("'VITE_API_URL'") && wf.includes('^https:'));
check('settings can come from repository Variables (set in the GitHub UI)', /toJSON\(vars\)/.test(wf));

console.log('\n=== NOTHING SECRET CAN REACH THE REPOSITORY ===');
const gi = readFileSync('.gitignore', 'utf8');
for (const p of ['backend/.env', 'frontend/.env', '.firebase/']) check(`.gitignore covers ${p}`, gi.includes(p));
check('frontend/.env.production is committed (public values only)', !/^frontend\/\.env\.production$/m.test(gi) && !/^\.env\.production$/m.test(gi));

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
