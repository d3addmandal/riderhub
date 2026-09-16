import { Router, Response } from 'express';
import { z } from 'zod';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { queryAll, now, defined, sortBy } from '../lib/firestore';
import { sendSOS } from '../services/telegram';
import { AuthRequest } from '../types';

const router = Router();

const sosSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
  message: z.string().optional(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = sosSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const profileSnap = await db.collection(COL.profiles).doc(req.user!.id).get();
    const profile = profileSnap.data();

    const mapsLink = `https://maps.google.com/?q=${parsed.data.lat},${parsed.data.lng}`;
    const riderName = profile?.name || 'A rider';

    // One text, used everywhere, so the phone alert and the Telegram alert say the same
    // thing. Blood group goes in because it is the first thing an ambulance asks.
    const alertText = [
      `SOS from ${riderName}.`,
      parsed.data.message?.trim() || 'I need help.',
      parsed.data.address ? `Near: ${parsed.data.address}` : null,
      `Location: ${mapsLink}`,
      profile?.blood_group ? `Blood group: ${profile.blood_group}` : null,
      profile?.medical_notes ? `Medical: ${profile.medical_notes}` : null,
      profile?.phone ? `My number: ${profile.phone}` : null,
    ].filter(Boolean).join('\n');

    /**
     * What the server can genuinely send by itself, versus what needs the rider's phone.
     *
     * Telegram is a real send: we hold the chat id and post the message, no rider action.
     * SMS and WhatsApp are not. A browser cannot put a message through the SIM, and
     * WhatsApp has no send API — both can only be *opened* pre-filled, and the rider taps
     * send. Rather than pretend otherwise, the links are prepared here and the response
     * says plainly which channel was automatic and which still needs a tap.
     */
    const sentTo: string[] = [];
    const telegramFailed: string[] = [];

    if (profile?.telegram_chat_id) {
      try {
        await sendSOS({
          chatId: profile.telegram_chat_id,
          riderName,
          bloodGroup: profile.blood_group,
          medicalNotes: profile.medical_notes,
          mapsLink,
          message: parsed.data.message,
        });
        sentTo.push('telegram');
      } catch (e: any) {
        // A failed Telegram send must not stop the event being recorded — the rider is
        // in trouble and the other channels still need their links.
        telegramFailed.push(e?.message ?? 'unknown error');
      }
    }

    // Contacts, newest shape first, falling back to the single legacy pair.
    const contacts: { name?: string; phone?: string; whatsapp?: string }[] =
      Array.isArray(profile?.emergency_contacts) && profile!.emergency_contacts.length
        ? profile!.emergency_contacts
        : (profile?.emergency_contact_phone
            ? [{ name: profile.emergency_contact_name, phone: profile.emergency_contact_phone }]
            : []);

    const encoded = encodeURIComponent(alertText);
    const channels = contacts.flatMap(c => {
      const out: { name: string; kind: 'sms' | 'whatsapp' | 'call'; to: string; url: string }[] = [];
      const label = c.name?.trim() || c.phone || c.whatsapp || 'Contact';
      if (c.phone) {
        const tel = c.phone.replace(/[^\d+]/g, '');
        out.push({ name: label, kind: 'sms', to: tel, url: `sms:${tel}?body=${encoded}` });
        out.push({ name: label, kind: 'call', to: tel, url: `tel:${tel}` });
      }
      if (c.whatsapp) {
        // wa.me wants digits only, no plus.
        const wa = c.whatsapp.replace(/[^\d]/g, '');
        out.push({ name: label, kind: 'whatsapp', to: wa, url: `https://wa.me/${wa}?text=${encoded}` });
      }
      return out;
    });

    const payload = {
      ...defined(parsed.data),
      user_id: req.user!.id,
      message: parsed.data.message || 'SOS! Rider needs help!',
      sent_to: sentTo,
      created_at: now(),
    };

    const ref = await db.collection(COL.sosEvents).add(payload);

    res.status(201).json({
      id: ref.id,
      ...payload,
      maps_link: mapsLink,
      alert_text: alertText,
      sent_to: sentTo,
      telegram_failed: telegramFailed.length ? telegramFailed[0] : undefined,
      /** Pre-filled links the phone must open — they cannot be sent from the server. */
      channels,
      /** Straight answer for the UI, so it never claims more than happened. */
      auto_sent: sentTo.length > 0,
      needs_tap: channels.filter(c => c.kind !== 'call').length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const events = sortBy(
      await queryAll<any>(db.collection(COL.sosEvents).where('user_id', '==', req.user!.id)),
      'created_at', 'desc'
    ).slice(0, 20);
    res.json(events);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
