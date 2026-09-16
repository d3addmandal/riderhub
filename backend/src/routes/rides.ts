import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, getOwned, now, defined, sortBy, bumpOdometer } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

// ── Model ─────────────────────────────────────────────────────
/**
 * What a stop is for.
 *
 * This is not decoration: it drives what the app offers there. A night stop is where
 * beds are worth searching for, a fuel stop is where a fill-up gets logged, and meal
 * stops are what make a long day's plan readable at a glance.
 */
export const STOP_KINDS = [
  'break', 'breakfast', 'snacks', 'lunch', 'dinner', 'night', 'fuel', 'sightseeing', 'other',
] as const;
export type StopKind = typeof STOP_KINDS[number];

const pointSchema = z.object({
  // Trimmed before the length check, so " " is not a valid place name.
  name: z.string().trim().min(1).max(120),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  kind: z.enum(STOP_KINDS).optional(),
  /** Planned minutes at this stop — what turns a stop list into a schedule. */
  planned_minutes: z.number().int().min(0).max(1440).nullable().optional(),
});

const rideSchema = z.object({
  motorcycle_id: z.string().min(1),
  name: z.string().min(1).max(100),
  ride_type: z.enum(['solo', 'duo', 'group']),
  planned_date: z.string().optional(),
  start_location: pointSchema.nullable().optional(),
  destination: pointSchema.nullable().optional(),
  start_odometer: z.number().int().min(0).optional(),
  stops: z.array(pointSchema).max(25).optional(),
  notes: z.string().max(1000).optional(),
});

type RideStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';

/** Which status changes are legal (spec §51). Anything else is rejected, not silently applied. */
const TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  planned:   ['active', 'cancelled'],
  active:    ['paused', 'completed', 'cancelled'],
  paused:    ['active', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function stopId() {
  return crypto.randomBytes(4).toString('hex');
}

/** Build a stored stop from a submitted point — one shape, used everywhere. */
function newStop(
  s: { name: string; lat?: number | null; lng?: number | null; kind?: StopKind; planned_minutes?: number | null },
  order: number,
) {
  return {
    id: stopId(),
    name: s.name,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    kind: s.kind ?? 'break',
    planned_minutes: s.planned_minutes ?? null,
    order,
    reached_at: null as string | null,
  };
}

function inviteCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/** Great-circle distance in km — used for planned route length and GPS-derived distance. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line length through start → stops → destination, for planning. */
function plannedDistance(ride: any): number | null {
  const pts = [ride.start_location, ...(ride.stops ?? []), ride.destination]
    .filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
  if (pts.length < 2) return null;
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
  return +km.toFixed(1);
}

async function ownedRide(id: string, userId: string) {
  return getOwned<any>(COL.rides, id, userId);
}

/**
 * A ride the rider is allowed to *see* — theirs, or one they joined.
 *
 * Editing stays with the owner: a member who could reorder stops mid-ride would be
 * changing the route under everyone else. Members get read access, their own GPS trail,
 * and the door out.
 */
async function accessibleRide(id: string, userId: string) {
  const snap = await db.collection(COL.rides).doc(id).get();
  if (!snap.exists) return null;
  const data: any = { id: snap.id, ...snap.data() };
  if (data.user_id === userId) return { ...data, is_owner: true };
  if ((data.member_ids ?? []).includes(userId)) return { ...data, is_owner: false };
  return null;
}

/**
 * Colours for riders on the map, in assignment order.
 *
 * Chosen to stay apart from the orange the route and the rider's own marker use, and
 * from each other — at a glance mid-ride, "who is that dot" has to be answerable.
 */
const MEMBER_COLOURS = [
  '#3b82f6', '#22c55e', '#a855f7', '#eab308',
  '#ec4899', '#06b6d4', '#f43f5e', '#84cc16',
];

// ── List: the ride dashboard (spec §11) ───────────────────────
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { bike_id, status, type } = req.query;

  try {
    let q = db.collection(COL.rides).where('user_id', '==', req.user!.id);
    if (bike_id) q = q.where('motorcycle_id', '==', bike_id as string);
    if (status) q = q.where('status', '==', status as string);
    if (type) q = q.where('ride_type', '==', type as string);

    /*
     * A rider's list is their own rides plus the ones they joined.
     *
     * Two equality queries merged in memory rather than one clever composite: Firestore
     * cannot OR across different fields, and array-contains needs its own index once it
     * is combined with filters. Two index-free reads is the cheaper, simpler answer at
     * club scale.
     */
    const own = await queryAll<any>(q);
    const joined = await queryAll<any>(
      db.collection(COL.rides).where('member_ids', 'array-contains', req.user!.id));

    const seen = new Set(own.map(r => r.id));
    const merged = [
      ...own,
      ...joined.filter(r => !seen.has(r.id) && r.user_id !== req.user!.id)
        // The client-side filters have to be applied to the joined half by hand.
        .filter(r => (!bike_id || r.motorcycle_id === bike_id)
          && (!status || r.status === status)
          && (!type || r.ride_type === type)),
    ];

    const rides = sortBy(merged, r => r.started_at ?? r.planned_date ?? r.created_at, 'desc');

    // Hydrate the bike name so the dashboard does not need a second call.
    const bikes = await queryAll<any>(
      db.collection(COL.motorcycles).where('user_id', '==', req.user!.id)
    );
    const byId = new Map(bikes.map(b => [b.id, `${b.brand} ${b.model}`]));

    res.json(rides.map(r => ({
      ...r,
      bike_name: byId.get(r.motorcycle_id) ?? null,
      // A joined ride is read-only for this rider; the list says so rather than
      // offering edit controls that would only fail.
      is_owner: r.user_id === req.user!.id,
      member_count: (r.member_ids ?? []).length,
      stops_count: (r.stops ?? []).length,
      notes_count: (r.ride_notes ?? []).length,
      planned_distance: plannedDistance(r),
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Create (spec §13) ─────────────────────────────────────────
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = rideSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const bike = await getOwned<any>(COL.motorcycles, parsed.data.motorcycle_id, req.user!.id);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    const startAt = req.body.start_now === true;

    const payload: Record<string, any> = {
      ...defined(parsed.data),
      user_id: req.user!.id,
      // Default the opening reading to the bike's own, so the rider rarely types it.
      start_odometer: parsed.data.start_odometer ?? bike.current_odometer ?? 0,
      stops: (parsed.data.stops ?? []).map((s, i) => newStop(s, i)),
      status: (startAt ? 'active' : 'planned') as RideStatus,
      started_at: startAt ? now() : null,
      ended_at: null,
      paused_ms: 0,
      paused_at: null,
      end_odometer: null,
      distance_km: null,
      fuel_litres: null,
      fuel_cost: null,
      other_cost: 0,
      max_speed: null,
      created_at: now(),
      updated_at: now(),
    };

    // Duo and group rides are joinable; a solo ride is not.
    if (parsed.data.ride_type !== 'solo') {
      payload.invite_code = inviteCode();
      payload.member_ids = [req.user!.id];
      payload.leader_id = req.user!.id;
    }

    const ref = await db.collection(COL.rides).add(payload);
    res.status(201).json({ id: ref.id, ...payload, planned_distance: plannedDistance(payload) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Fuel bought during this ride.
 *
 * A rider who tanks up mid-ride logs it once in the fuel log; it then counts toward both
 * the bike's lifetime figures and this ride's cost, with no double entry.
 */
async function rideFuel(rideId: string, userId: string) {
  const entries = await queryAll<any>(
    db.collection(COL.fuelEntries)
      .where('user_id', '==', userId)
      .where('ride_id', '==', rideId)
  );
  return {
    entries: sortBy(entries, 'date', 'desc'),
    litres: +entries.reduce((s, e) => s + (e.litres || 0), 0).toFixed(2),
    cost: +entries.reduce((s, e) => s + (e.amount || 0), 0).toFixed(2),
    count: entries.length,
  };
}

/** The ride currently under way, if any — used to offer fuel attribution. */
router.get('/active', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rides = await queryAll<any>(
      db.collection(COL.rides).where('user_id', '==', req.user!.id)
    );
    const live = rides.filter(r => r.status === 'active' || r.status === 'paused');
    const newest = sortBy(live, 'started_at', 'desc')[0] ?? null;
    res.json(newest ? {
      id: newest.id, name: newest.name, status: newest.status,
      motorcycle_id: newest.motorcycle_id,
    } : null);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Detail (spec §12) ─────────────────────────────────────────
// Declared before '/:id', or Express matches this path as a ride id and the
// lookup 404s on every valid code.
/**
 * Look a ride up by its invite code, before committing to join it.
 *
 * Deliberately returns only what someone deciding whether to join needs — the name, who
 * is leading, where it goes, how many are in. Not the stops, not the odometer, not the
 * owner's notes. A code is a weak secret and this is readable by anyone holding one.
 */
router.get('/lookup', requireAuth, async (req: AuthRequest, res: Response) => {
  const code = String(req.query.code ?? '').trim().toUpperCase();
  if (!code) { res.status(400).json({ error: 'Enter the invite code.' }); return; }

  try {
    const matches = await queryAll<any>(
      db.collection(COL.rides).where('invite_code', '==', code));
    const ride = matches[0];
    if (!ride) { res.status(404).json({ error: 'No ride found with that code.' }); return; }

    const owner = await db.collection(COL.profiles).doc(ride.user_id).get();

    res.json({
      id: ride.id,
      name: ride.name,
      ride_type: ride.ride_type,
      status: ride.status,
      planned_date: ride.planned_date ?? null,
      destination: ride.destination ?? null,
      start_location: ride.start_location ?? null,
      owner_name: owner.data()?.name ?? 'A rider',
      member_count: (ride.member_ids ?? []).length,
      already_joined: (ride.member_ids ?? []).includes(req.user!.id),
      is_owner: ride.user_id === req.user!.id,
      joinable: ride.ride_type !== 'solo'
        && ride.status !== 'completed' && ride.status !== 'cancelled',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  // Members can read a ride they joined; only the owner can change it.
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  const bike = await getOwned<any>(COL.motorcycles, ride.motorcycle_id, req.user!.id);
  const fuel = await rideFuel(req.params.id, req.user!.id);

  // Duration excludes time spent paused.
  let duration_ms: number | null = null;
  if (ride.started_at) {
    const end = ride.ended_at ? new Date(ride.ended_at).getTime() : Date.now();
    duration_ms = Math.max(0, end - new Date(ride.started_at).getTime() - (ride.paused_ms ?? 0));
  }

  const distance = ride.distance_km
    ?? (ride.status !== 'completed' && bike && ride.start_odometer != null
        ? Math.max(0, (bike.current_odometer ?? 0) - ride.start_odometer)
        : null);

  // Fuel logged against the ride wins; the manual figure at completion is a fallback
  // for riders who did not log the fill-up itself.
  const effectiveLitres = fuel.litres > 0 ? fuel.litres : (ride.fuel_litres ?? null);
  const effectiveFuelCost = fuel.cost > 0 ? fuel.cost : (ride.fuel_cost ?? 0);

  res.json({
    ...ride,
    // Stops saved before kinds existed still need one, so the UI never renders a blank.
    stops: (ride.stops ?? []).map((s: any) => ({
      kind: 'break', planned_minutes: null, ...s,
    })),
    bike_name: bike ? `${bike.brand} ${bike.model}` : null,
    current_odometer: bike?.current_odometer ?? null,
    planned_distance: plannedDistance(ride),
    distance_km: distance,
    duration_ms,
    avg_speed: distance != null && duration_ms
      ? +(distance / (duration_ms / 3600000)).toFixed(1)
      : null,
    fuel_litres: effectiveLitres,
    fuel_cost: effectiveFuelCost,
    fuel_entries: fuel.entries,
    fuel_from_entries: { litres: fuel.litres, cost: fuel.cost, count: fuel.count },
    mileage: distance != null && effectiveLitres
      ? +(distance / effectiveLitres).toFixed(2)
      : null,
    total_cost: effectiveFuelCost + (ride.other_cost ?? 0),
  });
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = rideSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    res.status(409).json({ error: `A ${ride.status} ride can no longer be edited.` });
    return;
  }

  try {
    const patch: Record<string, any> = { ...defined(parsed.data), updated_at: now() };
    // Replacing the stop list re-issues ids and ordering.
    if (parsed.data.stops) {
      patch.stops = parsed.data.stops.map((s, i) => newStop(s, i));
    }
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update(patch);
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    // Remove the GPS trail with the ride.
    const track = await db.collection(COL.rides).doc(req.params.id).collection('track').get();
    for (let i = 0; i < track.docs.length; i += 450) {
      const batch = db.batch();
      track.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await db.collection(COL.rides).doc(req.params.id).delete();
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Status lifecycle (spec §51) ───────────────────────────────
async function transition(
  req: AuthRequest, res: Response, to: RideStatus,
  extra: (ride: any) => Record<string, any> | Promise<Record<string, any>> = () => ({})
) {
  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  const allowed = TRANSITIONS[ride.status as RideStatus] ?? [];
  if (!allowed.includes(to)) {
    res.status(409).json({ error: `Cannot go from ${ride.status} to ${to}.` });
    return;
  }

  try {
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ status: to, ...(await extra(ride)), updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

router.post('/:id/start', requireAuth, (req: AuthRequest, res) =>
  transition(req, res, 'active', ride => ({
    started_at: ride.started_at ?? now(),
  })));

router.post('/:id/pause', requireAuth, (req: AuthRequest, res) =>
  transition(req, res, 'paused', () => ({ paused_at: now() })));

router.post('/:id/resume', requireAuth, (req: AuthRequest, res) =>
  transition(req, res, 'active', ride => ({
    // Time spent paused never counts toward duration or average speed.
    paused_ms: (ride.paused_ms ?? 0) +
      (ride.paused_at ? Date.now() - new Date(ride.paused_at).getTime() : 0),
    paused_at: null,
  })));

router.post('/:id/cancel', requireAuth, (req: AuthRequest, res) =>
  transition(req, res, 'cancelled', () => ({ ended_at: now() })));

/**
 * Finish a ride and lock in its statistics (spec §12, §21).
 *
 * Distance comes from the odometer rather than the GPS trail: it is the number the rider
 * trusts, it survives signal loss, and it needs no route recording to be accurate.
 */
router.post('/:id/complete', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    end_odometer: z.number().int().min(0).optional(),
    fuel_litres: z.number().min(0).optional(),
    fuel_cost: z.number().min(0).optional(),
    other_cost: z.number().min(0).optional(),
    notes: z.string().max(1000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (!TRANSITIONS[ride.status as RideStatus]?.includes('completed')) {
    res.status(409).json({ error: `Cannot complete a ${ride.status} ride.` });
    return;
  }

  const bike = await getOwned<any>(COL.motorcycles, ride.motorcycle_id, req.user!.id);
  const endOdo = parsed.data.end_odometer ?? bike?.current_odometer ?? null;

  if (endOdo != null && ride.start_odometer != null && endOdo < ride.start_odometer) {
    res.status(400).json({
      error: `Closing reading ${endOdo.toLocaleString()} km is below the opening ${ride.start_odometer.toLocaleString()} km.`,
    });
    return;
  }

  try {
    const distance = endOdo != null && ride.start_odometer != null
      ? endOdo - ride.start_odometer
      : null;

    // Fill-ups already logged against the ride are the source of truth; the form only
    // needs to supply figures for fuel the rider did not log.
    const logged = await rideFuel(req.params.id, req.user!.id);

    const pausedTotal = (ride.paused_ms ?? 0) +
      (ride.paused_at ? Date.now() - new Date(ride.paused_at).getTime() : 0);

    const updates = {
      status: 'completed' as RideStatus,
      ended_at: now(),
      paused_at: null,
      paused_ms: pausedTotal,
      end_odometer: endOdo,
      distance_km: distance,
      fuel_litres: parsed.data.fuel_litres ?? (logged.litres > 0 ? logged.litres : null),
      fuel_cost: parsed.data.fuel_cost ?? (logged.cost > 0 ? logged.cost : null),
      other_cost: parsed.data.other_cost ?? ride.other_cost ?? 0,
      notes: parsed.data.notes ?? ride.notes ?? null,
      updated_at: now(),
    };

    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update(updates);

    if (endOdo != null) await bumpOdometer(ride.motorcycle_id, req.user!.id, endOdo);

    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stops (spec §13) ──────────────────────────────────────────
const addStopSchema = pointSchema.extend({
  /**
   * 'next' drops the stop immediately ahead of the rider — the common case for a detour
   * decided mid-ride ("fuel before the ghat"). 'end' appends it, for planning.
   */
  position: z.enum(['next', 'end']).optional(),
});

router.post('/:id/stops', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = addStopSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    res.status(409).json({ error: `Cannot add a stop to a ${ride.status} ride.` });
    return;
  }

  try {
    const stops = [...(ride.stops ?? [])].sort((a: any, b: any) => a.order - b.order);
    const fresh = newStop(parsed.data, 0);

    if (parsed.data.position === 'next') {
      // Slot it in front of the first stop not yet reached, so it becomes the next target.
      const idx = stops.findIndex((s: any) => !s.reached_at);
      if (idx === -1) stops.push(fresh);
      else stops.splice(idx, 0, fresh);
    } else {
      stops.push(fresh);
    }

    const renumbered = stops.map((s: any, i: number) => ({ ...s, order: i }));
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ stops: renumbered, updated_at: now() });
    res.status(201).json({ ...docData(await ref.get()), added_stop_id: fresh.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Move or rename a single stop, leaving its place in the sequence alone.
 *
 * This is what dragging a pin on the map calls: the rider nudges the marker onto the
 * actual fuel pump rather than the road outside it, and only the coordinates change.
 */
const patchStopSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  kind: z.enum(STOP_KINDS).optional(),
  planned_minutes: z.number().int().min(0).max(1440).nullable().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to change.' });

router.patch('/:id/stops/:stopId', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = patchStopSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    res.status(409).json({ error: `Cannot change a stop on a ${ride.status} ride.` });
    return;
  }

  const existing = (ride.stops ?? []).find((s: any) => s.id === req.params.stopId);
  if (!existing) { res.status(404).json({ error: 'Stop not found' }); return; }

  try {
    const stops = (ride.stops ?? []).map((s: any) =>
      s.id === req.params.stopId ? { ...s, ...defined(parsed.data) } : s);
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ stops, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/stops/:stopId', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const stops = (ride.stops ?? [])
      .filter((s: any) => s.id !== req.params.stopId)
      .map((s: any, i: number) => ({ ...s, order: i }));
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ stops, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Reorder by supplying the stop ids in the new order. */
router.put('/:id/stops/reorder', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ order: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const byId = new Map((ride.stops ?? []).map((s: any) => [s.id, s]));
    const reordered = parsed.data.order
      .map(id => byId.get(id))
      .filter(Boolean)
      .map((s: any, i: number) => ({ ...s, order: i }));

    if (reordered.length !== (ride.stops ?? []).length) {
      res.status(400).json({ error: 'The reorder list must contain every stop exactly once.' });
      return;
    }

    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ stops: reordered, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Riding together ───────────────────────────────────────────
const joinSchema = z.object({
  code: z.string().trim().min(1).max(16),
  motorcycle_id: z.string().min(1),
  /** Riders meet on the way, so everyone may set off from somewhere different. */
  start_location: pointSchema.nullable().optional(),
});

router.post('/join', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Pick a bike and enter the code.' }); return; }

  const code = parsed.data.code.toUpperCase();

  try {
    const matches = await queryAll<any>(
      db.collection(COL.rides).where('invite_code', '==', code));
    const ride = matches[0];
    if (!ride) { res.status(404).json({ error: 'No ride found with that code.' }); return; }

    if (ride.ride_type === 'solo') {
      res.status(409).json({ error: 'That is a solo ride — it cannot be joined.' }); return;
    }
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      res.status(409).json({ error: `That ride is already ${ride.status}.` }); return;
    }
    if (ride.user_id === req.user!.id) {
      res.status(409).json({ error: 'This is your own ride.' }); return;
    }
    if ((ride.member_ids ?? []).includes(req.user!.id)) {
      res.status(409).json({ error: 'You have already joined this ride.', ride_id: ride.id }); return;
    }
    // A duo is exactly two. Anything beyond that is a group ride.
    if (ride.ride_type === 'duo' && (ride.member_ids ?? []).length >= 2) {
      res.status(409).json({ error: 'That duo ride is already full.' }); return;
    }

    // The bike must be the joiner's own — otherwise a member could attach someone
    // else's motorcycle to a ride.
    const bike = await getOwned<any>(COL.motorcycles, parsed.data.motorcycle_id, req.user!.id);
    if (!bike) { res.status(400).json({ error: 'Choose one of your own bikes.' }); return; }

    const profile = (await db.collection(COL.profiles).doc(req.user!.id).get()).data();
    const existing: any[] = ride.members ?? [];

    const member = {
      user_id: req.user!.id,
      name: profile?.name || 'Rider',
      motorcycle_id: bike.id,
      bike_name: `${bike.brand} ${bike.model}`,
      // Everyone converges on the same destination; only the start differs.
      start_location: parsed.data.start_location ?? null,
      colour: MEMBER_COLOURS[existing.length % MEMBER_COLOURS.length],
      joined_at: now(),
    };

    await db.collection(COL.rides).doc(ride.id).update({
      member_ids: [...(ride.member_ids ?? []), req.user!.id],
      members: [...existing, member],
      updated_at: now(),
    });

    res.status(201).json({ ride_id: ride.id, name: ride.name, member });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Who is riding, and where each of them was last seen. */
router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const owner = (await db.collection(COL.profiles).doc(ride.user_id).get()).data();
    const live = await queryAll<any>(
      db.collection(COL.rides).doc(req.params.id).collection('live'));
    const byUser = new Map(live.map(l => [l.id, l]));

    // The owner is a rider too, and leads the list.
    const rows = [
      {
        user_id: ride.user_id,
        name: owner?.name || 'Ride leader',
        bike_name: ride.bike_name ?? null,
        start_location: ride.start_location ?? null,
        colour: '#f97316',
        is_owner: true,
        joined_at: ride.created_at ?? null,
      },
      ...(ride.members ?? []).map((m: any) => ({ ...m, is_owner: false })),
    ].map(m => {
      const l = byUser.get(m.user_id);
      return {
        ...m,
        is_you: m.user_id === req.user!.id,
        last_position: l ? { lat: l.lat, lng: l.lng, t: l.t, speed: l.speed ?? null } : null,
      };
    });

    res.json({ ride_id: req.params.id, you_are_owner: ride.is_owner, members: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Everyone's latest position, for drawing the others on the map.
 *
 * Kept separate from /members and deliberately tiny: this is polled while riding, so it
 * carries coordinates and nothing else.
 */
router.get('/:id/live', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const live = await queryAll<any>(
      db.collection(COL.rides).doc(req.params.id).collection('live'));

    const colours = new Map<string, { name: string; colour: string }>(
      (ride.members ?? []).map((m: any) => [m.user_id, { name: m.name, colour: m.colour }]));

    const owner = (await db.collection(COL.profiles).doc(ride.user_id).get()).data();
    colours.set(ride.user_id, { name: owner?.name || 'Leader', colour: '#f97316' });

    res.json({
      riders: live
        // Your own dot is drawn from your GPS, not from a round trip to the server.
        .filter(l => l.id !== req.user!.id)
        .map(l => ({
          user_id: l.id,
          name: colours.get(l.id)?.name ?? 'Rider',
          colour: colours.get(l.id)?.colour ?? '#94a3b8',
          lat: l.lat, lng: l.lng, t: l.t,
          speed: l.speed ?? null,
          heading: l.heading ?? null,
        })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Drop out of a ride you joined. The owner cancels the ride instead. */
router.post('/:id/leave', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (ride.is_owner) {
    res.status(409).json({ error: 'You are leading this ride — cancel it instead of leaving.' });
    return;
  }

  try {
    await db.collection(COL.rides).doc(req.params.id).update({
      member_ids: (ride.member_ids ?? []).filter((u: string) => u !== req.user!.id),
      members: (ride.members ?? []).filter((m: any) => m.user_id !== req.user!.id),
      updated_at: now(),
    });
    await db.collection(COL.rides).doc(req.params.id)
      .collection('live').doc(req.user!.id).delete().catch(() => undefined);
    res.json({ left: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Ride notes ────────────────────────────────────────────────
/**
 * A ride's notebook: timestamped entries the rider adds as they go, or afterwards.
 *
 * Deliberately allowed on completed rides too — "great dhaba just past the ghat" is
 * usually written once you are home, and a ride journal is worth little if it locks the
 * moment you finish. Optional coordinates let a note be pinned to where it was taken.
 */
const noteSchema = z.object({
  // Trim first, so a note of nothing but spaces is rejected rather than stored blank.
  text: z.string().trim().min(1).max(2000),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

function noteId() {
  return crypto.randomBytes(4).toString('hex');
}

router.post('/:id/notes', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A note needs some text.' }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const entry = {
      id: noteId(),
      text: parsed.data.text.trim(),
      lat: parsed.data.lat ?? null,
      lng: parsed.data.lng ?? null,
      created_at: now(),
      updated_at: null as string | null,
    };
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ ride_notes: [...(ride.ride_notes ?? []), entry], updated_at: now() });
    res.status(201).json({ ...docData(await ref.get()), added_note_id: entry.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/notes/:noteId', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A note needs some text.' }); return; }

  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
  if (!(ride.ride_notes ?? []).some((n: any) => n.id === req.params.noteId)) {
    res.status(404).json({ error: 'Note not found' }); return;
  }

  try {
    const notes = (ride.ride_notes ?? []).map((n: any) =>
      n.id === req.params.noteId
        ? { ...n, text: parsed.data.text.trim(), updated_at: now() }
        : n);
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ ride_notes: notes, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/notes/:noteId', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const notes = (ride.ride_notes ?? []).filter((n: any) => n.id !== req.params.noteId);
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ ride_notes: notes, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Tick a stop off as reached — drives navigation on to the next one. */
router.post('/:id/stops/:stopId/reached', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await ownedRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const stops = (ride.stops ?? []).map((s: any) =>
      s.id === req.params.stopId ? { ...s, reached_at: s.reached_at ?? now() } : s);
    const ref = db.collection(COL.rides).doc(req.params.id);
    await ref.update({ stops, updated_at: now() });
    res.json(docData(await ref.get()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GPS trail (spec §16, §30) ─────────────────────────────────
/**
 * Accept a batch of positions recorded on the phone.
 *
 * Points arrive in batches rather than one per fix so a ride through patchy coverage can
 * buffer locally and flush when signal returns, and so Firestore writes stay cheap.
 */
router.post('/:id/track', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    points: z.array(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      t: z.string(),
      speed: z.number().min(0).nullable().optional(),
      accuracy: z.number().min(0).nullable().optional(),
    })).min(1).max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // Everyone on the ride records their own trail, so a member must be allowed here.
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    // One document per batch, not per point — a 6-hour ride costs a handful of writes.
    const batchDoc = {
      user_id: req.user!.id,
      count: parsed.data.points.length,
      from: parsed.data.points[0].t,
      to: parsed.data.points[parsed.data.points.length - 1].t,
      points: parsed.data.points,
      created_at: now(),
    };
    await db.collection(COL.rides).doc(req.params.id).collection('track').add(batchDoc);

    /*
     * One document per rider holding only their latest fix.
     * The full trail lives in `track` and grows all ride; reading it just to find where
     * everyone is would get slower by the hour. This stays a single small read.
     */
    const last = parsed.data.points[parsed.data.points.length - 1];
    await db.collection(COL.rides).doc(req.params.id)
      .collection('live').doc(req.user!.id)
      .set({ ...last, updated_at: now() }, { merge: true });

    const speeds = parsed.data.points.map(p => p.speed ?? 0).filter(s => s > 0);
    if (speeds.length) {
      const max = Math.max(...speeds, ride.max_speed ?? 0);
      await db.collection(COL.rides).doc(req.params.id).update({ max_speed: +max.toFixed(1) });
    }

    res.status(201).json({ accepted: parsed.data.points.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/track', requireAuth, async (req: AuthRequest, res: Response) => {
  const ride = await accessibleRide(req.params.id, req.user!.id);
  if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }

  try {
    const snap = await db.collection(COL.rides).doc(req.params.id).collection('track').get();
    const batches = sortBy(snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[], 'from', 'asc');
    const points = batches.flatMap(b => b.points ?? []);
    res.json({ points, batches: batches.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
