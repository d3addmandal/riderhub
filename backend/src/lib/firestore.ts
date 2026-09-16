import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  Query,
} from 'firebase-admin/firestore';
import { db, COL } from '../config/firebase';

/**
 * Sort helpers.
 *
 * Every list query in this API filters by `user_id` with equality only and sorts here,
 * in memory. That is deliberate: equality-only queries are served by Firestore's
 * automatic single-field indexes, so the app needs **no composite indexes deployed** and
 * cannot break because someone skipped `firebase deploy`. A rider's history is tens to
 * hundreds of documents, so the sort is free. Revisit only if a single rider ever holds
 * tens of thousands of records.
 */
export function sortBy<T>(rows: T[], key: keyof T | ((r: T) => any), dir: 'asc' | 'desc' = 'asc'): T[] {
  const get = typeof key === 'function' ? key : (r: T) => r[key];
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // missing values sink, whichever direction
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}

/** Flatten a snapshot into `{ id, ...fields }` — the shape the frontend already expects. */
export function docData<T = any>(snap: DocumentSnapshot | QueryDocumentSnapshot): T {
  return { id: snap.id, ...snap.data() } as T;
}

export async function queryAll<T = any>(query: Query): Promise<T[]> {
  const snap = await query.get();
  return snap.docs.map(d => docData<T>(d));
}

/**
 * Fetch a document and confirm it belongs to `userId`.
 * Returns null when missing or owned by someone else — callers treat both as 404.
 */
export async function getOwned<T = any>(
  collection: string,
  id: string,
  userId: string
): Promise<T | null> {
  const snap = await db.collection(collection).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.user_id !== userId) return null;
  return { id: snap.id, ...data } as T;
}

/** Delete a document only if the caller owns it. Returns false when it was not theirs. */
export async function deleteOwned(
  collection: string,
  id: string,
  userId: string
): Promise<boolean> {
  const ref = db.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.user_id !== userId) return false;
  await ref.delete();
  return true;
}

export interface BikeSummary {
  brand: string;
  model: string;
  current_odometer: number;
}

/**
 * Firestore has no joins, but the UI expects a `motorcycles` sub-object on fuel, service,
 * document and reminder rows. Load the rider's bikes once — there are only ever a
 * handful — and hydrate in memory.
 */
export async function bikeMap(userId: string): Promise<Map<string, BikeSummary>> {
  const snap = await db
    .collection(COL.motorcycles)
    .where('user_id', '==', userId)
    .get();

  const map = new Map<string, BikeSummary>();
  snap.docs.forEach(d => {
    const b = d.data();
    map.set(d.id, {
      brand: b.brand,
      model: b.model,
      current_odometer: b.current_odometer ?? 0,
    });
  });
  return map;
}

/** Attach the `motorcycles` sub-object the frontend renders, mirroring the old SQL join. */
export function withBike<T extends { motorcycle_id?: string }>(
  row: T,
  bikes: Map<string, BikeSummary>
): T & { motorcycles?: BikeSummary } {
  if (!row.motorcycle_id) return row;
  const bike = bikes.get(row.motorcycle_id);
  return bike ? { ...row, motorcycles: bike } : row;
}

/**
 * Raise a bike's odometer to `odometer`, but never lower it — a back-dated or mistyped
 * fuel/service entry must not rewind the reading.
 */
export async function bumpOdometer(
  motorcycleId: string,
  userId: string,
  odometer: number
): Promise<void> {
  const ref = db.collection(COL.motorcycles).doc(motorcycleId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const bike = snap.data()!;
    if (bike.user_id !== userId) return;
    if ((bike.current_odometer ?? 0) >= odometer) return;
    tx.update(ref, {
      current_odometer: odometer,
      updated_at: new Date().toISOString(),
    });
  });
}

/** ISO timestamp — kept as a string so existing frontend date comparisons keep working. */
export function now(): string {
  return new Date().toISOString();
}

/** Strip undefined values so Firestore writes stay clean on partial updates. */
export function defined<T extends Record<string, any>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}
