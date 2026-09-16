import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { applySecurityMiddleware, globalLimiter } from './middleware/security';
import { router } from './routes';
import { initSocketIO } from './socket';

const app = express();
const httpServer = createServer(app);

/**
 * Which browsers may call the API.
 *
 * Firebase Hosting serves the same site on two domains — `<project>.web.app` and
 * `<project>.firebaseapp.com` — and a rider can arrive on either. A single-origin CORS
 * setting silently refuses whichever one it is not, with nothing but a console error
 * on the phone. So FRONTEND_URL is a comma-separated list, and only an unset value
 * falls back to allow-all, which is fine on a dev machine and wrong anywhere else.
 */
const allowedOrigins: string[] | '*' = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean)
  : '*';

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

applySecurityMiddleware(app);

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(globalLimiter);

app.use('/api', router);
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

initSocketIO(io);

const PORT = parseInt(process.env.PORT || '3001', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`RiderHub API running on port ${PORT}`);
});

export { io };
