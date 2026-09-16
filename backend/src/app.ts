import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { applySecurityMiddleware, globalLimiter } from './middleware/security';
import { router } from './routes';

/**
 * The Express app, without a listener.
 *
 * Two things mount it: `index.ts` for a local dev server, and `function.ts` as a Cloud
 * Function behind Firebase Hosting. Keeping the app free of `listen()` is what makes the
 * second one possible — a function hands each request to the app and returns; nothing
 * may hold a port or a long-lived connection (which is also why there is no Socket.IO:
 * riders' positions are polled through the REST API instead).
 */
export const app = express();

/*
 * Behind a proxy the client address arrives in X-Forwarded-For, and without saying so
 * the rate limiter keys every rider on the proxy's own address — throttling the whole
 * club as if it were one user.
 *
 * How much of that header to believe differs by host, and getting it wrong the other
 * way lets anyone forge an address and slip the limit:
 *   Cloud Run (K_SERVICE is set there and nowhere else) manages the header itself.
 *   Caddy on Oracle is exactly one hop, so only the last entry is trustworthy.
 * Left unset — a dev machine — nothing is trusted, which is correct for a direct
 * connection.
 */
if (process.env.K_SERVICE) app.set('trust proxy', true);
else if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

/**
 * Which browsers may call the API.
 *
 * On Firebase the site and the API share one origin (Hosting rewrites /api to the
 * function), so CORS never triggers there. FRONTEND_URL only matters if the API is ever
 * served from a different host: a comma-separated list, because Hosting answers on both
 * `<project>.web.app` and `<project>.firebaseapp.com`. Unset falls back to allow-all,
 * which is right for a dev machine.
 */
const allowedOrigins: string[] | '*' = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean)
  : '*';

applySecurityMiddleware(app);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(globalLimiter);

app.use('/api', router);
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
