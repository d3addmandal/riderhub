import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { queryAll, getOwned, deleteOwned, bikeMap, withBike, now, defined, sortBy } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

/**
 * Things the rider has noticed and wants looked at.
 *
 * A rider spots a problem mid-ride — a rattle, a spongy lever, a weeping fork seal — and
 * by the time the bike is actually in a workshop weeks later it has been forgotten, or
 * half-remembered as "something about the front". This is the list they read out at the
 * counter, and afterwards each entry is closed against the service that dealt with it, so
 * the bike's history says what was wrong as well as what was replaced.
 */
const issueSchema = z.object({
  motorcycle_id: z.string().min(1),
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  /*
   * How much it matters, in the rider's own judgement:
   *   watch   — noted, no hurry
   *   soon    — get it seen at the next service
   *   urgent  — affects whether the bike is safe to ride now
   * Deliberately the rider's call, not inferred: they are the one who heard it.
   */
  severity: z.enum(['watch', 'soon', 'urgent']).optional(),
  noted_odometer: z.number().int().min(0).optional(),
  noted_at: z.string().optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    let q = db.collection(COL.issues).where('user_id', '==', req.user!.id);
    if (req.query.motorcycle_id) q = q.where('motorcycle_id', '==', String(req.query.motorcycle_id));
    if (req.query.status) q = q.where('status', '==', String(req.query.status));

    const rows = await queryAll<any>(q);
    const bikes = await bikeMap(req.user!.id);

    // Open first, then the ones that matter most, then newest. Sorted here rather than in
    // Firestore so no composite index is needed — see firestore.indexes.json.
    const rank: Record<string, number> = { urgent: 0, soon: 1, watch: 2 };
    rows.sort((a, b) =>
      (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
      (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1) ||
      String(b.noted_at ?? '').localeCompare(String(a.noted_at ?? '')));

    res.json(rows.map(r => withBike(r, bikes)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // Only against a bike the rider actually owns.
  const bike = await getOwned<any>(COL.motorcycles, parsed.data.motorcycle_id, req.user!.id);
  if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

  try {
    const payload = {
      ...defined(parsed.data),
      user_id: req.user!.id,
      severity: parsed.data.severity ?? 'soon',
      // Where the bike was when it was noticed, so a workshop can see how long it has
      // been going on. Falls back to the odometer we already hold for the bike.
      noted_odometer: parsed.data.noted_odometer ?? bike.current_odometer ?? null,
      noted_at: parsed.data.noted_at ?? now(),
      status: 'open' as const,
      fixed_at: null,
      fixed_by_service_id: null,
      fix_notes: null,
      created_at: now(),
      updated_at: now(),
    };
    const ref = await db.collection(COL.issues).add(payload);
    res.status(201).json({ id: ref.id, ...payload });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = issueSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned<any>(COL.issues, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Note not found' }); return; }

  try {
    const ref = db.collection(COL.issues).doc(req.params.id);
    await ref.update({ ...defined(parsed.data), updated_at: now() });
    const saved = await ref.get();
    res.json({ id: saved.id, ...saved.data() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Close a note by hand — fixed at the roadside, or it turned out to be nothing. */
router.post('/:id/fix', requireAuth, async (req: AuthRequest, res: Response) => {
  const body = z.object({
    service_id: z.string().optional(),
    fix_notes: z.string().max(4000).optional(),
  }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.flatten() }); return; }

  const existing = await getOwned<any>(COL.issues, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Note not found' }); return; }

  // Only ever point at a service record that is really the rider's own.
  if (body.data.service_id) {
    const service = await getOwned<any>(COL.serviceRecords, body.data.service_id, req.user!.id);
    if (!service) { res.status(404).json({ error: 'Service record not found' }); return; }
  }

  const ref = db.collection(COL.issues).doc(req.params.id);
  await ref.update({
    status: 'fixed',
    fixed_at: now(),
    fixed_by_service_id: body.data.service_id ?? null,
    fix_notes: body.data.fix_notes ?? null,
    updated_at: now(),
  });
  const saved = await ref.get();
  res.json({ id: saved.id, ...saved.data() });
});

/** It came back. */
router.post('/:id/reopen', requireAuth, async (req: AuthRequest, res: Response) => {
  const existing = await getOwned<any>(COL.issues, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Note not found' }); return; }

  const ref = db.collection(COL.issues).doc(req.params.id);
  await ref.update({
    status: 'open', fixed_at: null, fixed_by_service_id: null, updated_at: now(),
  });
  const saved = await ref.get();
  res.json({ id: saved.id, ...saved.data() });
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await deleteOwned(COL.issues, req.params.id, req.user!.id);
  if (!ok) { res.status(404).json({ error: 'Note not found' }); return; }
  res.status(204).send();
});

/**
 * Close the notes a service dealt with, and say which ones actually closed.
 *
 * Called when a service record is saved. Ownership is re-checked per note rather than
 * trusted from the request, and anything already closed or belonging to someone else is
 * skipped quietly — a mistyped id should not fail the service the rider just logged.
 */
export async function resolveIssues(
  ids: string[], userId: string, serviceId: string,
): Promise<string[]> {
  const closed: string[] = [];
  await Promise.all(ids.map(async id => {
    const issue = await getOwned<any>(COL.issues, id, userId);
    if (!issue || issue.status === 'fixed') return;
    await db.collection(COL.issues).doc(id).update({
      status: 'fixed',
      fixed_at: now(),
      fixed_by_service_id: serviceId,
      updated_at: now(),
    });
    closed.push(issue.title);
  }));
  return closed;
}

export default router;
