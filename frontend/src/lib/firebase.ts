import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, browserLocalPersistence, setPersistence } from 'firebase/auth';

// Auth only — no Cloud Storage. It needs a Blaze billing account as of Feb 2026, and this
// app is built to run free, so the documents vault stores expiry metadata rather than files.
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

if (!config.apiKey || !config.projectId || !config.authDomain) {
  throw new Error('Missing Firebase environment variables. Check your .env file.');
}

export const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);

// Keep the rider signed in across app restarts — this is a PWA people open mid-ride.
setPersistence(auth, browserLocalPersistence).catch(err => console.warn('Could not set auth persistence:', err)
);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/** Current user's ID token, or null when signed out. Refreshes automatically when stale. */
export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}
