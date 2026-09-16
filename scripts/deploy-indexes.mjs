#!/usr/bin/env node
/**
 * Creates the composite indexes in firestore.indexes.json using the service account
 * already in backend/.env — no `firebase login` and no browser required.
 *
 *   npm run deploy:indexes
 *
 * Firestore rejects a duplicate index with 409, which we treat as success, so this is
 * safe to run repeatedly.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'backend', 'package.json'));

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

function parseEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = parseEnv(join(ROOT, 'backend', '.env'));
const projectId = env.FIREBASE_PROJECT_ID;
if (!projectId || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
  console.error(`${c.red}backend/.env is missing Firebase credentials.${c.reset} Run npm run setup.`);
  process.exit(1);
}

const { GoogleAuth } = require('google-auth-library');
const auth = new GoogleAuth({
  credentials: {
    client_email: env.FIREBASE_CLIENT_EMAIL,
    private_key: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/datastore'],
});

const client = await auth.getClient();
const { token } = await client.getAccessToken();

const spec = JSON.parse(readFileSync(join(ROOT, 'firestore.indexes.json'), 'utf8'));
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups`;

console.log(`${c.bold}\n🔧 Deploying ${spec.indexes.length} composite indexes to "${projectId}"${c.reset}\n`);

let created = 0, existed = 0, failed = 0;

for (const idx of spec.indexes) {
  const label = `${idx.collectionGroup}(${idx.fields.map(f => `${f.fieldPath} ${f.order === 'DESCENDING' ? '↓' : '↑'}`).join(', ')})`;
  const body = {
    queryScope: idx.queryScope || 'COLLECTION',
    fields: idx.fields.map(f => ({ fieldPath: f.fieldPath, order: f.order })),
  };

  try {
    const res = await fetch(`${base}/${idx.collectionGroup}/indexes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      created++;
      console.log(`  ${c.green}+${c.reset} ${label}`);
    } else {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      if (res.status === 409 || /already exists/i.test(msg)) {
        existed++;
        console.log(`  ${c.dim}=${c.reset} ${c.dim}${label} — already present${c.reset}`);
      } else if (res.status === 403) {
        failed++;
        console.log(`  ${c.red}✗${c.reset} ${label}`);
        console.log(`    ${c.dim}${msg}${c.reset}`);
      } else {
        failed++;
        console.log(`  ${c.red}✗${c.reset} ${label} — ${msg}`);
      }
    }
  } catch (e) {
    failed++;
    console.log(`  ${c.red}✗${c.reset} ${label} — ${e.message}`);
  }
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`created ${created} · already present ${existed} · failed ${failed}`);

if (failed) {
  console.log(`\n${c.yellow}Some indexes could not be created.${c.reset}`);
  console.log(`${c.dim}If the errors mention permission, grant the service account the
"Cloud Datastore Index Admin" role, or fall back to:
  firebase login && firebase deploy --only firestore:indexes${c.reset}`);
  process.exit(1);
}

console.log(`\n${c.green}Done.${c.reset} Indexes build in the background — usually a few minutes.`);
console.log(`${c.dim}Track progress: https://console.firebase.google.com/project/${projectId}/firestore/indexes${c.reset}\n`);
