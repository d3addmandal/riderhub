/**
 * The API as a Cloud Function for Firebase (2nd gen).
 *
 * Firebase Hosting rewrites `/api/**` to this function (see firebase.json), so the site
 * and the API share one origin: no CORS, no mixed content, no second hostname or
 * certificate to run. The function is the whole Express app; every request that
 * reaches it is handled and answered by the same code the dev server runs.
 *
 * Secrets are read from Cloud Secret Manager and exposed to the running function as
 * environment variables, so the route code keeps reading `process.env.*` unchanged.
 * They are created once in the Google Cloud console (DEPLOY.md, step 4) and are never
 * in the repository or the build.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { app } from './app';

export const api = onRequest(
  {
    // Mumbai: closest region to the riders. Hosting proxies to any region.
    region: 'asia-south1',
    // firebase-admin + Express idle at ~120 MB; 512 keeps headroom for photo proxying.
    memory: '512MiB',
    timeoutSeconds: 60,
    // A hard ceiling on cost if something misbehaves: ten instances is far beyond a
    // club's traffic, and well inside the free tier at that scale.
    maxInstances: 10,
    // Zero keeps the function free when idle; the price is a cold start of a few
    // seconds on the first request after a quiet spell.
    minInstances: 0,
    secrets: [
      defineSecret('GOOGLE_MAPS_API_KEY'),
      defineSecret('GOOGLE_MAPS_BROWSER_KEY'),
      defineSecret('TELEGRAM_BOT_TOKEN'),
    ],
  },
  app
);
