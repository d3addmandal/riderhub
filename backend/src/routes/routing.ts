import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';
import { haversineKm } from './rides';
import { decodePolyline } from '../lib/polyline';

const router = Router();

/**
 * Road routing for live navigation, on the Google Routes API.
 *
 * Why Google rather than an open provider: Google's terms forbid using its content
 * alongside a non-Google basemap, and the app renders a Google map. Mixing providers
 * would breach the licence, so the whole navigation stack is Google.
 *
 * If the key is missing, or Google errors or is out of quota, we fall back to a straight
 * line. Navigation degrades to bearing-and-distance rather than breaking — which is what
 * a rider needs anyway when the network is poor.
 */

const ROUTES_URL = process.env.GOOGLE_ROUTES_URL?.trim()
  || 'https://routes.googleapis.com/directions/v2:computeRoutes';

const coord = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * The three route profiles.
 *
 * Only `bike` changes which roads are eligible: Google's TWO_WHEELER mode knows about
 * the expressways and bridges that bar two-wheelers, which is the whole reason a rider
 * needs this. `general` and `car` both run Google's DRIVE engine — there is no third
 * engine — so they are separated by what they avoid rather than by pretending otherwise.
 */
export const ROUTE_MODES = {
  general: { travelMode: 'DRIVE',       label: 'General',    icon: '➤' },
  bike:    { travelMode: 'TWO_WHEELER', label: 'Motorcycle', icon: '🏍️' },
  car:     { travelMode: 'DRIVE',       label: 'Car',        icon: '🚗' },
} as const;

export type RouteMode = keyof typeof ROUTE_MODES;

const routeSchema = z.object({
  from: coord,
  to: coord,
  via: z.array(coord).max(8).optional(),
  mode: z.enum(['general', 'bike', 'car']).optional(),
  avoid_tolls: z.boolean().optional(),
  avoid_highways: z.boolean().optional(),
  avoid_ferries: z.boolean().optional(),
  /** Ask Google for other ways round. Ignored when the route has stops — see below. */
  alternatives: z.boolean().optional(),
});

export interface RouteStep {
  instruction: string;
  distance_m: number;
  duration_s: number;
  /** Where the manoeuvre happens — drives "in 300 m, turn left". */
  end: { lat: number; lng: number } | null;
  /** Google's manoeuvre code, e.g. TURN_LEFT, ROUNDABOUT_RIGHT. */
  maneuver: string | null;
}

/**
 * One hop between consecutive waypoints.
 *
 * Carrying each leg's own geometry lets the map draw the whole journey while
 * highlighting the leg being ridden — from a single routing call.
 */
export interface RouteLeg {
  distance_m: number;
  duration_s: number;
  geometry: [number, number][];
  steps: RouteStep[];
}

export interface RouteResult {
  provider: 'google' | 'straight-line';
  geometry: [number, number][];
  distance_m: number;
  duration_s: number;
  steps: RouteStep[];
  /**
   * Per-waypoint breakdown. Asking for the whole remaining route in one call and
   * reading the legs is far cheaper than one request per stop.
   */
  legs: RouteLeg[];
  approximate: boolean;
  /** True when the ETA accounts for live traffic. */
  traffic_aware?: boolean;
  note?: string;
  /** Which profile produced this. */
  mode?: RouteMode;
  /** Human label for the way round, e.g. "NH 48". */
  summary?: string;
  /** Google's own tags, e.g. FUEL_EFFICIENT / DEFAULT_ROUTE. */
  labels?: string[];
  /**
   * Every way round Google offered, fastest first, this one included at index 0.
   * Only populated on the primary response.
   */
  alternatives?: RouteResult[];
  /** Set when alternatives were asked for but cannot be produced. */
  alternatives_note?: string;
}

// ── Cache ─────────────────────────────────────────────────────
// Protects the quota and keeps re-opening the map instant. Traffic-aware ETAs go stale,
// so this window is deliberately short.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: RouteResult }>();

/** The key must include the profile and avoidances, or a car route serves a bike one. */
const cacheKey = (
  pts: { lat: number; lng: number }[],
  mode: RouteMode,
  mods: { tolls?: boolean; highways?: boolean; ferries?: boolean },
  alts: boolean,
) => [
  pts.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|'),
  mode,
  `${mods.tolls ? 't' : ''}${mods.highways ? 'h' : ''}${mods.ferries ? 'f' : ''}`,
  alts ? 'alt' : '',
].join('#');

function cacheGet(key: string): RouteResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key: string, value: RouteResult) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

// ── Fallback ──────────────────────────────────────────────────
function straightLine(
  pts: { lat: number; lng: number }[],
  note: string,
  mode: RouteMode = 'general',
): RouteResult {
  const legs: RouteLeg[] = [];
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const legKm = haversineKm(pts[i - 1], pts[i]);
    km += legKm;
    legs.push({
      distance_m: Math.round(legKm * 1000),
      duration_s: Math.round((legKm / 40) * 3600),
      geometry: [[pts[i - 1].lng, pts[i - 1].lat], [pts[i].lng, pts[i].lat]],
      steps: [],
    });
  }
  return {
    provider: 'straight-line',
    geometry: pts.map(p => [p.lng, p.lat] as [number, number]),
    distance_m: Math.round(km * 1000),
    duration_s: Math.round((km / 40) * 3600),
    steps: [],
    legs,
    approximate: true,
    mode,
    note,
  };
}

/** Strip the HTML Google puts in navigation instructions. */
function plainText(s: string): string {
  return (s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Durations come back as "1234s". */
const secs = (v: unknown) => Math.round(parseFloat(String(v ?? '0s')) || 0);

// ── Google Routes ─────────────────────────────────────────────
interface FetchOpts {
  mode: RouteMode;
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  avoidFerries?: boolean;
  wantAlternatives?: boolean;
}

async function fetchRoute(pts: { lat: number; lng: number }[], opts: FetchOpts): Promise<RouteResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return straightLine(pts, 'No routing key configured — showing a direct line.', opts.mode);

  const waypoint = (p: { lat: number; lng: number }) => ({
    location: { latLng: { latitude: p.lat, longitude: p.lng } },
  });

  const hasStops = pts.length > 2;
  // Google refuses alternatives once the route has intermediates. Asking anyway would
  // simply be ignored, so the UI is told plainly rather than shown an empty list.
  const askAlternatives = Boolean(opts.wantAlternatives) && !hasStops;

  const body = {
    origin: waypoint(pts[0]),
    destination: waypoint(pts[pts.length - 1]),
    ...(hasStops ? { intermediates: pts.slice(1, -1).map(waypoint) } : {}),
    travelMode: ROUTE_MODES[opts.mode].travelMode,
    ...(askAlternatives ? { computeAlternativeRoutes: true } : {}),
    routeModifiers: {
      avoidTolls: Boolean(opts.avoidTolls),
      avoidHighways: Boolean(opts.avoidHighways),
      avoidFerries: Boolean(opts.avoidFerries),
    },
    // Live-traffic ETA. This is the Advanced SKU (5,000 free/month) rather than Basic —
    // at club scale that is a few hundred calls, and traffic is the reason to use Google.
    routingPreference: 'TRAFFIC_AWARE',
    polylineQuality: 'HIGH_QUALITY',
    languageCode: 'en-IN',
    units: 'METRIC',
  };

  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        // The field mask decides what is billed. Only what the nav card renders.
        'X-Goog-FieldMask': [
          'routes.duration',
          'routes.distanceMeters',
          'routes.polyline.encodedPolyline',
          // Names the way round, so alternatives read as "via NH 48" not "Route 2".
          'routes.description',
          'routes.routeLabels',
          // Per-leg totals so each upcoming stop can show its own distance and ETA
          // without a request each.
          'routes.legs.distanceMeters',
          'routes.legs.duration',
          // Per-leg geometry so the map can draw the whole journey and still highlight
          // the leg being ridden, without a second request.
          'routes.legs.polyline.encodedPolyline',
          'routes.legs.steps.navigationInstruction',
          'routes.legs.steps.distanceMeters',
          'routes.legs.steps.staticDuration',
          // Where each manoeuvre happens — needed for "in 300 m, turn left".
          'routes.legs.steps.endLocation',
        ].join(','),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const detail = res.status === 429
        ? 'Routing quota reached — showing a direct line.'
        : res.status === 403
          ? 'Routing key rejected. Check the Routes API is enabled and the key is unrestricted for server use.'
          : `Routing unavailable (${res.status}) — showing a direct line.`;
      return straightLine(pts, detail, opts.mode);
    }

    const data: any = await res.json();
    if (!data?.routes?.length) {
      return straightLine(pts, 'No road route found — showing a direct line.', opts.mode);
    }

    const mapStep = (s: any): RouteStep => ({
      instruction: plainText(s.navigationInstruction?.instructions ?? ''),
      distance_m: Math.round(s.distanceMeters ?? 0),
      duration_s: secs(s.staticDuration),
      end: s.endLocation?.latLng
        ? { lat: s.endLocation.latLng.latitude, lng: s.endLocation.latLng.longitude }
        : null,
      maneuver: s.navigationInstruction?.maneuver ?? null,
    });

    const mapRoute = (route: any): RouteResult | null => {
      const encoded = route?.polyline?.encodedPolyline;
      if (!encoded) return null;

      const legs: RouteLeg[] = (route.legs ?? []).map((leg: any) => ({
        distance_m: Math.round(leg.distanceMeters ?? 0),
        duration_s: secs(leg.duration),
        geometry: leg.polyline?.encodedPolyline ? decodePolyline(leg.polyline.encodedPolyline) : [],
        steps: (leg.steps ?? []).map(mapStep).filter((s: RouteStep) => s.instruction),
      }));

      return {
        provider: 'google',
        geometry: decodePolyline(encoded),
        distance_m: Math.round(route.distanceMeters ?? 0),
        duration_s: secs(route.duration),
        // Flattened for callers that just want the next instruction.
        steps: legs.flatMap(l => l.steps),
        legs,
        approximate: false,
        traffic_aware: true,
        mode: opts.mode,
        summary: plainText(route.description ?? '') || undefined,
        labels: route.routeLabels ?? undefined,
      };
    };

    const mapped = (data.routes as any[]).map(mapRoute).filter(Boolean) as RouteResult[];
    if (!mapped.length) {
      return straightLine(pts, 'No road route found — showing a direct line.', opts.mode);
    }

    // Fastest first, so "the default is the quickest" is simply index 0.
    mapped.sort((a, b) => a.duration_s - b.duration_s);

    const primary: RouteResult = { ...mapped[0] };
    if (opts.wantAlternatives) {
      // Nesting is stripped from each alternative so the payload stays flat.
      primary.alternatives = mapped.map(r => ({ ...r, alternatives: undefined }));
      if (hasStops) {
        primary.alternatives_note =
          'Google only offers other ways round when the route has no stops in between.';
      } else if (mapped.length === 1) {
        primary.alternatives_note = 'Only one sensible way round from here.';
      }
    }
    return primary;
  } catch (e: any) {
    return straightLine(pts, e?.name === 'TimeoutError'
      ? 'Routing timed out — showing a direct line.'
      : 'Could not reach the routing service — showing a direct line.', opts.mode);
  }
}

// ── Endpoint ──────────────────────────────────────────────────
router.post('/route', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { from, to, via, mode = 'general', alternatives } = parsed.data;
  const pts = [from, ...(via ?? []), to];
  const mods = {
    tolls: parsed.data.avoid_tolls,
    highways: parsed.data.avoid_highways,
    ferries: parsed.data.avoid_ferries,
  };

  if (pts.length === 2 && haversineKm(pts[0], pts[1]) < 0.02) {
    res.json(straightLine(pts, 'You are already there.', mode));
    return;
  }

  const key = cacheKey(pts, mode, mods, Boolean(alternatives));
  const cached = cacheGet(key);
  if (cached) { res.json({ ...cached, cached: true }); return; }

  const route = await fetchRoute(pts, {
    mode,
    avoidTolls: mods.tolls,
    avoidHighways: mods.highways,
    avoidFerries: mods.ferries,
    wantAlternatives: alternatives,
  });
  if (!route.approximate) cacheSet(key, route);

  res.json(route);
});

/** What the mode picker renders, so the labels live in one place. */
router.get('/modes', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({
    modes: (Object.keys(ROUTE_MODES) as RouteMode[]).map(k => ({
      id: k,
      label: ROUTE_MODES[k].label,
      icon: ROUTE_MODES[k].icon,
      travel_mode: ROUTE_MODES[k].travelMode,
      // Stated plainly so nobody assumes three different engines.
      respects_two_wheeler_restrictions: k === 'bike',
    })),
  });
});

router.get('/status', requireAuth, (_req: AuthRequest, res: Response) => {
  const configured = Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
  res.json({
    provider: configured ? 'google' : 'straight-line',
    road_routing: configured,
    traffic_aware: configured,
    cached_routes: cache.size,
  });
});

export default router;
