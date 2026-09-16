import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

/**
 * Client configuration, handed out only to a signed-in rider.
 *
 * The Google Maps JavaScript API has to run in the browser, and it has to be given a key
 * to do it. There is no arrangement where the browser renders a Google map without one.
 * What this endpoint changes is *how the browser gets it*: instead of being compiled into
 * a static bundle that anyone can download and grep, it is fetched at runtime behind
 * Firebase auth.
 *
 * Be clear about what that does and does not buy:
 *
 *   - It removes the key from a publicly fetchable file. A scraper hitting the site
 *     anonymously no longer finds it.
 *   - It lets the key be rotated without rebuilding and redeploying the frontend.
 *   - It does NOT make the key secret. Any signed-in rider can read it from their own
 *     network tab. That is unavoidable for a browser-side Maps key.
 *
 * The control that actually protects the key is an **HTTP referrer restriction** in the
 * Google Cloud console, locking it to your own domains, plus limiting it to the Maps
 * JavaScript API alone. Use a *separate* key here from the server key: the server one
 * calls Routes, Places and Geocoding and must never be exposed at all.
 */
router.get('/maps', requireAuth, (_req: AuthRequest, res: Response) => {
  // A browser-specific key if one is configured; otherwise fall back to the server key
  // so a single-key setup still works, at the cost of exposing more surface.
  const browserKey = process.env.GOOGLE_MAPS_BROWSER_KEY?.trim();
  const serverKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const key = browserKey || serverKey || '';

  res.set('Cache-Control', 'private, no-store');
  res.json({
    maps_key: key,
    map_id: process.env.GOOGLE_MAPS_MAP_ID?.trim() || null,
    configured: Boolean(key),
    /**
     * Surfaced so the setup doctor can warn about it rather than it going unnoticed:
     * reusing the unrestricted server key in the browser is workable but not the
     * arrangement you want in production.
     */
    using_shared_key: !browserKey && Boolean(serverKey),
  });
});

export default router;
