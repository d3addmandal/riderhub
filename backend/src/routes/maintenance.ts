import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, getOwned, now, defined } from '../lib/firestore';
import {
  DEFAULT_COMPONENTS, withStatus, bySeverity, MaintenanceComponent,
} from '../lib/maintenance';
import { ensureComponents } from '../lib/maintenanceRepo';
import { AuthRequest } from '../types';

const router = Router();

const componentSchema = z.object({
  motorcycle_id: z.string().min(1),
  name: z.string().min(1).max(80),
  category: z.string().max(40).optional(),
  interval_km: z.number().int().positive().nullable().optional(),
  interval_days: z.number().int().positive().nullable().optional(),
  last_changed_km: z.number().int().min(0).nullable().optional(),
  last_changed_date: z.string().nullable().optional(),
  next_due_km: z.number().int().min(0).nullable().optional(),
  next_due_date: z.string().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  last_cost: z.number().min(0).nullable().optional(),
});

/** Confirm the bike belongs to the caller before touching anything hanging off it. */
async function ownedBike(bikeId: string, userId: string) {
  return getOwned<any>(COL.motorcycles, bikeId, userId);
}

/**
 * Components for one bike, each with its live status.
 * Seeds the default set the first time a bike is opened, so a new rider gets a useful
 * maintenance screen without configuring twenty components by hand.
 */
router.get('/bike/:bikeId', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  try {
    const bike = await ownedBike(req.params.bikeId, userId);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    let components = await queryAll<MaintenanceComponent>(
      db.collection(COL.maintenance)
        .where('user_id', '==', userId)
        .where('motorcycle_id', '==', req.params.bikeId)
    );

    if (!components.length && req.query.seed !== 'false') {
      components = await ensureComponents(req.params.bikeId, userId, bike.current_odometer ?? 0);
    }

    const odometer = bike.current_odometer ?? 0;
    const enriched = components
      .filter(c => c.is_active !== false)
      .map(c => withStatus(c, odometer));
    enriched.sort(bySeverity);

    res.json({
      bike: { id: bike.id, brand: bike.brand, model: bike.model, current_odometer: odometer },
      components: enriched,
      summary: {
        overdue: enriched.filter(c => c.status === 'overdue').length,
        due: enriched.filter(c => c.status === 'due').length,
        due_soon: enriched.filter(c => c.status === 'due_soon').length,
        healthy: enriched.filter(c => c.status === 'healthy').length,
        unknown: enriched.filter(c => c.status === 'unknown').length,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Explicitly (re-)seed. Useful after adding a bike, or to restore deleted defaults. */
router.post('/bike/:bikeId/seed', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const bike = await ownedBike(req.params.bikeId, req.user!.id);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    const existing = await queryAll<MaintenanceComponent>(
      db.collection(COL.maintenance)
        .where('user_id', '==', req.user!.id)
        .where('motorcycle_id', '==', req.params.bikeId)
    );
    const have = new Set(existing.map(c => c.component_key).filter(Boolean));
    const missing = DEFAULT_COMPONENTS.filter(t => !have.has(t.key));

    if (!missing.length) { res.json({ added: 0, components: existing }); return; }

    const odometer = bike.current_odometer ?? 0;
    const batch = db.batch();
    for (const t of missing) {
      batch.set(db.collection(COL.maintenance).doc(), {
        user_id: req.user!.id,
        motorcycle_id: req.params.bikeId,
        component_key: t.key,
        name: t.name,
        category: t.category,
        interval_km: t.interval_km ?? null,
        interval_days: t.interval_days ?? null,
        last_changed_km: odometer,
        last_changed_date: null,
        next_due_km: t.interval_km ? odometer + t.interval_km : null,
        next_due_date: null,
        is_active: true,
        created_at: now(),
        updated_at: now(),
      });
    }
    await batch.commit();
    res.json({ added: missing.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Add a rider-defined component (spec §6 — the list must be configurable). */
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = componentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  if (!parsed.data.interval_km && !parsed.data.interval_days
      && !parsed.data.next_due_km && !parsed.data.next_due_date) {
    res.status(400).json({ error: 'Give the component a distance interval, a time interval, or an explicit next-due value.' });
    return;
  }

  try {
    const bike = await ownedBike(parsed.data.motorcycle_id, req.user!.id);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    const payload = {
      ...defined(parsed.data),
      category: parsed.data.category || 'Other',
      component_key: null,
      is_active: true,
      user_id: req.user!.id,
      created_at: now(),
      updated_at: now(),
    };
    const ref = await db.collection(COL.maintenance).add(payload);
    res.status(201).json(withStatus({ id: ref.id, ...payload } as any, bike.current_odometer ?? 0));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = componentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned<MaintenanceComponent>(COL.maintenance, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Component not found' }); return; }

  try {
    const ref = db.collection(COL.maintenance).doc(req.params.id);
    await ref.update({ ...defined(parsed.data), updated_at: now() });
    const saved = docData<MaintenanceComponent>(await ref.get());
    const bike = await ownedBike(saved.motorcycle_id, req.user!.id);
    res.json(withStatus(saved, bike?.current_odometer ?? 0));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Mark a component replaced. Resets both clocks from the reading and date supplied,
 * defaulting to the bike's current odometer and today (spec §25).
 */
router.post('/:id/replaced', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    odometer: z.number().int().min(0).optional(),
    date: z.string().optional(),
    cost: z.number().min(0).optional(),
    notes: z.string().max(500).optional(),
    service_id: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const component = await getOwned<MaintenanceComponent>(COL.maintenance, req.params.id, req.user!.id);
  if (!component) { res.status(404).json({ error: 'Component not found' }); return; }

  try {
    const bike = await ownedBike(component.motorcycle_id, req.user!.id);
    const odometer = parsed.data.odometer ?? bike?.current_odometer ?? 0;
    const date = parsed.data.date ?? new Date().toISOString().split('T')[0];

    const updates = {
      last_changed_km: odometer,
      last_changed_date: date,
      next_due_km: component.interval_km ? odometer + component.interval_km : null,
      next_due_date: null as string | null,
      last_cost: parsed.data.cost ?? component.last_cost ?? null,
      last_service_id: parsed.data.service_id ?? null,
      notes: parsed.data.notes ?? component.notes ?? null,
      updated_at: now(),
    };
    if (component.interval_days) {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + component.interval_days);
      updates.next_due_date = d.toISOString().split('T')[0];
    }

    const ref = db.collection(COL.maintenance).doc(req.params.id);
    await ref.update(updates);
    res.json(withStatus(docData<MaintenanceComponent>(await ref.get()), bike?.current_odometer ?? 0));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Soft delete, so a component removed by accident keeps its history. */
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const component = await getOwned(COL.maintenance, req.params.id, req.user!.id);
  if (!component) { res.status(404).json({ error: 'Component not found' }); return; }

  try {
    await db.collection(COL.maintenance).doc(req.params.id)
      .update({ is_active: false, updated_at: now() });
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
