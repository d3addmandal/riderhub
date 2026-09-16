import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

/**
 * Place search, so a ride's stops carry real coordinates instead of free text.
 *
 * Provider order:
 *   1. Google Places (New) — far better Indian address and POI coverage. Autocomplete
 *      keystrokes are free within a session; only the terminating Place Details call is
 *      billed, and the field mask below keeps it in the Essentials SKU (10k free/month).
 *   2. Photon (komoot) — OpenStreetMap, no key, no card. Built for search-as-you-type.
 *
 * Nominatim is deliberately NOT used: its usage policy caps you at one request per second
 * and explicitly rules out autocomplete-style querying.
 */

// Base is overridable so the response parsing and field masks can be tested against a
// mock without spending live quota.
const GOOGLE_BASE = process.env.GOOGLE_PLACES_BASE?.trim() || 'https://places.googleapis.com/v1';
const GOOGLE_AUTOCOMPLETE = `${GOOGLE_BASE}/places:autocomplete`;
const GOOGLE_DETAILS = `${GOOGLE_BASE}/places`;
const PHOTON_URL = process.env.PHOTON_URL?.trim() || 'https://photon.komoot.io/api';

export interface PlaceSuggestion {
  /** Opaque id — pass back to /places/details to resolve coordinates. */
  id: string;
  name: string;
  address: string;
  /** Photon returns coordinates inline; Google needs the details call. */
  lat?: number | null;
  lng?: number | null;
  provider: 'google' | 'photon';
}

function googleKey() {
  return process.env.GOOGLE_MAPS_API_KEY?.trim();
}

// ── Google ────────────────────────────────────────────────────
async function googleSearch(q: string, near?: { lat: number; lng: number }, session?: string): Promise<PlaceSuggestion[]> {
  const body: Record<string, unknown> = {
    input: q,
    // Bias toward the rider rather than the globe.
    ...(near ? {
      locationBias: {
        circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 200000 },
      },
    } : { includedRegionCodes: ['in'] }),
    ...(session ? { sessionToken: session } : {}),
  };

  const res = await fetch(GOOGLE_AUTOCOMPLETE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleKey()!,
      // Only ask for what we render — the field mask drives which SKU is billed.
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Google autocomplete ${res.status}`);
  const data: any = await res.json();

  return (data.suggestions ?? []).map((s: any) => {
    const p = s.placePrediction ?? {};
    return {
      id: p.placeId,
      name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      address: p.structuredFormat?.secondaryText?.text ?? p.text?.text ?? '',
      lat: null, lng: null,
      provider: 'google' as const,
    };
  }).filter((s: PlaceSuggestion) => s.id);
}

async function googleDetails(placeId: string, session?: string) {
  const url = new URL(`${GOOGLE_DETAILS}/${encodeURIComponent(placeId)}`);
  if (session) url.searchParams.set('sessionToken', session);

  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': googleKey()!,
      // Essentials-tier fields only. Adding anything richer moves this to a paid SKU.
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Google place details ${res.status}`);
  const p: any = await res.json();

  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    provider: 'google' as const,
  };
}

// ── Photon (keyless fallback) ─────────────────────────────────
async function photonSearch(q: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestion[]> {
  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '8');
  if (near) { url.searchParams.set('lat', String(near.lat)); url.searchParams.set('lon', String(near.lng)); }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'RiderHub/1.0 (motorcycle club app)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Photon ${res.status}`);

  const data: any = await res.json();
  return (data.features ?? []).map((f: any) => {
    const p = f.properties ?? {};
    const parts = [p.street, p.district, p.city, p.state, p.country].filter(Boolean);
    return {
      id: `photon:${f.geometry.coordinates[1]},${f.geometry.coordinates[0]}`,
      name: p.name || parts[0] || 'Unnamed place',
      address: parts.join(', '),
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      provider: 'photon' as const,
    };
  });
}

// ── Endpoints ─────────────────────────────────────────────────
const searchSchema = z.object({
  q: z.string().min(2).max(200),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  session: z.string().max(64).optional(),
});

router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Type at least two characters.' }); return; }

  const { q, lat, lng, session } = parsed.data;
  const near = lat != null && lng != null ? { lat, lng } : undefined;

  // Try Google, fall back to Photon, and only then give up — a rider mid-planning should
  // not hit a dead end because one provider is having a bad day.
  if (googleKey()) {
    try {
      res.json({ results: await googleSearch(q, near, session), provider: 'google' });
      return;
    } catch (e) {
      console.error('Google place search failed, falling back to Photon:', e);
    }
  }

  try {
    res.json({ results: await photonSearch(q, near), provider: 'photon' });
  } catch (e: any) {
    res.status(502).json({
      error: 'Place search is unavailable right now. You can still type the name and pin it on the map later.',
      detail: e.message,
    });
  }
});

/** Resolve a suggestion to coordinates. Photon ids already carry them. */
router.get('/details', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = String(req.query.id ?? '');
  if (!id) { res.status(400).json({ error: 'Missing place id' }); return; }

  if (id.startsWith('photon:')) {
    const [lat, lng] = id.slice(7).split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: 'Malformed place id' }); return;
    }
    res.json({ id, lat, lng, provider: 'photon' });
    return;
  }

  if (!googleKey()) { res.status(400).json({ error: 'That place id needs Google, which is not configured.' }); return; }

  try {
    res.json(await googleDetails(id, req.query.session ? String(req.query.session) : undefined));
  } catch (e: any) {
    res.status(502).json({ error: 'Could not resolve that place.', detail: e.message });
  }
});

/**
 * Name a point the rider tapped on the map.
 *
 * Google Geocoding is Essentials tier (10,000 free/month) and gives proper Indian
 * addresses; Photon reverse is the keyless fallback. If neither answers we still return
 * the coordinates so the stop can be saved with a typed name.
 */
router.get('/reverse', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'lat and lng required' }); return; }

  const { lat, lng } = parsed.data;

  if (googleKey()) {
    try {
      const url = new URL(process.env.GOOGLE_GEOCODE_URL?.trim()
        || 'https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('latlng', `${lat},${lng}`);
      url.searchParams.set('key', googleKey()!);
      // result_type keeps the answer to a place a rider would recognise rather than a
      // plus-code or a street number.
      url.searchParams.set('result_type', 'point_of_interest|establishment|premise|sublocality|locality');

      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data: any = await r.json();
      const best = data?.results?.[0];
      if (best) {
        const short = best.address_components?.[0]?.long_name;
        res.json({
          name: short || best.formatted_address?.split(',')[0] || 'Dropped pin',
          address: best.formatted_address ?? '',
          lat, lng, provider: 'google',
        });
        return;
      }
    } catch (e) {
      console.error('Google reverse geocode failed, trying Photon:', e);
    }
  }

  try {
    const url = new URL((process.env.PHOTON_URL?.trim() || 'https://photon.komoot.io/api')
      .replace(/\/api$/, '/reverse'));
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));

    const r = await fetch(url, {
      headers: { 'User-Agent': 'RiderHub/1.0 (motorcycle club app)' },
      signal: AbortSignal.timeout(8000),
    });
    const data: any = await r.json();
    const p = data?.features?.[0]?.properties;
    if (p) {
      const parts = [p.street, p.district, p.city, p.state].filter(Boolean);
      res.json({
        name: p.name || parts[0] || 'Dropped pin',
        address: parts.join(', '),
        lat, lng, provider: 'photon',
      });
      return;
    }
  } catch (e) {
    console.error('Photon reverse geocode failed:', e);
  }

  // Never block the rider — hand back the pin and let them name it.
  res.json({ name: '', address: '', lat, lng, provider: 'none' });
});

// ── Points of interest (fuel along the way, beds at the night stop) ──
/**
 * The categories a rider actually looks for, mapped to both providers.
 *
 * Google uses its own place types; Photon uses OpenStreetMap tags. Keeping the mapping
 * here means the frontend asks for "fuel" and does not care who answers.
 */
const POI_KINDS = {
  fuel:      { google: ['gas_station'],                    osm: ['amenity:fuel'],                       label: 'Petrol pump' },
  lodging:   { google: ['hotel', 'motel', 'guest_house', 'hostel', 'resort_hotel'],
               osm: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel'],        label: 'Stay' },
  food:      { google: ['restaurant', 'cafe'],             osm: ['amenity:restaurant', 'amenity:cafe'], label: 'Food' },
  mechanic:  { google: ['car_repair'],                     osm: ['shop:motorcycle_repair', 'shop:car_repair'], label: 'Mechanic' },
  atm:       { google: ['atm'],                            osm: ['amenity:atm'],                        label: 'ATM' },
  hospital:  { google: ['hospital'],                       osm: ['amenity:hospital'],                   label: 'Hospital' },
} as const;

type PoiKind = keyof typeof POI_KINDS;

export interface Poi {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: PoiKind;
  /** Metres from the nearest point the rider will pass — how far off-route it is. */
  detour_m: number;
  rating?: number | null;
  open_now?: boolean | null;
  provider: 'google' | 'photon';
}

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Thin a route down to a handful of search anchors.
 *
 * A route has thousands of points; searching around each would be both slow and
 * expensive. Anchors every `spacingM` metres cover the road with a small, predictable
 * number of calls — which is what keeps this inside the free tier.
 */
function sampleAlong(points: { lat: number; lng: number }[], spacingM: number, max: number) {
  if (points.length === 0) return [];
  const out = [points[0]];
  let since = 0;
  for (let i = 1; i < points.length; i++) {
    since += metresBetween(points[i - 1], points[i]);
    if (since >= spacingM) { out.push(points[i]); since = 0; }
    if (out.length >= max) break;
  }
  const last = points[points.length - 1];
  if (out.length < max && metresBetween(out[out.length - 1], last) > spacingM / 2) out.push(last);
  return out;
}

async function googleNearby(at: { lat: number; lng: number }, kind: PoiKind, radius: number): Promise<Poi[]> {
  const res = await fetch(`${GOOGLE_BASE}/places:searchNearby`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleKey()!,
      // Kept to the Essentials + Pro fields we actually render; anything richer costs more.
      'X-Goog-FieldMask': [
        'places.id', 'places.displayName', 'places.formattedAddress',
        'places.location', 'places.rating', 'places.currentOpeningHours.openNow',
      ].join(','),
    },
    body: JSON.stringify({
      includedTypes: POI_KINDS[kind].google,
      maxResultCount: 10,
      locationRestriction: {
        circle: { center: { latitude: at.lat, longitude: at.lng }, radius },
      },
      rankPreference: 'DISTANCE',
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Google nearby ${res.status}`);
  const data: any = await res.json();

  return (data.places ?? []).map((p: any) => ({
    id: p.id,
    name: p.displayName?.text ?? POI_KINDS[kind].label,
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    kind,
    detour_m: 0,
    rating: p.rating ?? null,
    open_now: p.currentOpeningHours?.openNow ?? null,
    provider: 'google' as const,
  })).filter((p: Poi) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

async function photonNearby(at: { lat: number; lng: number }, kind: PoiKind, radius: number): Promise<Poi[]> {
  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', POI_KINDS[kind].label);
  url.searchParams.set('lat', String(at.lat));
  url.searchParams.set('lon', String(at.lng));
  url.searchParams.set('limit', '10');
  for (const tag of POI_KINDS[kind].osm) url.searchParams.append('osm_tag', tag);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'RiderHub/1.0 (motorcycle club app)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Photon nearby ${res.status}`);

  const data: any = await res.json();
  return (data.features ?? []).map((f: any) => {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates;
    return {
      id: `photon:${lat},${lng}`,
      name: p.name || POI_KINDS[kind].label,
      address: [p.street, p.district, p.city, p.state].filter(Boolean).join(', '),
      lat, lng, kind, detour_m: 0,
      rating: null, open_now: null,
      provider: 'photon' as const,
    };
  })
  // Photon has no radius filter, so enforce it here rather than showing a pump 80 km away.
  .filter((p: Poi) => metresBetween(at, p) <= radius);
}

/** Short-lived cache — a rider re-opening the fuel sheet should not re-bill the search. */
const poiCache = new Map<string, { at: number; data: Poi[] }>();
const POI_TTL_MS = 5 * 60 * 1000;

async function findPois(anchors: { lat: number; lng: number }[], kind: PoiKind, radius: number) {
  const key = `${kind}:${radius}:${anchors.map(a => `${a.lat.toFixed(3)},${a.lng.toFixed(3)}`).join(';')}`;
  const hit = poiCache.get(key);
  if (hit && Date.now() - hit.at < POI_TTL_MS) return { results: hit.data, provider: 'cache' as const };

  const useGoogle = Boolean(googleKey());
  const search = useGoogle ? googleNearby : photonNearby;

  const batches = await Promise.all(anchors.map(async a => {
    try { return await search(a, kind, radius); } catch (e) {
      console.error(`POI search failed at ${a.lat},${a.lng}:`, e);
      return [] as Poi[];
    }
  }));

  // The same pump shows up from two anchors — keep one, with its true detour.
  const byId = new Map<string, Poi>();
  for (const p of batches.flat()) {
    const detour = Math.round(Math.min(...anchors.map(a => metresBetween(a, p))));
    const existing = byId.get(p.id);
    if (!existing || detour < existing.detour_m) byId.set(p.id, { ...p, detour_m: detour });
  }

  const results = [...byId.values()].sort((a, b) => a.detour_m - b.detour_m);
  poiCache.set(key, { at: Date.now(), data: results });
  return { results, provider: useGoogle ? ('google' as const) : ('photon' as const) };
}

const poiSchema = z.object({
  kind: z.enum(['fuel', 'lodging', 'food', 'mechanic', 'atm', 'hospital']),
  radius_m: z.coerce.number().min(200).max(50000).optional(),
  limit: z.coerce.number().min(1).max(60).optional(),
});

/** What is near one spot — beds around a night stop, food around a lunch stop. */
router.post('/nearby', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = poiSchema.extend({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Need a position and a category.' }); return; }

  const { lat, lng, kind, radius_m = 5000, limit = 20 } = parsed.data;
  try {
    const { results, provider } = await findPois([{ lat, lng }], kind, radius_m);
    res.json({ results: results.slice(0, limit), provider });
  } catch (e: any) {
    res.status(502).json({ error: 'Could not search nearby right now.', detail: e.message });
  }
});

/**
 * What lies along the road ahead — the petrol-pump case.
 *
 * The frontend posts the remaining route geometry; anchors are spread along it so the
 * answer covers the whole way rather than clustering around the rider.
 */
router.post('/along-route', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = poiSchema.extend({
    points: z.array(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })).min(1).max(5000),
    /** How far apart to place the search anchors. */
    spacing_m: z.coerce.number().min(1000).max(100000).optional(),
    max_anchors: z.coerce.number().min(1).max(8).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Need the route and a category.' }); return; }

  const { points, kind, radius_m = 3000, spacing_m = 25000, max_anchors = 5, limit = 30 } = parsed.data;
  const anchors = sampleAlong(points, spacing_m, max_anchors);

  try {
    const { results, provider } = await findPois(anchors, kind, radius_m);
    res.json({ results: results.slice(0, limit), provider, anchors: anchors.length });
  } catch (e: any) {
    res.status(502).json({ error: 'Could not search along the route.', detail: e.message });
  }
});

// ── Full place detail (the card a rider opens before committing to a detour) ──
export interface PlaceReview {
  author: string;
  author_photo: string | null;
  rating: number | null;
  text: string;
  relative_time: string | null;
}

export interface PlaceDetail {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  rating_count: number | null;
  price_level: string | null;
  open_now: boolean | null;
  /** "Mon: 9:00 am – 9:00 pm" lines, as Google formats them for the locale. */
  hours: string[];
  phone: string | null;
  website: string | null;
  /** The vendor's page on Google — their Business Profile as the public sees it. */
  google_maps_url: string | null;
  summary: string | null;
  types: string[];
  /** Proxy paths, not Google URLs — see the photo route below for why. */
  photos: string[];
  reviews: PlaceReview[];
  provider: 'google';
}

/**
 * Everything worth knowing about one place.
 *
 * This is a deliberately separate endpoint from `/details`. That one is on the Essentials
 * SKU and answers "where is it"; this one pulls ratings, reviews and photos, which sits
 * in Places Details **Enterprise** — a much costlier tier. Keeping them apart means the
 * expensive call only happens when a rider actually opens a place, not on every search.
 */
router.get('/detail', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = String(req.query.id ?? '');
  if (!id) { res.status(400).json({ error: 'Missing place id' }); return; }

  if (id.startsWith('photon:')) {
    res.status(400).json({
      error: 'That place came from the free fallback provider, which has no ratings, '
        + 'reviews or photos. Enable the Google Places API to see full details.',
    });
    return;
  }
  if (!googleKey()) { res.status(400).json({ error: 'Place details need Google, which is not configured.' }); return; }

  try {
    const r = await fetch(`${GOOGLE_DETAILS}/${encodeURIComponent(id)}`, {
      headers: {
        'X-Goog-Api-Key': googleKey()!,
        'X-Goog-FieldMask': [
          'id', 'displayName', 'formattedAddress', 'location', 'types',
          'rating', 'userRatingCount', 'priceLevel',
          'currentOpeningHours.openNow', 'currentOpeningHours.weekdayDescriptions',
          'nationalPhoneNumber', 'websiteUri', 'googleMapsUri',
          'editorialSummary', 'photos', 'reviews',
        ].join(','),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) {
      res.status(502).json({ error: `Google could not describe that place (${r.status}).` });
      return;
    }
    const p: any = await r.json();

    const detail: PlaceDetail = {
      id: p.id ?? id,
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      rating: p.rating ?? null,
      rating_count: p.userRatingCount ?? null,
      price_level: p.priceLevel ?? null,
      open_now: p.currentOpeningHours?.openNow ?? null,
      hours: p.currentOpeningHours?.weekdayDescriptions ?? [],
      phone: p.nationalPhoneNumber ?? null,
      website: p.websiteUri ?? null,
      // Falling back to a place_id search URL means the button always goes somewhere.
      google_maps_url: p.googleMapsUri
        ?? `https://www.google.com/maps/search/?api=1&query=place_id:${encodeURIComponent(p.id ?? id)}`,
      summary: p.editorialSummary?.text ?? null,
      types: p.types ?? [],
      // Photos are served through us, never as a Google URL — see the route below.
      photos: (p.photos ?? []).slice(0, 10).map(
        (ph: any) => `/places/photo?name=${encodeURIComponent(ph.name)}`),
      reviews: (p.reviews ?? []).slice(0, 10).map((rv: any): PlaceReview => ({
        author: rv.authorAttribution?.displayName ?? 'A Google user',
        author_photo: rv.authorAttribution?.photoUri ?? null,
        rating: rv.rating ?? null,
        text: rv.text?.text ?? rv.originalText?.text ?? '',
        relative_time: rv.relativePublishTimeDescription ?? null,
      })).filter((rv: PlaceReview) => rv.text),
      provider: 'google',
    };

    res.json(detail);
  } catch (e: any) {
    res.status(502).json({ error: 'Could not load that place.', detail: e.message });
  }
});

/**
 * Stream a place photo.
 *
 * Google's photo media URL needs the API key in the query string. Handing that to the
 * browser would put the key in every image request — in the page source, in the browser
 * cache, and in anyone's devtools. Proxying keeps it on the server, at the cost of the
 * bytes passing through us.
 */
router.get('/photo', requireAuth, async (req: AuthRequest, res: Response) => {
  const name = String(req.query.name ?? '');
  // Photo resource names look like places/<id>/photos/<ref>. Anything else is not ours
  // to fetch, and blindly forwarding would make this an open proxy.
  if (!/^places\/[A-Za-z0-9_\-]+\/photos\/[A-Za-z0-9_\-]+$/.test(name)) {
    res.status(400).json({ error: 'Bad photo reference' }); return;
  }
  if (!googleKey()) { res.status(400).json({ error: 'Photos need Google, which is not configured.' }); return; }

  const w = Math.min(Math.max(parseInt(String(req.query.w ?? '640'), 10) || 640, 80), 1600);

  try {
    const url = new URL(`${GOOGLE_BASE}/${name}/media`);
    url.searchParams.set('key', googleKey()!);
    url.searchParams.set('maxWidthPx', String(w));

    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok || !r.body) { res.status(502).end(); return; }

    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    // Google permits caching photo bytes; a day keeps the sheet snappy and the bill low.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

/** Lets the UI say which provider is answering, and whether search works at all. */
router.get('/status', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({
    provider: googleKey() ? 'google' : 'photon',
    google_configured: Boolean(googleKey()),
  });
});

export default router;
