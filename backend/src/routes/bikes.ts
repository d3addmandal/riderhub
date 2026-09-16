import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, getOwned, deleteOwned, now, defined, sortBy } from '../lib/firestore';
import { ensureComponents } from '../lib/maintenanceRepo';
import { AuthRequest } from '../types';

const router = Router();

const bikeSchema = z.object({
  brand: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().optional(),
  year: z.number().int().min(1900).max(2030).optional(),
  registration_no: z.string().optional(),
  engine_no: z.string().optional(),
  chassis_no: z.string().optional(),
  purchase_date: z.string().optional(),
  current_odometer: z.number().int().min(0).optional(),
  fuel_capacity: z.number().optional(),
  engine_oil_type: z.string().optional(),
  tyre_size: z.string().optional(),
  battery_model: z.string().optional(),
  color: z.string().optional(),
  avatar_url: z.string().optional(),
  is_primary: z.boolean().optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const bikes = await queryAll<any>(
      db.collection(COL.motorcycles).where('user_id', '==', req.user!.id)
    );
    // Primary bike first, then newest. Sorted here so no composite index is required.
    bikes.sort((a, b) =>
      (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) ||
      String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
    );
    res.json(bikes);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const bike = await getOwned(COL.motorcycles, req.params.id, req.user!.id);
  if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }
  res.json(bike);
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = bikeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const payload = {
      ...defined(parsed.data),
      user_id: req.user!.id,
      current_odometer: parsed.data.current_odometer ?? 0,
      is_primary: parsed.data.is_primary ?? false,
      created_at: now(),
      updated_at: now(),
    };

    const ref = await db.collection(COL.motorcycles).add(payload);

    // Give the bike its maintenance components immediately, so the garage and the
    // service automation are useful from the very first screen the rider opens.
    try {
      await ensureComponents(ref.id, req.user!.id, payload.current_odometer);
    } catch (e) {
      console.error('Seeding maintenance for new bike failed:', e);
    }

    res.status(201).json({ id: ref.id, ...payload });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = bikeSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned(COL.motorcycles, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Bike not found' }); return; }

  const ref = db.collection(COL.motorcycles).doc(req.params.id);
  await ref.update({ ...defined(parsed.data), updated_at: now() });

  const saved = await ref.get();
  res.json(docData(saved));
});

router.patch('/:id/odometer', requireAuth, async (req: AuthRequest, res: Response) => {
  const { odometer } = req.body;
  if (typeof odometer !== 'number' || odometer < 0) {
    res.status(400).json({ error: 'Invalid odometer value' }); return;
  }

  const existing = await getOwned(COL.motorcycles, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Bike not found' }); return; }

  const ref = db.collection(COL.motorcycles).doc(req.params.id);
  await ref.update({ current_odometer: odometer, updated_at: now() });

  const saved = await ref.get();
  res.json(docData(saved));
});

/**
 * Delete a bike and everything hanging off it.
 *
 * Firestore has no cascading delete, so without this the bike's fuel, service,
 * maintenance and reminder records survive their parent and quietly distort lifetime
 * totals. Documents are unlinked rather than deleted — a driving licence outlives a bike.
 */
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const bikeId = req.params.id;

  const bike = await getOwned(COL.motorcycles, bikeId, userId);
  if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

  try {
    const children = [COL.fuelEntries, COL.serviceRecords, COL.maintenance, COL.reminders];
    const removed: Record<string, number> = {};

    for (const col of children) {
      const snap = await db.collection(col)
        .where('user_id', '==', userId)
        .where('motorcycle_id', '==', bikeId)
        .get();

      removed[col] = snap.size;
      // Firestore caps a batch at 500 writes.
      for (let i = 0; i < snap.docs.length; i += 450) {
        const batch = db.batch();
        snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }

    // Documents survive; they just stop pointing at a bike that no longer exists.
    const docs = await db.collection(COL.documents)
      .where('user_id', '==', userId)
      .where('motorcycle_id', '==', bikeId)
      .get();
    if (!docs.empty) {
      const batch = db.batch();
      docs.docs.forEach(d => batch.update(d.ref, { motorcycle_id: null }));
      await batch.commit();
      removed[COL.documents] = 0;
    }

    await db.collection(COL.motorcycles).doc(bikeId).delete();

    res.json({ deleted: true, removed, documents_unlinked: docs.size });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
