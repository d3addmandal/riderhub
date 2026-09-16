/**
 * Maintenance status engine.
 *
 * A component becomes due either by distance or by date, and when both intervals are set
 * the earlier one wins. Everything here is a pure function of (component, odometer, today)
 * so it can be unit-tested and gives identical answers on the server and in the UI.
 */

export type MaintenanceStatus = 'healthy' | 'due_soon' | 'due' | 'overdue' | 'unknown';

/** Tunable in one place — the spec calls for these to be configurable. */
export const THRESHOLDS = {
  dueSoonKm: 1000,
  dueSoonDays: 30,
};

export interface MaintenanceComponent {
  id: string;
  user_id: string;
  motorcycle_id: string;
  /** Stable key for built-ins ("engine_oil"); null for rider-defined components. */
  component_key: string | null;
  name: string;
  category: string;
  interval_km?: number | null;
  interval_days?: number | null;
  last_changed_km?: number | null;
  last_changed_date?: string | null;
  /** Explicit overrides. When absent they are derived from last_changed + interval. */
  next_due_km?: number | null;
  next_due_date?: string | null;
  notes?: string | null;
  last_cost?: number | null;
  last_service_id?: string | null;
  is_active?: boolean;
}

export interface MaintenanceComputed {
  status: MaintenanceStatus;
  /** Plain-English state, so colour is never the only signal (spec §7.3, §40). */
  status_label: string;
  next_due_km: number | null;
  next_due_date: string | null;
  km_remaining: number | null;
  days_remaining: number | null;
  /** Which trigger is driving the status — 'distance', 'date' or null. */
  driver: 'distance' | 'date' | null;
  /** 0–1 through the current interval; null when it cannot be worked out. */
  progress: number | null;
}

const DAY = 86400000;

function toDay(iso: string): number {
  // Compare dates at day resolution so "due today" is not decided by clock time.
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return Math.floor(d.getTime() / DAY);
}

function todayIndex(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Worst of two statuses wins — whichever trigger fires first drives the card. */
const SEVERITY: Record<MaintenanceStatus, number> = {
  unknown: 0, healthy: 1, due_soon: 2, due: 3, overdue: 4,
};

const LABELS: Record<MaintenanceStatus, string> = {
  healthy: 'Healthy',
  due_soon: 'Due soon',
  due: 'Due now',
  overdue: 'Overdue',
  unknown: 'Not tracked',
};

function statusFromRemaining(remaining: number, dueSoonAt: number): MaintenanceStatus {
  if (remaining < 0) return 'overdue';
  if (remaining === 0) return 'due';
  if (remaining <= dueSoonAt) return 'due_soon';
  return 'healthy';
}

/**
 * Work out where a component stands right now.
 *
 * @param currentOdometer the bike's live reading
 * @param now injectable for tests
 */
export function computeStatus(
  c: MaintenanceComponent,
  currentOdometer: number,
  now: Date = new Date()
): MaintenanceComputed {
  // Explicit next-due wins; otherwise derive from last-changed plus the interval.
  const nextKm =
    c.next_due_km ??
    (c.interval_km != null && c.last_changed_km != null
      ? c.last_changed_km + c.interval_km
      : c.interval_km != null
        ? c.interval_km            // never changed: first service falls at the interval
        : null);

  const nextDate =
    c.next_due_date ??
    (c.interval_days != null && c.last_changed_date
      ? addDays(c.last_changed_date, c.interval_days)
      : null);

  const kmRemaining = nextKm != null ? nextKm - currentOdometer : null;
  const daysRemaining = nextDate != null ? toDay(nextDate) - todayIndex(now) : null;

  const kmStatus = kmRemaining != null
    ? statusFromRemaining(kmRemaining, THRESHOLDS.dueSoonKm)
    : 'unknown';
  const dateStatus = daysRemaining != null
    ? statusFromRemaining(daysRemaining, THRESHOLDS.dueSoonDays)
    : 'unknown';

  let status: MaintenanceStatus = 'unknown';
  let driver: 'distance' | 'date' | null = null;

  if (kmStatus === 'unknown' && dateStatus === 'unknown') {
    status = 'unknown';
  } else if (SEVERITY[kmStatus] >= SEVERITY[dateStatus]) {
    status = kmStatus;
    driver = 'distance';
  } else {
    status = dateStatus;
    driver = 'date';
  }

  // Progress through the interval that is actually driving the status.
  let progress: number | null = null;
  if (driver === 'distance' && c.interval_km) {
    const used = c.interval_km - (kmRemaining ?? 0);
    progress = Math.max(0, Math.min(1, used / c.interval_km));
  } else if (driver === 'date' && c.interval_days) {
    const used = c.interval_days - (daysRemaining ?? 0);
    progress = Math.max(0, Math.min(1, used / c.interval_days));
  }

  return {
    status,
    status_label: LABELS[status],
    next_due_km: nextKm,
    next_due_date: nextDate,
    km_remaining: kmRemaining,
    days_remaining: daysRemaining,
    driver,
    progress,
  };
}

/** Attach computed fields to a component for the API response. */
export function withStatus(c: MaintenanceComponent, odometer: number, now?: Date) {
  return { ...c, ...computeStatus(c, odometer, now) };
}

/** Sort worst-first, then by whichever is closest to falling due. */
export function bySeverity(
  a: MaintenanceComputed, b: MaintenanceComputed
): number {
  const s = SEVERITY[b.status] - SEVERITY[a.status];
  if (s !== 0) return s;
  const ak = a.km_remaining ?? Number.MAX_SAFE_INTEGER;
  const bk = b.km_remaining ?? Number.MAX_SAFE_INTEGER;
  if (ak !== bk) return ak - bk;
  const ad = a.days_remaining ?? Number.MAX_SAFE_INTEGER;
  const bd = b.days_remaining ?? Number.MAX_SAFE_INTEGER;
  return ad - bd;
}

/**
 * Starter set seeded on a new bike (spec §6). Intervals are typical for a modern
 * single-cylinder motorcycle; riders edit them per machine. `service_keywords` lets a
 * service record match a component by name so maintenance updates itself (spec §25).
 */
export interface ComponentTemplate {
  key: string;
  name: string;
  category: string;
  interval_km?: number;
  interval_days?: number;
  service_keywords: string[];
}

export const DEFAULT_COMPONENTS: ComponentTemplate[] = [
  { key: 'engine_oil',      name: 'Engine Oil',          category: 'Engine',      interval_km: 5000,  interval_days: 180, service_keywords: ['engine oil', 'motor oil', 'oil change'] },
  { key: 'oil_filter',      name: 'Oil Filter',          category: 'Engine',      interval_km: 10000, interval_days: 365, service_keywords: ['oil filter'] },
  { key: 'drain_washer',    name: 'Drain Plug Washer',   category: 'Engine',      interval_km: 5000,                      service_keywords: ['drain plug', 'drain washer', 'crush washer'] },
  { key: 'air_filter',      name: 'Air Filter',          category: 'Engine',      interval_km: 10000, interval_days: 365, service_keywords: ['air filter'] },
  { key: 'spark_plug',      name: 'Spark Plug',          category: 'Engine',      interval_km: 12000, interval_days: 730, service_keywords: ['spark plug', 'plug'] },
  { key: 'valve_clearance', name: 'Valve Clearance',     category: 'Engine',      interval_km: 24000,                     service_keywords: ['valve', 'tappet'] },
  { key: 'coolant',         name: 'Coolant',             category: 'Cooling',     interval_km: 24000, interval_days: 730, service_keywords: ['coolant', 'antifreeze'] },
  { key: 'brake_pad_front', name: 'Front Brake Pads',    category: 'Brakes',      interval_km: 15000,                     service_keywords: ['front brake pad', 'brake pad front'] },
  { key: 'brake_pad_rear',  name: 'Rear Brake Pads',     category: 'Brakes',      interval_km: 20000,                     service_keywords: ['rear brake pad', 'brake pad rear'] },
  { key: 'brake_fluid',     name: 'Brake Fluid',         category: 'Brakes',      interval_km: 20000, interval_days: 730, service_keywords: ['brake fluid', 'brake oil'] },
  { key: 'chain_lube',      name: 'Chain Lubrication',   category: 'Drivetrain',  interval_km: 500,                       service_keywords: ['chain lube', 'chain lubrication'] },
  { key: 'chain_clean',     name: 'Chain Cleaning',      category: 'Drivetrain',  interval_km: 1000,                      service_keywords: ['chain clean', 'chain cleaning'] },
  { key: 'chain_sprocket',  name: 'Chain & Sprockets',   category: 'Drivetrain',  interval_km: 25000,                     service_keywords: ['chain', 'sprocket', 'chain sprocket kit'] },
  { key: 'clutch',          name: 'Clutch Cable / Fluid',category: 'Drivetrain',  interval_km: 20000,                     service_keywords: ['clutch cable', 'clutch fluid', 'clutch plate'] },
  { key: 'tyre_front',      name: 'Front Tyre',          category: 'Tyres',       interval_km: 25000,                     service_keywords: ['front tyre', 'front tire'] },
  { key: 'tyre_rear',       name: 'Rear Tyre',           category: 'Tyres',       interval_km: 18000,                     service_keywords: ['rear tyre', 'rear tire'] },
  { key: 'fork_oil',        name: 'Fork Oil',            category: 'Suspension',  interval_km: 30000,                     service_keywords: ['fork oil', 'suspension oil'] },
  { key: 'battery',         name: 'Battery',             category: 'Electrical',  interval_days: 1095,                    service_keywords: ['battery'] },
  { key: 'throttle_cable',  name: 'Throttle Cable',      category: 'Controls',    interval_km: 20000,                     service_keywords: ['throttle cable', 'accelerator cable'] },
  { key: 'general_service', name: 'General Service',     category: 'Service',     interval_km: 5000,  interval_days: 180, service_keywords: ['general service', 'full service', 'periodic service'] },
];

/**
 * Match a replaced-part name from a service record to a seeded component.
 * Longest keyword wins so "oil filter" is not swallowed by "engine oil".
 */
export function matchComponentKey(partName: string): string | null {
  const needle = partName.toLowerCase().trim();
  if (!needle) return null;

  let best: { key: string; len: number } | null = null;
  for (const t of DEFAULT_COMPONENTS) {
    for (const kw of t.service_keywords) {
      if (needle.includes(kw) && (!best || kw.length > best.len)) {
        best = { key: t.key, len: kw.length };
      }
    }
  }
  return best?.key ?? null;
}
