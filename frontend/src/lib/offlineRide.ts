import { Ride, Poi } from '../types';
import { RouteResult } from './routeTypes';

/**
 * Everything a ride needs to be navigable with no network.
 *
 * What this deliberately does NOT contain is map tiles. Google's terms forbid
 * pre-fetching, caching or storing tile imagery, so bulk-downloading the map is not
 * something this app can legitimately do. What it can do — and what actually keeps a
 * rider on course — is store the route geometry, every turn instruction, the stops and
 * the useful places, then drive all of it from GPS. Losing signal costs you the street
 * imagery underneath; it does not cost you the navigation.
 */
export interface RidePack {
  rideId: string;
  savedAt: string;
  ride: Ride;
  route: RouteResult | null;
  /** Petrol pumps and other places found along the route before setting off. */
  pois: Poi[];
  /** Bounding box of the route, so the offline canvas can frame it. */
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  sizeBytes: number;
}

/** A GPS fix waiting to reach the server. */
export interface QueuedFix {
  rideId: string;
  lat: number;
  lng: number;
  t: string;
  speed: number | null;
  accuracy: number | null;
  heading: number | null;
}

const DB_NAME = 'riderhub-offline';
const DB_VERSION = 1;
const PACKS = 'packs';
const QUEUE = 'trackQueue';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PACKS)) {
        db.createObjectStore(PACKS, { keyPath: 'rideId' });
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        // autoIncrement so fixes keep their arrival order across restarts.
        const q = db.createObjectStore(QUEUE, { keyPath: 'seq', autoIncrement: true });
        q.createIndex('rideId', 'rideId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open offline storage'));
  });

  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Offline storage write failed'));
  }));
}

// ── Ride packs ────────────────────────────────────────────────
export async function savePack(pack: Omit<RidePack, 'sizeBytes' | 'savedAt'>): Promise<RidePack> {
  const bounds = boundsOf(pack.route);
  const full: RidePack = {
    ...pack,
    bounds,
    savedAt: new Date().toISOString(),
    sizeBytes: 0,
  };
  full.sizeBytes = new Blob([JSON.stringify(full)]).size;
  await tx(PACKS, 'readwrite', s => s.put(full));
  return full;
}

export function loadPack(rideId: string): Promise<RidePack | undefined> {
  return tx<RidePack | undefined>(PACKS, 'readonly', s => s.get(rideId));
}

export function allPacks(): Promise<RidePack[]> {
  return tx<RidePack[]>(PACKS, 'readonly', s => s.getAll());
}

export function deletePack(rideId: string): Promise<void> {
  return tx<undefined>(PACKS, 'readwrite', s => s.delete(rideId)).then(() => undefined);
}

/**
 * Drop the offline copy of a finished ride.
 *
 * A completed ride is dead weight: nobody navigates it again, and its route and pumps
 * are by far the largest thing stored. Clearing it as the ride ends is what stops a
 * season of riding from quietly filling the phone.
 *
 * The GPS queue is treated separately and far more carefully. Fixes still sitting there
 * are ones the server has never seen, so deleting them loses a piece of the ride for
 * good. They are only discarded when the caller can say that is safe — because the
 * upload succeeded, or because the ride no longer exists to upload to.
 */
export async function releaseRide(
  rideId: string,
  { discardQueue = false }: { discardQueue?: boolean } = {},
): Promise<{ keptFixes: number }> {
  await deletePack(rideId);

  try {
    const left = await queuedFixes(rideId);
    if (!discardQueue) return { keptFixes: left.length };
    await dropFixes(left.map(f => f.seq));
    return { keptFixes: 0 };
  } catch {
    return { keptFixes: 0 };   // storage gone; nothing to preserve
  }
}

/**
 * Sweep away packs for rides that are over, or that no longer exist.
 *
 * Covers what a single screen cannot: a ride finished on another device, or one deleted
 * entirely while this phone was offline. A ride the server no longer has takes its
 * unsent fixes with it — there is nowhere left to send them — but a merely finished ride
 * keeps its queue until it has actually been uploaded.
 */
export async function pruneFinishedPacks(
  classify: (rideId: string) => 'finished' | 'gone' | 'keep',
): Promise<string[]> {
  const packs = await allPacks();
  const removed: string[] = [];
  for (const p of packs) {
    const verdict = classify(p.rideId);
    if (verdict === 'keep') continue;
    await releaseRide(p.rideId, { discardQueue: verdict === 'gone' });
    removed.push(p.rideId);
  }
  return removed;
}

function boundsOf(route: RouteResult | null) {
  const pts = route?.geometry ?? [];
  if (!pts.length) return null;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [lng, lat] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat >maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng >maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// ── GPS queue that survives a restart ─────────────────────────
/**
 * The in-memory buffer loses everything if the browser is killed mid-ride — which on a
 * phone in a tank bag is not a rare event. Fixes go here first and are only dropped once
 * the server has them.
 */
export function queueFixes(fixes: QueuedFix[]): Promise<void> {
  if (!fixes.length) return Promise.resolve();
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(QUEUE, 'readwrite');
    const store = t.objectStore(QUEUE);
    fixes.forEach(f => store.add(f));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('Could not queue GPS fixes'));
  }));
}

export function queuedFixes(rideId: string): Promise<(QueuedFix & { seq: number })[]> {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(QUEUE, 'readonly');
    const req = t.objectStore(QUEUE).index('rideId').getAll(rideId);
    req.onsuccess = () => resolve(req.result as (QueuedFix & { seq: number })[]);
    req.onerror = () => reject(req.error ?? new Error('Could not read the GPS queue'));
  }));
}

export function dropFixes(seqs: number[]): Promise<void> {
  if (!seqs.length) return Promise.resolve();
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(QUEUE, 'readwrite');
    const store = t.objectStore(QUEUE);
    seqs.forEach(s => store.delete(s));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('Could not clear the GPS queue'));
  }));
}

/** Roughly how much room the browser will give us, for an honest size warning. */
export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usage: e?.usage ?? null, quota: e?.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

/**
 * Ask the browser not to evict our data under storage pressure.
 * Best-effort — a decline is not an error worth showing.
 */
export async function persistStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
