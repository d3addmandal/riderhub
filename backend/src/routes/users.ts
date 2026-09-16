import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, now, defined } from '../lib/firestore';
import { AuthRequest } from '../types';

const router = Router();

/**
 * One person to reach when things go wrong.
 *
 * `phone` is what gets dialled and texted; `whatsapp` is kept separate because plenty of
 * riders carry a second number for WhatsApp, and sending the alert to the wrong one is
 * the sort of mistake that only shows up when it matters.
 */
const contactSchema = z.object({
  name: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(24).optional(),
  whatsapp: z.string().trim().max(24).optional(),
});

export type EmergencyContact = z.infer<typeof contactSchema>;

const profileSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  blood_group: z.string().optional(),
  medical_notes: z.string().optional(),
  // Kept so older profiles keep working; the array below is the one that is used.
  emergency_contact_name: z.string().optional(),
  emergency_contact_phone: z.string().optional(),
  /** Up to two people, each with a dialling number and a WhatsApp number. */
  emergency_contacts: z.array(contactSchema).max(2).optional(),
  telegram_chat_id: z.string().optional(),
});

/**
 * Profiles are keyed by the Firebase UID. A rider signing in for the first time has no
 * document yet, so bootstrap one from the ID token claims instead of 404-ing them
 * into an empty app.
 */
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.user!.id;
  const ref = db.collection(COL.profiles).doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    res.json(docData(snap));
    return;
  }

  const seeded = {
    name: req.user!.name || req.user!.email.split('@')[0] || 'Rider',
    email: req.user!.email,
    avatar_url: req.user!.picture ?? null,
    country: 'India',
    created_at: now(),
    updated_at: now(),
  };

  await ref.set(seeded);
  res.json({ id: uid, ...seeded });
});

router.post('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const uid = req.user!.id;
  const ref = db.collection(COL.profiles).doc(uid);
  const existing = await ref.get();

  const payload = {
    ...defined(parsed.data),
    email: req.user!.email,
    updated_at: now(),
    ...(existing.exists ? {} : { created_at: now() }),
  };

  await ref.set(payload, { merge: true });

  const saved = await ref.get();
  res.json(docData(saved));
});

router.put('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = profileSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const ref = db.collection(COL.profiles).doc(req.user!.id);
  await ref.set({ ...defined(parsed.data), updated_at: now() }, { merge: true });

  const saved = await ref.get();
  res.json(docData(saved));
});

export default router;
