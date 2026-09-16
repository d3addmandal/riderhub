import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, getOwned, bikeMap, withBike, now, defined, sortBy } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

/**
 * The documents vault tracks paperwork *expiry*, not the paperwork itself — no files are
 * stored. Firebase Cloud Storage requires a Blaze billing account as of Feb 2026, and this
 * app must stay free to run, so the value here is the reminder that your insurance lapses
 * in nine days rather than a copy of the PDF.
 */
const docSchema = z.object({
  motorcycle_id: z.string().min(1).optional(),
  doc_type: z.enum(['RC','Insurance','PUC','Driving License','Service Invoice','Purchase Invoice','Other']),
  title: z.string().min(1),
  issuer: z.string().optional(),          // e.g. "HDFC Ergo", "RTO Pune"
  policy_number: z.string().optional(),   // policy / certificate reference
  issue_date: z.string().optional(),
  expiry_date: z.string().optional(),
  notes: z.string().optional(),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { bike_id, doc_type } = req.query;

  try {
    let query = db.collection(COL.documents)
      .where('user_id', '==', req.user!.id);

    if (bike_id) query = query.where('motorcycle_id', '==', bike_id as string);
    if (doc_type) query = query.where('doc_type', '==', doc_type as string);

    const docs = sortBy(await queryAll<any>(query), 'created_at', 'desc');
    const bikes = await bikeMap(req.user!.id);

    res.json(docs.map(d => withBike(d, bikes)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const payload = {
      ...defined(parsed.data),
      user_id: req.user!.id,
      created_at: now(),
      updated_at: now(),
    };

    const ref = await db.collection(COL.documents).add(payload);
    res.status(201).json({ id: ref.id, ...payload });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = docSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const existing = await getOwned(COL.documents, req.params.id, req.user!.id);
  if (!existing) { res.status(404).json({ error: 'Document not found' }); return; }

  try {
    const ref = db.collection(COL.documents).doc(req.params.id);
    await ref.update({ ...defined(parsed.data), updated_at: now() });

    const saved = await ref.get();
    res.json(docData(saved));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const doc = await getOwned(COL.documents, req.params.id, req.user!.id);
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }

  try {
    await db.collection(COL.documents).doc(req.params.id).delete();
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
