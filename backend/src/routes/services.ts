import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { queryAll, deleteOwned, getOwned, bikeMap, withBike, bumpOdometer, now, defined, sortBy } from '../lib/firestore';
import { matchComponentKey } from '../lib/maintenance';
import { ensureComponents } from '../lib/maintenanceRepo';
import { AuthRequest } from '../types';

const router = Router();

const partSchema = z.object({
  part_name: z.string().min(1),
  brand: z.string().optional(),
  /** Line total for this part, quantity already included. */
  cost: z.number().min(0).optional(),
  quantity: z.number().int().min(1).optional(),
  part_number: z.string().optional(),
  warranty_months: z.number().int().min(0).optional(),
});

const serviceSchema = z.object({
  motorcycle_id: z.string().min(1),
  service_number: z.string().optional(),
  service_date: z.string(),
  odometer: z.number().int().min(0),
  workshop: z.string().optional(),
  advisor: z.string().optional(),
  service_type: z.string().optional(),
  notes: z.string().optional(),
  invoice_url: z.string().optional(),
  next_service_km: z.number().int().min(0).optional(),
  next_service_date: z.string().optional(),
  parts: z.array(partSchema).optional(),

  // ── Cost breakdown (spec §8.3) ─────────────────────────────
  // The total is always computed here rather than trusted from the client, so the
  // itemised figures and the total can never disagree.
  labour_cost: z.number().min(0).optional(),
  tax: z.number().min(0).optional(),
  other_charges: z.number().min(0).optional(),
  /** Legacy alias for labour_cost, kept so older clients keep working. */
  cost: z.number().min(0).optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { bike_id } = req.query;

  try {
    let query = db.collection(COL.serviceRecords)
      .where('user_id', '==', req.user!.id);

    if (bike_id) query = query.where('motorcycle_id', '==', bike_id as string);

    const records = sortBy(await queryAll<any>(query), 'service_date', 'desc');
    const bikes = await bikeMap(req.user!.id);

    res.json(records.map(r => withBike(r, bikes)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const { parts, ...serviceData } = parsed.data;

    // Parts only ever belong to one service record and are always read with it,
    // so they live inline rather than in their own collection.
    const service_parts = (parts ?? []).map((p, i) => ({
      id: `${i}`,
      part_name: p.part_name,
      brand: p.brand ?? null,
      cost: p.cost ?? 0,
      quantity: p.quantity ?? 1,
      part_number: p.part_number ?? null,
      warranty_months: p.warranty_months ?? null,
    }));

    // Totals are derived, never accepted from the client.
    const labour = serviceData.labour_cost ?? serviceData.cost ?? 0;
    const partsCost = service_parts.reduce((s, p) => s + p.cost, 0);
    const tax = serviceData.tax ?? 0;
    const other = serviceData.other_charges ?? 0;
    const total = labour + partsCost + tax + other;

    const payload = {
      ...defined(serviceData),
      labour_cost: labour,
      parts_cost: partsCost,
      tax,
      other_charges: other,
      /** `cost` stays the grand total — every existing reader already treats it that way. */
      cost: total,
      service_type: serviceData.service_type ?? 'General',
      service_parts,
      user_id: req.user!.id,
      created_at: now(),
      updated_at: now(),
    };

    const ref = await db.collection(COL.serviceRecords).add(payload);

    await bumpOdometer(serviceData.motorcycle_id, req.user!.id, serviceData.odometer);

    // Spec §25 — a service that replaced parts resets those maintenance clocks, so the
    // rider never enters the same fact twice.
    const maintenanceUpdated = await applyServiceToMaintenance({
      userId: req.user!.id,
      bikeId: serviceData.motorcycle_id,
      serviceId: ref.id,
      odometer: serviceData.odometer,
      date: serviceData.service_date,
      partNames: [
        ...service_parts.map(p => p.part_name),
        // A "General Service" record should tick the general-service component too.
        serviceData.service_type ?? '',
      ].filter(Boolean),
    });

    res.status(201).json({ id: ref.id, ...payload, maintenance_updated: maintenanceUpdated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** One service record in full (spec §8.2). */
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const record = await getOwned<any>(COL.serviceRecords, req.params.id, req.user!.id);
  if (!record) { res.status(404).json({ error: 'Service record not found' }); return; }

  const bikes = await bikeMap(req.user!.id);
  res.json(withBike(record, bikes));
});

/** Correct a service record. Totals are recomputed, never trusted (spec §8.3, §48). */
router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = serviceSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned<any>(COL.serviceRecords, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Service record not found' }); return; }

  try {
    const { parts, ...rest } = parsed.data;

    const service_parts = parts
      ? parts.map((p, i) => ({
          id: `${i}`,
          part_name: p.part_name,
          brand: p.brand ?? null,
          cost: p.cost ?? 0,
          quantity: p.quantity ?? 1,
          part_number: p.part_number ?? null,
          warranty_months: p.warranty_months ?? null,
        }))
      : existing.service_parts ?? [];

    const labour = rest.labour_cost ?? rest.cost ?? existing.labour_cost ?? 0;
    const partsCost = service_parts.reduce((s: number, p: any) => s + (p.cost ?? 0), 0);
    const tax = rest.tax ?? existing.tax ?? 0;
    const other = rest.other_charges ?? existing.other_charges ?? 0;

    const ref = db.collection(COL.serviceRecords).doc(req.params.id);
    await ref.update({
      ...defined(rest),
      service_parts,
      labour_cost: labour,
      parts_cost: partsCost,
      tax,
      other_charges: other,
      cost: labour + partsCost + tax + other,
      updated_at: now(),
    });

    if (rest.odometer) {
      await bumpOdometer(existing.motorcycle_id, req.user!.id, rest.odometer);
    }

    const saved = await ref.get();
    res.json({ id: saved.id, ...saved.data() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await deleteOwned(COL.serviceRecords, req.params.id, req.user!.id);
  if (!ok) { res.status(404).json({ error: 'Service record not found' }); return; }
  res.status(204).send();
});

/**
 * Reset the maintenance clock for every component a service touched.
 *
 * Matching is by keyword on the part name — "Motul 10W-40 engine oil" resolves to the
 * engine-oil component. Unmatched parts are simply left alone rather than guessed at,
 * and the rider can still tick the component by hand.
 *
 * Returns the component names that were updated, so the UI can confirm what happened.
 */
async function applyServiceToMaintenance(opts: {
  userId: string;
  bikeId: string;
  serviceId: string;
  odometer: number;
  date: string;
  partNames: string[];
}): Promise<string[]> {
  const keys = new Set(
    opts.partNames.map(matchComponentKey).filter((k): k is string => Boolean(k))
  );
  if (!keys.size) return [];

  try {
    // Seed first: a rider can log a service before ever opening the maintenance screen,
    // and without components there would be nothing to reset.
    const components = await ensureComponents(opts.bikeId, opts.userId, opts.odometer);

    const hits = components.filter(
      c => c.component_key && keys.has(c.component_key) && c.is_active !== false
    );
    if (!hits.length) return [];

    const batch = db.batch();
    for (const c of hits) {
      const updates: Record<string, unknown> = {
        last_changed_km: opts.odometer,
        last_changed_date: opts.date,
        next_due_km: c.interval_km ? opts.odometer + c.interval_km : null,
        next_due_date: null,
        last_service_id: opts.serviceId,
        updated_at: now(),
      };
      if (c.interval_days) {
        const d = new Date(opts.date + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + c.interval_days);
        updates.next_due_date = d.toISOString().split('T')[0];
      }
      batch.update(db.collection(COL.maintenance).doc(c.id), updates);
    }
    await batch.commit();
    return hits.map(c => c.name);
  } catch (e) {
    // A maintenance sync failure must never lose the service record itself.
    console.error('Maintenance sync after service failed:', e);
    return [];
  }
}

export default router;
