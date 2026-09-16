import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Express } from 'express';

export function applySecurityMiddleware(app: Express) {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
      },
    },
  }));
}

/**
 * Overridable so an automated test run can exercise hundreds of endpoints from one
 * address without tripping a limit meant for the open internet. Left unset — which is the
 * case in production — the original ceilings apply unchanged.
 */
const envMax = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envMax('RATE_LIMIT_MAX', 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envMax('AUTH_RATE_LIMIT_MAX', 20),
  message: { error: 'Too many auth attempts' },
});
