import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { queryAll, deleteOwned, getOwned, bikeMap, withBike, bumpOdometer, now, defined, sortBy } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

const fuelSchema = z.object({
  motorcycle_id: z.string().min(1),
  date: z.string(),
  odometer: z.number().int().min(0),
  litres: z.number().positive(),
  amount: z.number().positive(),
  price_per_l: z.number().optional(),
  station: z.string().optional(),
  fuel_type: z.enum(['Petrol', 'Diesel', 'CNG', 'Electric']).optional(),
  full_tank: z.boolean().optional(),
  notes: z.string().optional(),
  /**
   * Set when the fill-up happened during a ride, so its cost and litres roll into that
   * ride's totals. The rider tanks up once and it counts in both places.
   */
  ride_id: z.string().min(1).nullable().optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { bike_id, limit = '20', offset = '0' } = req.query;

  try {
    let query = db.collection(COL.fuelEntries)
      .where('user_id', '==', req.user!.id);

    if (bike_id) query = query.where('motorcycle_id', '==', bike_id as string);

    const take = parseInt(limit as string, 10) || 20;
    const skip = parseInt(offset as string, 10) || 0;

    // Newest first, then paginate in memory — keeps the query index-free.
    const all = sortBy(await queryAll<any>(query), 'date', 'desc');
    const entries = all.slice(skip, skip + take);

    const bikes = await bikeMap(req.user!.id);
    res.json(entries.map(e => withBike(e, bikes)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = fuelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    // A fill-up may only be attached to a ride the caller actually owns.
    if (parsed.data.ride_id) {
      const ride = await getOwned<any>(COL.rides, parsed.data.ride_id, req.user!.id);
      if (!ride) { res.status(404).json({ error: 'Ride not found' }); return; }
      if (ride.motorcycle_id !== parsed.data.motorcycle_id) {
        res.status(400).json({ error: 'That ride was taken on a different bike.' });
        return;
      }
    }

    const price_per_l = parsed.data.price_per_l ?? +(parsed.data.amount / parsed.data.litres).toFixed(2);

    const payload = {
      ...defined(parsed.data),
      price_per_l,
      fuel_type: parsed.data.fuel_type ?? 'Petrol',
      full_tank: parsed.data.full_tank ?? true,
      user_id: req.user!.id,
      created_at: now(),
    };

    const ref = await db.collection(COL.fuelEntries).add(payload);

    await bumpOdometer(parsed.data.motorcycle_id, req.user!.id, parsed.data.odometer);

    res.status(201).json({ id: ref.id, ...payload });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Correct a fuel entry (spec §49). Price per litre is always recomputed. */
router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = fuelSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned<any>(COL.fuelEntries, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Entry not found' }); return; }

  try {
    const litres = parsed.data.litres ?? existing.litres;
    const amount = parsed.data.amount ?? existing.amount;

    const ref = db.collection(COL.fuelEntries).doc(req.params.id);
    await ref.update({
      ...defined(parsed.data),
      price_per_l: litres > 0 ? +(amount / litres).toFixed(2) : null,
      updated_at: now(),
    });

    if (parsed.data.odometer) {
      await bumpOdometer(existing.motorcycle_id, req.user!.id, parsed.data.odometer);
    }

    const saved = await ref.get();
    res.json({ id: saved.id, ...saved.data() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await deleteOwned(COL.fuelEntries, req.params.id, req.user!.id);
  if (!ok) { res.status(404).json({ error: 'Entry not found' }); return; }
  res.status(204).send();
});

router.get('/stats/:bikeId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const entries = sortBy(await queryAll<any>(
      db.collection(COL.fuelEntries)
        .where('user_id', '==', req.user!.id)
        .where('motorcycle_id', '==', req.params.bikeId)
    ), 'odometer', 'asc');

    if (entries.length < 2) {
      res.json({ entries, mileage: null, total_fuel: 0, total_cost: 0 });
      return;
    }

    let totalFuel = 0, totalCost = 0, totalDistance = 0;
    for (let i = 1; i < entries.length; i++) {
      const dist = entries[i].odometer - entries[i - 1].odometer;
      if (dist > 0 && entries[i].full_tank) {
        totalFuel += entries[i].litres;
        totalCost += entries[i].amount;
        totalDistance += dist;
      }
    }

    const avgMileage = totalFuel > 0 ? +(totalDistance / totalFuel).toFixed(2) : null;
    const costPerKm = totalDistance > 0 ? +(totalCost / totalDistance).toFixed(2) : null;

    res.json({
      entries,
      mileage: avgMileage,
      total_fuel: totalFuel,
      total_cost: totalCost,
      total_distance: totalDistance,
      cost_per_km: costPerKm,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
