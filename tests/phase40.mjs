// Caddy on Oracle must deliver exactly what Firebase Hosting delivered.
//
// The same app is served two ways now, and the guarantees live in two unrelated files —
// firebase.json and deploy/Caddyfile. Nothing stops one from being fixed and the other
// forgotten, and the difference is invisible until a rider is stuck on a cached shell or
// a deep link 404s. So firebase.json stays the single source of truth for what the
// headers should be, and this reads the Caddyfile back against it.
//
// Static checks: Caddy cannot run here. The live site is the real proof —
// `node tests/phase37.mjs https://<domain>`, which the deploy workflow runs for us.
import { readFileSync, existsSync } from 'node:fs';

const CADDY = 'deploy/Caddyfile';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const caddy = existsSync(CADDY) ? readFileSync(CADDY, 'utf8') : '';
const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting;
const ruleFor = (src) => Object.fromEntries((hosting.headers.find(h => h.source === src)?.headers ?? [])
  .map(h => [h.key.toLowerCase(), h.value]));

console.log('\n=== THE CADDYFILE EXISTS AND IS COHERENT ===');
check('deploy/Caddyfile is present', caddy.length > 0);
check('it serves one hostname from configuration, not a hardcoded domain', /\{\$RIDERHUB_DOMAIN\}/.test(caddy));
check('a contact address is set for certificate expiry warnings', /email \{\$RIDERHUB_ACME_EMAIL\}/.test(caddy));
// Curly-brace balance catches the usual hand-editing mistake, which Caddy would reject
// on reload — taking the whole site down rather than just the new bit.
check('braces balance', (caddy.match(/\{/g) ?? []).length === (caddy.match(/\}/g) ?? []).length,
  `${(caddy.match(/\{/g) ?? []).length} open, ${(caddy.match(/\}/g) ?? []).length} close`);

console.log('\n=== THE API IS REACHED, AND NOT SWALLOWED BY THE APP ===');
const apiAt = caddy.indexOf('handle /api/*');
const spaAt = caddy.search(/^\thandle \{$/m);
check('/api/* is proxied to the API process', apiAt !== -1 && /handle \/api\/\*\s*\{\s*reverse_proxy 127\.0\.0\.1:/.test(caddy));
check('it is matched before the catch-all, or every API call returns index.html',
  apiAt !== -1 && spaAt !== -1 && apiAt < spaAt);
check('the API port is configurable and non-standard', /\{\$RIDERHUB_API_PORT:(\d+)\}/.test(caddy) &&
  Number(caddy.match(/\{\$RIDERHUB_API_PORT:(\d+)\}/)[1]) > 1024);
check('the proxy target is localhost, so nothing else can reach the API',
  !/reverse_proxy (?!127\.0\.0\.1)/.test(caddy));
check('/health is reachable for the deploy check', /handle \/health/.test(caddy));
check('deep links fall back to the app shell', /try_files \{path\} \/index\.html/.test(caddy));
check('static files are actually served', /file_server/.test(caddy));

console.log('\n=== HEADERS MATCH WHAT FIREBASE HOSTING SENDS ===');
// The two hosts resolve overlapping header rules in opposite directions: Firebase applies
// every match in order and the last wins, while Caddy's header directives wrap each other
// so the first one written is outermost and applies last. Encoding that in a comment and
// hoping is how every hashed asset came back no-cache. The Caddyfile makes its caching
// matchers mutually exclusive instead; these check they stayed that way.
check('exactly one caching rule can match any request',
  caddy.includes('@shell not path /assets/* *.png *.ico *.svg *.webp /sw.js /registerSW.js /manifest.webmanifest'));
check('the image rule does not also claim hashed assets',
  /@images \{[\s\S]*?not path \/assets\/\*[\s\S]*?\}/.test(caddy));
check('the unconditional header block sets no Cache-Control to shadow them',
  !/header \{[^}]*Cache-Control[^}]*\}/.test(caddy.slice(caddy.indexOf('route {'))));

const security = ruleFor('**');
delete security['cache-control'];   // carried by @shell in Caddy; checked on its own below
for (const [key, value] of Object.entries(security)) {
  // Caddy quotes values containing spaces; compare on the value itself.
  const re = new RegExp(`${key.replace(/[-]/g, '-')}\\s+"?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`, 'i');
  check(`${key}: ${value}`, re.test(caddy));
}
check('the app shell is not cached (the one that pins riders to old code)',
  caddy.includes('header @shell Cache-Control "no-cache, must-revalidate"') &&
  ruleFor('**')['cache-control'] === 'no-cache, must-revalidate');

const assets = ruleFor('/assets/**')['cache-control'];
check(`hashed assets: ${assets}`, caddy.includes(`header /assets/* Cache-Control "${assets}"`));
const images = ruleFor('**/*.@(png|ico|svg|webp)')['cache-control'];
check(`images: ${images}`, caddy.includes(`header @images Cache-Control "${images}"`));
check('the image matcher covers the same extensions as the Hosting glob',
  /@images \{[\s\S]*?path \*\.png \*\.ico \*\.svg \*\.webp/.test(caddy));

const sw = ruleFor('/sw.js');
check(`sw.js: ${sw['cache-control']}`, caddy.includes(`Cache-Control "${sw['cache-control']}"`));
check('sw.js may control the whole origin', new RegExp(`Service-Worker-Allowed "${sw['service-worker-allowed']}"`).test(caddy));
check('registerSW.js is not cached either', /header \/registerSW\.js Cache-Control "no-cache/.test(caddy));
const man = ruleFor('/manifest.webmanifest');
check(`manifest content type: ${man['content-type']}`, caddy.includes(`Content-Type "${man['content-type']}"`));

console.log('\n=== THE API PROCESS IS NOT EXPOSED DIRECTLY ===');
const index = readFileSync('backend/src/index.ts', 'utf8');
const app = readFileSync('backend/src/app.ts', 'utf8');
check('it binds localhost unless told otherwise', /BIND_HOST \|\| '127\.0\.0\.1'/.test(index));
check('binding elsewhere is a deliberate choice, not the default', /process\.env\.BIND_HOST/.test(index));
check('the proxy hop count is configurable for Caddy', /TRUST_PROXY/.test(app));
check('a dev machine trusts no proxy header', !/app\.set\('trust proxy', true\);\s*$/m.test(app.split('else if')[0].split('if (process.env.K_SERVICE)')[0]));

console.log('\n=== ONE COMMAND PROVISIONS AND DEPLOYS ===');
// The box is driven entirely by run.sh: the first run provisions it, every run after
// syncs and redeploys. If it quietly stops doing one of these, the failure is remote.
check('run.sh is in the repo', existsSync('run.sh'));
const run = readFileSync('run.sh', 'utf8');
check('it refuses to run without root rather than half-failing', /EUID -eq 0/.test(run));
check('it stops at the first error instead of carrying on', /set -euo pipefail/.test(run));
check('it pulls from GitHub on a normal run', /pull --ff-only/.test(run));
check('--no-pull exists for rebuilding what is already there', /--no-pull/.test(run));
check('it explains deploy keys when a private pull is refused', /Deploy keys/.test(run));
check('it builds both halves', /backend"\s+run build/.test(run) && /frontend" run build/.test(run));
check('it installs devDependencies, which the build itself needs', !/--omit=dev/.test(run));

console.log('\n=== THE PUBLIC PORTS ARE NOT ASSUMED TO BE FREE ===');
// Another application may already own 80 and 443. Caddy can move; Let's Encrypt cannot —
// the ACME spec fixes validation to those two ports — so moving has to bring the DNS
// challenge with it, or no certificate is ever issued and the site cannot be used at all.
check('the ports are configuration, not baked into the Caddyfile',
  caddy.includes('{$RIDERHUB_HTTPS_PORT:443}') && caddy.includes('{$RIDERHUB_HTTP_PORT:80}'));
check('the site address carries the chosen https port',
  caddy.includes('{$RIDERHUB_DOMAIN}:{$RIDERHUB_HTTPS_PORT:443}'));
check('run.sh takes --https-port and --http-port',
  run.includes('--https-port=*') && run.includes('--http-port=*'));
check('it rejects a value that is not a port number', run.includes('is not a port number'));
check('it falls back to 8443/8080 when the standard ports are taken',
  run.includes('HTTPS_PORT=8443') && run.includes('HTTP_PORT=8080'));
check('it names whatever holds a port it needs', run.includes('is held by'));
check('it opens the chosen ports rather than a hardcoded pair',
  /for p in "\$HTTPS_PORT" "\$HTTP_PORT"[\s\S]{0,400}--dport "\$p"/.test(run));

console.log('\n=== A CERTIFICATE IS STILL OBTAINABLE ON ODD PORTS ===');
check('the tls strategy is imported, so one Caddyfile covers both cases',
  caddy.includes('import /etc/caddy/riderhub-tls.caddy'));
check('standard ACME is used whenever 80 or 443 is ours',
  run.includes('"$HTTPS_PORT" == 443 || "$HTTP_PORT" == 80'));
check('otherwise it switches to the DNS challenge', run.includes('dns duckdns'));
check('it adds the DNS provider Caddy does not ship with',
  run.includes('caddy add-package github.com/caddy-dns/duckdns'));
check('it refuses rather than pretending when no challenge is possible',
  run.includes('leave no way to get a certificate'));
check('it asks for the token needed to write the challenge record',
  run.includes('A DuckDNS token is needed to get a certificate'));
// That token lands in a file Caddy reads; it must not be readable by everyone.
check('the snippet holding the token is locked down',
  run.includes('chmod 600 "$TLS_SNIPPET"') && run.includes('chown caddy:caddy "$TLS_SNIPPET"'));
check('a non-standard port becomes part of the address riders are given',
  run.includes('SITE_URL="$SITE_URL:$HTTPS_PORT"'));

console.log('\n=== A DEPLOY CANNOT QUIETLY BREAK THE SITE ===');
// Anchored to a line of its own: the same words appear in a comment further up, and
// matching that would have made this check pass for the wrong reason.
const restartAt = run.search(/^systemctl restart riderhub-api$/m);
check('the release guards run before the service is restarted',
  ['phase31', 'phase36', 'phase40'].every(t => run.includes(t)) &&
  restartAt > 0 && run.indexOf('phase31') < restartAt);
check('the Caddyfile is validated before it is reloaded',
  /caddy validate/.test(run) && run.indexOf('caddy validate') < run.indexOf('systemctl reload caddy'));
check('a bad Caddyfile leaves the running site alone', /the site is still up/.test(run));
check('success is not claimed until the API answers',
  run.includes('/health') && /journalctl -u riderhub-api/.test(run));
check('it opens both 80 and 443 in the instance firewall', /for port in 80 443/.test(run));
check('it says the VCN security list is a separate step', /VCN/.test(run));
check('it adds swap on small shapes, where a build is otherwise OOM-killed',
  /swapfile/.test(run) && /RAM_MB < 2048/.test(run));
check('it reminds you to authorise the new domain for sign-in and Maps',
  /Authorized domains/.test(run) && /Website restrictions/.test(run));

console.log('\n=== THE SERVICE SURVIVES A REBOOT ===');
const unit = readFileSync('deploy/riderhub-api.service', 'utf8');
check('the API runs as its own unprivileged user', /User=riderhub/.test(unit));
check('it restarts after a crash', /Restart=always/.test(unit));
check('it comes back after a reboot', /WantedBy=multi-user\.target/.test(unit));
check('secrets come from a file outside the repo', /EnvironmentFile=\/etc\/riderhub\/api\.env/.test(unit));
check('the home directory is off limits to the service', /ProtectHome=true/.test(unit));
// The unit is a template. Copied into place by hand the placeholder stays literal and
// systemd fails on a path that does not exist, so the substitution must be in run.sh.
check('the unit is a template that run.sh fills in',
  /__APP_DIR__/.test(unit) && run.includes('__APP_DIR__'));
check('the app lives outside /home, which ProtectHome would otherwise block',
  /APP_HOME=\/srv\/riderhub/.test(run) && /APP_DIR="?\$APP_HOME\/app/.test(run));

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
