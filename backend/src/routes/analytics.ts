import { Router, Response } from 'express';
import { db, COL } from '../config/firebase';
import { requireAuth } from '../middleware/auth';
import { queryAll, getOwned, sortBy } from '../lib/firestore';
import { withStatus, bySeverity, MaintenanceComponent } from '../lib/maintenance';
import { AuthRequest } from '../types';

const router = Router();

/** Inclusive lower bound for a period filter, as a YYYY-MM-DD string. */
function periodStart(period: string, now: Date): string | null {
  if (period === 'year')  return `${now.getFullYear()}-01-01`;
  if (period === 'month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return null; // 'all'
}

/**
 * Full-tank-to-full-tank mileage (spec §10).
 *
 * Only the distance between two full tanks is meaningful: a partial fill leaves an unknown
 * amount in the tank. Litres burned over a stretch are those added at its *end*, so we
 * accumulate fuel from every entry after the opening full tank up to and including the
 * closing one. Absurd figures are dropped rather than shown.
 */
export function computeMileage(entries: any[]): { mileage: number | null; distance: number; litres: number; samples: number } {
  const byOdo = [...entries].sort((a, b) => (a.odometer ?? 0) - (b.odometer ?? 0));

  let distance = 0, litres = 0, samples = 0;
  let openIdx = byOdo.findIndex(e => e.full_tank);

  for (let i = openIdx + 1; i < byOdo.length && openIdx !== -1; i++) {
    if (!byOdo[i].full_tank) continue;

    const d = (byOdo[i].odometer ?? 0) - (byOdo[openIdx].odometer ?? 0);
    // Fuel used across the stretch = everything added after the opening tank.
    let l = 0;
    for (let j = openIdx + 1; j <= i; j++) l += byOdo[j].litres ?? 0;

    if (d > 0 && l > 0) {
      const km = d / l;
      if (km >= 3 && km <= 200) {   // outlier guard: implausible for a motorcycle
        distance += d; litres += l; samples++;
      }
    }
    openIdx = i;
  }

  return {
    mileage: litres > 0 ? +(distance / litres).toFixed(2) : null,
    distance, litres, samples,
  };
}

router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const nowDate = new Date();
  const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).toISOString().split('T')[0];

  try {
    const [bikes, fuel, services, docs, reminders] = await Promise.all([
      queryAll<any>(db.collection(COL.motorcycles).where('user_id', '==', userId)),
      queryAll<any>(db.collection(COL.fuelEntries).where('user_id', '==', userId)),
      queryAll<any>(db.collection(COL.serviceRecords).where('user_id', '==', userId)),
      queryAll<any>(db.collection(COL.documents).where('user_id', '==', userId)),
      queryAll<any>(
        db.collection(COL.reminders)
          .where('user_id', '==', userId)
          .where('is_active', '==', true)
      ),
    ]);

    // Sorted in memory rather than via orderBy, to avoid needing another composite index
    // for a list that is only ever a handful of bikes.
    bikes.sort((a, b) =>
      (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) ||
      String(b.created_at).localeCompare(String(a.created_at))
    );

    const odometers = new Map<string, number>(
      bikes.map(b => [b.id, b.current_odometer ?? 0])
    );

    const totalFuelCost = fuel.reduce((s, f) => s + (f.amount || 0), 0);
    const totalServiceCost = services.reduce((s, sr) => s + (sr.cost || 0), 0);
    const monthFuel = fuel.filter(f => f.date >= startOfMonth).reduce((s, f) => s + (f.amount || 0), 0);
    const monthService = services.filter(s => s.service_date >= startOfMonth).reduce((s, sr) => s + (sr.cost || 0), 0);

    // Expiring docs (within 30 days)
    const expiringDocs = docs.filter(d => {
      if (!d.expiry_date) return false;
      const days = Math.ceil((new Date(d.expiry_date).getTime() - Date.now()) / 86400000);
      return days >= 0 && days <= 30;
    });

    // Due reminders
    const dueReminders = reminders.filter(r => {
      if (r.trigger_type === 'distance' && r.motorcycle_id) {
        const odo = odometers.get(r.motorcycle_id);
        if (odo === undefined) return false;
        const nextKm = (r.last_done_km || 0) + (r.interval_km || r.trigger_km || 0);
        return odo >= nextKm;
      }
      if (r.trigger_type === 'date' && r.trigger_date) {
        return new Date(r.trigger_date) <= nowDate;
      }
      return false;
    });

    res.json({
      bikes,
      total_fuel_cost: totalFuelCost,
      total_service_cost: totalServiceCost,
      month_fuel_cost: monthFuel,
      month_service_cost: monthService,
      expiring_docs: expiringDocs,
      due_reminders_count: dueReminders.length,
      bikes_count: bikes.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Everything the Home screen needs for ONE bike, in a single request (spec §4, §50).
 *
 *   GET /api/analytics/bike/:bikeId?period=month|year|all
 *
 * Costs respect the period; lifetime figures (odometer, mileage, next service) do not,
 * because "total distance this month" is not a thing a rider asks for.
 */
router.get('/bike/:bikeId', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const period = String(req.query.period ?? 'month');
  const nowDate = new Date();
  const from = periodStart(period, nowDate);

  try {
    const bike = await getOwned<any>(COL.motorcycles, req.params.bikeId, userId);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    const scoped = (col: string) =>
      db.collection(col).where('user_id', '==', userId).where('motorcycle_id', '==', req.params.bikeId);

    const [fuel, services, components, docs] = await Promise.all([
      queryAll<any>(scoped(COL.fuelEntries)),
      queryAll<any>(scoped(COL.serviceRecords)),
      queryAll<MaintenanceComponent>(scoped(COL.maintenance)),
      queryAll<any>(scoped(COL.documents)),
    ]);

    const odometer = bike.current_odometer ?? 0;

    // ── Distance and mileage (lifetime) ──────────────────────
    const odos = fuel.map(f => f.odometer ?? 0).filter(n => n > 0);
    const firstLogged = odos.length ? Math.min(...odos) : null;
    const totalDistance = firstLogged != null ? Math.max(0, odometer - firstLogged) : 0;
    const mileage = computeMileage(fuel);

    // ── Costs (respect the period filter) ────────────────────
    const inPeriod = <T extends Record<string, any>>(rows: T[], field: string) =>
      from ? rows.filter(r => String(r[field] ?? '') >= from) : rows;

    const fuelPeriod = inPeriod(fuel, 'date');
    const servicePeriod = inPeriod(services, 'service_date');
    const fuelCost = fuelPeriod.reduce((s, f) => s + (f.amount || 0), 0);
    const serviceCost = servicePeriod.reduce((s, r) => s + (r.cost || 0), 0);

    // ── Service history ──────────────────────────────────────
    const byDate = sortBy(services, 'service_date', 'desc');
    const lastService = byDate[0] ?? null;

    const generalService = components.find(c => c.component_key === 'general_service');
    const nextService = generalService
      ? withStatus(generalService, odometer)
      : null;

    // ── Maintenance ──────────────────────────────────────────
    const live = components.filter(c => c.is_active !== false).map(c => withStatus(c, odometer));
    live.sort(bySeverity);
    const attention = live.filter(c => c.status !== 'healthy' && c.status !== 'unknown');

    // ── Documents expiring ───────────────────────────────────
    const expiring = docs.filter(d => {
      if (!d.expiry_date) return false;
      const days = Math.ceil((new Date(d.expiry_date).getTime() - Date.now()) / 86400000);
      return days <= 30;
    });

    res.json({
      bike: {
        id: bike.id, brand: bike.brand, model: bike.model, year: bike.year ?? null,
        registration_no: bike.registration_no ?? null,
        current_odometer: odometer,
        fuel_capacity: bike.fuel_capacity ?? null,
      },
      distance: { total: totalDistance, current_odometer: odometer, tracked_from: firstLogged },
      mileage: {
        value: mileage.mileage,
        samples: mileage.samples,
        // Tells the UI to say "need another full tank" rather than print a wrong number.
        reliable: mileage.samples >= 1,
      },
      // Estimated range left, from tank size and real mileage — free to compute, useful
      // before a long empty stretch.
      range: bike.fuel_capacity && mileage.mileage
        ? Math.round(bike.fuel_capacity * mileage.mileage)
        : null,
      costs: {
        period,
        fuel: fuelCost,
        service: serviceCost,
        other: 0,
        total: fuelCost + serviceCost,
        fuel_entries: fuelPeriod.length,
        service_entries: servicePeriod.length,
        cost_per_km: totalDistance > 0
          ? +(((fuel.reduce((s, f) => s + (f.amount || 0), 0)) +
               (services.reduce((s, r) => s + (r.cost || 0), 0))) / totalDistance).toFixed(2)
          : null,
      },
      last_service: lastService
        ? { id: lastService.id, date: lastService.service_date, odometer: lastService.odometer,
            workshop: lastService.workshop ?? null, cost: lastService.cost ?? 0 }
        : null,
      next_service: nextService
        ? { due_km: nextService.next_due_km, due_date: nextService.next_due_date,
            km_remaining: nextService.km_remaining, days_remaining: nextService.days_remaining,
            status: nextService.status, status_label: nextService.status_label }
        : null,
      maintenance: {
        attention: attention.slice(0, 6),
        counts: {
          overdue: live.filter(c => c.status === 'overdue').length,
          due: live.filter(c => c.status === 'due').length,
          due_soon: live.filter(c => c.status === 'due_soon').length,
          healthy: live.filter(c => c.status === 'healthy').length,
        },
      },
      expiring_docs: expiring,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/fuel/:bikeId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const entries = sortBy(await queryAll<any>(
      db.collection(COL.fuelEntries)
        .where('user_id', '==', req.user!.id)
        .where('motorcycle_id', '==', req.params.bikeId)
    ), 'date', 'desc');

    const monthly: Record<string, { cost: number; litres: number }> = {};

    entries.forEach(e => {
      const key = String(e.date).substring(0, 7);
      if (!monthly[key]) monthly[key] = { cost: 0, litres: 0 };
      monthly[key].cost += e.amount || 0;
      monthly[key].litres += e.litres || 0;
    });

    res.json({ entries, monthly });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/health/:bikeId', requireAuth, async (req: AuthRequest, res: Response) => {
  const bikeId = req.params.bikeId;
  const userId = req.user!.id;

  try {
    const bike = await getOwned<any>(COL.motorcycles, bikeId, userId);
    if (!bike) { res.status(404).json({ error: 'Bike not found' }); return; }

    const [allServices, allDocs, reminders] = await Promise.all([
      queryAll<any>(
        db.collection(COL.serviceRecords)
          .where('user_id', '==', userId)
          .where('motorcycle_id', '==', bikeId)
      ),
      queryAll<any>(
        db.collection(COL.documents)
          .where('user_id', '==', userId)
          .where('motorcycle_id', '==', bikeId)
      ),
      queryAll<any>(
        db.collection(COL.reminders)
          .where('user_id', '==', userId)
          .where('motorcycle_id', '==', bikeId)
          .where('is_active', '==', true)
      ),
    ]);

    const services = sortBy(allServices, 'service_date', 'desc');
    const docs = allDocs.filter(d => d.doc_type === 'Insurance' || d.doc_type === 'PUC');

    let score = 100;
    const issues: string[] = [];

    const lastService = services[0];
    if (!lastService) { score -= 20; issues.push('No service record found'); }
    else {
      const daysSince = Math.floor((Date.now() - new Date(lastService.service_date).getTime()) / 86400000);
      if (daysSince > 180) { score -= 15; issues.push(`Last service ${daysSince} days ago`); }
    }

    const insuranceDoc = docs.find(d => d.doc_type === 'Insurance');
    if (!insuranceDoc) { score -= 20; issues.push('No insurance document'); }
    else if (insuranceDoc.expiry_date) {
      const days = Math.ceil((new Date(insuranceDoc.expiry_date).getTime() - Date.now()) / 86400000);
      if (days < 0) { score -= 25; issues.push('Insurance expired'); }
      else if (days < 30) { score -= 10; issues.push(`Insurance expiring in ${days} days`); }
    }

    const pucDoc = docs.find(d => d.doc_type === 'PUC');
    if (!pucDoc) { score -= 10; issues.push('No PUC document'); }

    const odo = bike.current_odometer ?? 0;
    const dueCount = reminders.filter(r =>
      r.trigger_type === 'distance' &&
      odo >= (r.last_done_km || 0) + (r.interval_km || 0)
    ).length;

    score -= dueCount * 5;
    if (dueCount > 0) issues.push(`${dueCount} maintenance items due`);

    score = Math.max(0, Math.min(100, score));

    res.json({ score, issues, bike, last_service: lastService || null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
