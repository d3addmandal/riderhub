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

// Behind Firebase Hosting → Cloud Run the client address arrives in X-Forwarded-For.
// Without this the rate limiter would key every rider on the proxy's address and
// throttle the whole club as one user. K_SERVICE is set by Cloud Run, nowhere else.
if (process.env.K_SERVICE) app.set('trust proxy', true);

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
