import { db, COL } from '../config/firebase';
import { queryAll, now } from './firestore';
import { DEFAULT_COMPONENTS, MaintenanceComponent } from './maintenance';

/**
 * Guarantee a bike has its maintenance components.
 *
 * Called from bike creation, from the maintenance screen, and from the service route —
 * because a rider can reach any of those first. Without this, logging a service on a
 * brand-new bike silently failed to reset anything: there were no components to reset.
 *
 * Idempotent: only the missing built-ins are added, so rider edits and deletions survive.
 */
export async function ensureComponents(
  bikeId: string,
  userId: string,
  odometer: number
): Promise<MaintenanceComponent[]> {
  const existing = await queryAll<MaintenanceComponent>(
    db.collection(COL.maintenance)
      .where('user_id', '==', userId)
      .where('motorcycle_id', '==', bikeId)
  );

  // Only seed a bike that has never been seeded. Once the rider owns the list, respect it.
  if (existing.length) return existing;

  const batch = db.batch();
  const created: MaintenanceComponent[] = [];

  for (const t of DEFAULT_COMPONENTS) {
    const ref = db.collection(COL.maintenance).doc();
    const doc = {
      user_id: userId,
      motorcycle_id: bikeId,
      component_key: t.key,
      name: t.name,
      category: t.category,
      interval_km: t.interval_km ?? null,
      interval_days: t.interval_days ?? null,
      // Start the clock at the current reading so nothing reads as instantly overdue.
      last_changed_km: odometer,
      last_changed_date: null,
      next_due_km: t.interval_km ? odometer + t.interval_km : null,
      next_due_date: null,
      notes: null,
      last_cost: null,
      last_service_id: null,
      is_active: true,
      created_at: now(),
      updated_at: now(),
    };
    batch.set(ref, doc);
    created.push({ id: ref.id, ...doc } as MaintenanceComponent);
  }

  await batch.commit();
  return created;
}
