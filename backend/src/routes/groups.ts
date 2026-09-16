import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { docData, queryAll, now, sortBy } from '../lib/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthRequest } from '../types';

const router = Router();

const COLORS = ['#FF4444','#4488FF','#44BB44','#FF8800','#AA44FF','#FF44AA','#00AAFF','#FFCC00','#00CCAA','#FF6644'];

function generateInviteCode(): string {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/** Members live at rideGroups/{groupId}/members/{uid} — one doc per rider, uid as the key. */
function memberRef(groupId: string, userId: string) {
  return db.collection(COL.rideGroups).doc(groupId).collection(COL.members).doc(userId);
}

async function isMember(groupId: string, userId: string): Promise<boolean> {
  const snap = await memberRef(groupId, userId).get();
  return snap.exists;
}

/**
 * Rides the caller belongs to.
 *
 * Each group carries a `member_ids` array alongside its members subcollection. An
 * `array-contains` filter is served by Firestore's automatic single-field index, so this
 * needs no deployed index — unlike the collection-group query it replaces.
 * Response keeps the `{ group_id, ride_groups, color_code, … }` shape the UI reads.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const groups = await queryAll<any>(
      db.collection(COL.rideGroups).where('member_ids', 'array-contains', req.user!.id)
    );

    if (!groups.length) { res.json([]); return; }

    // Pull the caller's own membership row from each group for colour and role.
    const memberSnaps = await db.getAll(
      ...groups.map(g => memberRef(g.id, req.user!.id))
    );
    const mine = new Map(
      memberSnaps.filter(s => s.exists).map(s => [s.ref.parent.parent!.id, s.data()!])
    );

    const rows = groups.map(group => {
      const m = mine.get(group.id);
      return {
        group_id: group.id,
        ride_groups: group,
        color_code: m?.color_code ?? '#FF4444',
        role: m?.role ?? 'member',
        joined_at: m?.joined_at ?? group.created_at,
      };
    });

    res.json(sortBy(rows, 'joined_at', 'desc'));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** A single ride. The live map calls this on load and on refresh. */
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!(await isMember(req.params.id, req.user!.id))) {
      res.status(404).json({ error: 'Ride not found' });
      return;
    }
    const snap = await db.collection(COL.rideGroups).doc(req.params.id).get();
    if (!snap.exists) { res.status(404).json({ error: 'Ride not found' }); return; }
    res.json(docData(snap));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ name: z.string().min(1).max(100) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const group = {
      name: parsed.data.name,
      owner_id: req.user!.id,
      invite_code: generateInviteCode(),
      status: 'active' as const,
      // Mirrors the members subcollection so "my rides" needs no composite index.
      member_ids: [req.user!.id],
      created_at: now(),
    };

    const groupRef = db.collection(COL.rideGroups).doc();
    const batch = db.batch();

    batch.set(groupRef, group);
    batch.set(memberRef(groupRef.id, req.user!.id), {
      group_id: groupRef.id,
      user_id: req.user!.id,
      color_code: COLORS[0],
      role: 'admin',
      joined_at: now(),
    });

    await batch.commit();

    res.status(201).json({ id: groupRef.id, ...group });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/join/:code', requireAuth, async (req: AuthRequest, res: Response) => {
  const code = req.params.code.toUpperCase();

  try {
    const found = await db
      .collection(COL.rideGroups)
      .where('invite_code', '==', code)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (found.empty) { res.status(404).json({ error: 'Group not found or inactive' }); return; }

    const group = docData(found.docs[0]);

    if (await isMember(group.id, req.user!.id)) {
      res.json({ group, alreadyMember: true });
      return;
    }

    const members = await db
      .collection(COL.rideGroups).doc(group.id)
      .collection(COL.members).get();

    const usedColors = new Set(members.docs.map(m => m.data().color_code));
    const color = COLORS.find(c => !usedColors.has(c))
      || COLORS[Math.floor(Math.random() * COLORS.length)];

    const batch = db.batch();
    batch.set(memberRef(group.id, req.user!.id), {
      group_id: group.id,
      user_id: req.user!.id,
      color_code: color,
      role: 'member',
      joined_at: now(),
    });
    batch.update(db.collection(COL.rideGroups).doc(group.id), {
      member_ids: FieldValue.arrayUnion(req.user!.id),
    });
    await batch.commit();

    res.json({ group, alreadyMember: false });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!(await isMember(req.params.id, req.user!.id))) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const snap = await db
      .collection(COL.rideGroups).doc(req.params.id)
      .collection(COL.members).get();

    if (snap.empty) { res.json([]); return; }

    // Hydrate the rider details the old `profiles(...)` join provided.
    const profileRefs = snap.docs.map(m => db.collection(COL.profiles).doc(m.id));
    const profileSnaps = await db.getAll(...profileRefs);
    const profiles = new Map(
      profileSnaps.filter(p => p.exists).map(p => [p.id, p.data()!])
    );

    const members = snap.docs.map(m => {
      const p = profiles.get(m.id);
      return {
        id: m.id,
        ...m.data(),
        profiles: p
          ? { name: p.name, avatar_url: p.avatar_url, blood_group: p.blood_group }
          : undefined,
      };
    });

    res.json(members);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/destination', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    destination_name: z.string(),
    destination_lat: z.number(),
    destination_lng: z.number(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    if (!(await isMember(req.params.id, req.user!.id))) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const ref = db.collection(COL.rideGroups).doc(req.params.id);
    await ref.update(parsed.data);

    const saved = await ref.get();
    res.json(docData(saved));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/end', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ref = db.collection(COL.rideGroups).doc(req.params.id);
    const snap = await ref.get();

    if (!snap.exists || snap.data()!.owner_id !== req.user!.id) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    await ref.update({ status: 'ended', ended_at: now() });

    const saved = await ref.get();
    res.json(docData(saved));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/leave', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const batch = db.batch();
    batch.delete(memberRef(req.params.id, req.user!.id));
    batch.update(db.collection(COL.rideGroups).doc(req.params.id), {
      member_ids: FieldValue.arrayRemove(req.user!.id),
    });
    await batch.commit();
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
