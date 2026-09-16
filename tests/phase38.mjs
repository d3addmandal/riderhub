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
check('it targets the project in .firebaserc', wf.includes(`projectId: ${rc.projects.default}`), rc.projects.default);
check('it deploys to the live channel', /channelId:\s*live/.test(wf));
check('it uses the official hosting action', /FirebaseExtended\/action-hosting-deploy@/.test(wf));
check('it builds the directory firebase.json publishes', wf.includes('npm run build --prefix frontend') && fb.hosting.public === 'frontend/dist');
check('the service account comes from a secret, never the file system', /secrets\.FIREBASE_SERVICE_ACCOUNT/.test(wf) && !/serviceAccountKey|\.json/.test(wf.replace(/package-lock\.json|firebase\.json|\.env\.production|package\.json/g, '')));

console.log('\n=== THE RELEASE GUARDS STILL RUN ===');
// deploy:web runs phase31 and phase36 before firebase deploy; the workflow must too, or
// the browser path becomes the way secrets and broken installs slip out.
const local = JSON.parse(readFileSync('package.json', 'utf8')).scripts['deploy:web'];
for (const guard of local.match(/tests\/phase\d+\.mjs/g)) {
  check(`${guard} runs before the upload`, wf.indexOf(guard) !== -1 && wf.indexOf(guard) < wf.indexOf('action-hosting-deploy@'));
}
check('the live site is verified after the upload',
  wf.indexOf('tests/phase37.mjs https://') > wf.indexOf('action-hosting-deploy@'));

console.log('\n=== THE BUILD CANNOT SHIP WITH PLACEHOLDER SETTINGS ===');
for (const k of ['VITE_API_URL', 'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
                 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID']) {
  check(`${k} is required`, wf.includes(`'${k}'`));
}
check('the placeholder API address is rejected', /YOUR-DOMAIN/.test(wf));
check('a non-https API address is rejected', wf.includes('^https:'));
check('settings can come from repository Variables (set in the GitHub UI)', /toJSON\(vars\)/.test(wf));

console.log('\n=== NOTHING SECRET CAN REACH THE REPOSITORY ===');
const gi = readFileSync('.gitignore', 'utf8');
for (const p of ['backend/.env', 'frontend/.env', '.firebase/']) check(`.gitignore covers ${p}`, gi.includes(p));
check('frontend/.env.production is committed (public values only)', !/^frontend\/\.env\.production$/m.test(gi) && !/^\.env\.production$/m.test(gi));

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
