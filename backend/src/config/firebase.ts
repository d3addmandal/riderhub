import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';
import dotenv from 'dotenv';
dotenv.config();

// Cloud Storage is deliberately not used. Since 3 Feb 2026 it requires a Blaze billing
// account, and this app must stay free to run — so the documents vault tracks expiry
// metadata only, with no file uploads. Auth and Firestore remain free on Spark.

// Inside Cloud Functions the project id arrives in FIREBASE_CONFIG / GCLOUD_PROJECT and
// the runtime already carries credentials, so no key is needed there at all. The
// FIREBASE_* variables below are only for a dev machine (or any other host).
const runningInFunctions = Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);
const projectId = process.env.FIREBASE_PROJECT_ID
  || process.env.GCLOUD_PROJECT
  || (process.env.FIREBASE_CONFIG ? (JSON.parse(process.env.FIREBASE_CONFIG).projectId as string | undefined) : undefined);
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
// Private keys pasted into .env keep their newlines escaped as \n — restore them.
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

// The emulator suite advertises itself through these standard variables. When they are
// present the Admin SDK talks to localhost, and a service account is neither needed
// nor used — see `firebase emulators:start`.
const useEmulators = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST
);

if (!projectId) {
  throw new Error('Missing FIREBASE_PROJECT_ID in environment');
}

if (!useEmulators && !runningInFunctions && (!clientEmail || !privateKey)) {
  throw new Error(
    'Missing Firebase Admin credentials. Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in environment'
  );
}

function createApp(): App {
  if (runningInFunctions && !useEmulators) {
    // Application Default Credentials: the function's own service account.
    return initializeApp();
  }
  if (useEmulators) {
    console.log(`Firebase Admin running against emulators (project: ${projectId})`);
    return initializeApp({ projectId });
  }

  try {
    return initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  } catch (err) {
    // Nearly always a mangled FIREBASE_PRIVATE_KEY — unquoted in .env, or with its
    // \n escapes stripped. The raw OpenSSL DECODER error is not much of a hint.
    throw new Error(
      'Firebase Admin failed to initialise. Check FIREBASE_PRIVATE_KEY is wrapped in ' +
      'double quotes and still contains its \\n escapes exactly as in the service ' +
      `account JSON.\nUnderlying error: ${err instanceof Error ? err.message : err}`
    );
  }
}

const app: App = getApps().length ? getApps()[0] : createApp();

export const db: Firestore = getFirestore(app);
export const auth: Auth = getAuth(app);

db.settings({ ignoreUndefinedProperties: true });

// ── Collection names ─────────────────────────────────────────
export const COL = {
  profiles: 'profiles',
  motorcycles: 'motorcycles',
  rides: 'rides',
  rideGroups: 'rideGroups',
  members: 'members', // subcollection of rideGroups
  fuelEntries: 'fuelEntries',
  serviceRecords: 'serviceRecords',
  maintenance: 'maintenance',
  expenses: 'expenses',
  documents: 'documents',
  reminders: 'reminders',
  sosEvents: 'sosEvents',
  issues: 'issues',        // things the rider noticed, to be fixed at the next service
} as const;
