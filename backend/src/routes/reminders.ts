import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, getOwned, bikeMap, withBike, now, defined, sortBy } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

const reminderSchema = z.object({
  motorcycle_id: z.string().min(1),
  reminder_type: z.string().min(1),
  trigger_type: z.enum(['distance', 'date']),
  trigger_km: z.number().int().optional(),
  trigger_date: z.string().optional(),
  interval_km: z.number().int().optional(),
  interval_days: z.number().int().optional(),
  last_done_km: z.number().int().optional(),
  last_done_date: z.string().optional(),
  notify_telegram: z.boolean().optional(),
  notify_email: z.boolean().optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const reminders = sortBy(await queryAll<any>(
      db.collection(COL.reminders)
        .where('user_id', '==', req.user!.id)
        .where('is_active', '==', true)
    ), 'created_at', 'desc');

    const bikes = await bikeMap(req.user!.id);

    // Compute due status for each reminder
    const enriched = reminders.map(r => {
      const row = withBike(r, bikes);
      let isDue = false, kmRemaining = null, daysRemaining = null;

      if (row.trigger_type === 'distance' && row.motorcycles) {
        const nextKm = (row.last_done_km || 0) + (row.interval_km || row.trigger_km || 0);
        kmRemaining = nextKm - row.motorcycles.current_odometer;
        isDue = kmRemaining <= 0;
      } else if (row.trigger_type === 'date' && row.trigger_date) {
        const days = Math.ceil((new Date(row.trigger_date).getTime() - Date.now()) / 86400000);
        daysRemaining = days;
        isDue = days <= 0;
      }

      return { ...row, isDue, kmRemaining, daysRemaining };
    });

    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = reminderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const payload = {
      ...defined(parsed.data),
      notify_telegram: parsed.data.notify_telegram ?? true,
      notify_email: parsed.data.notify_email ?? false,
      is_active: true,
      user_id: req.user!.id,
      created_at: now(),
      updated_at: now(),
    };

    const ref = await db.collection(COL.reminders).add(payload);
    res.status(201).json({ id: ref.id, ...payload });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/done', requireAuth, async (req: AuthRequest, res: Response) => {
  const { odometer, date } = req.body;

  const reminder = await getOwned<any>(COL.reminders, req.params.id, req.user!.id);
  if (!reminder) { res.status(404).json({ error: 'Reminder not found' }); return; }

  try {
    const updates: Record<string, unknown> = {
      last_done_km: odometer ?? reminder.last_done_km ?? null,
      last_done_date: date || new Date().toISOString().split('T')[0],
      updated_at: now(),
    };

    if (reminder.trigger_type === 'date' && reminder.interval_days) {
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + reminder.interval_days);
      updates.trigger_date = nextDate.toISOString().split('T')[0];
    }

    const ref = db.collection(COL.reminders).doc(req.params.id);
    await ref.update(updates);

    const saved = await ref.get();
    res.json(docData(saved));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Soft delete — matches the old behaviour of flipping is_active rather than removing. */
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const reminder = await getOwned(COL.reminders, req.params.id, req.user!.id);
  if (!reminder) { res.status(404).json({ error: 'Reminder not found' }); return; }

  try {
    await db.collection(COL.reminders).doc(req.params.id)
      .update({ is_active: false, updated_at: now() });
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
