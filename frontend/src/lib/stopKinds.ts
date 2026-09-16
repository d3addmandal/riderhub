import { StopKind, PoiKind, RouteMode } from '../types';

/**
 * The three route profiles as the rider sees them.
 *
 * Worth being straight about: only `bike` changes which roads Google will route over —
 * its two-wheeler engine knows the expressways and bridges that bar them. `general` and
 * `car` share the driving engine and differ in what they avoid.
 */
export const ROUTE_MODE_META: Record<RouteMode, { label: string; icon: string; hint: string }> = {
  general: { label: 'General', icon: '',   hint: 'Fastest road, whatever the vehicle' },
  bike:    { label: 'Bike',    icon: '🏍️', hint: 'Skips roads that bar two-wheelers' },
  car:     { label: 'Car',     icon: '',  hint: 'Car routing, tolls and highways allowed' },
};

/**
 * The vocabulary of stops, in the order a rider thinks about them.
 *
 * `suggests` is what makes a kind more than a label: a night stop offers to find beds, a
 * meal stop offers food, a fuel stop offers pumps. One place to change it, everywhere.
 */
export const STOP_KIND_META: Record<StopKind, {
  label: string;
  icon: string;
  /** Typical minutes there, offered as the default when the stop is created. */
  minutes: number;
  /** What to search for nearby, if anything. */
  suggests?: PoiKind;
  /** Tailwind text colour for the badge. */
  tone: string;
}> = {
  break:       { label: 'Short break', icon: '', minutes: 15,  tone: 'text-sky-300' },
  breakfast:   { label: 'Breakfast',   icon: '', minutes: 40,  suggests: 'food',    tone: 'text-amber-300' },
  snacks:      { label: 'Snacks',      icon: '', minutes: 20,  suggests: 'food',    tone: 'text-amber-300' },
  lunch:       { label: 'Lunch',       icon: '', minutes: 60,  suggests: 'food',    tone: 'text-amber-300' },
  dinner:      { label: 'Dinner',      icon: '', minutes: 60,  suggests: 'food',    tone: 'text-amber-300' },
  night:       { label: 'Night stop',  icon: '', minutes: 600, suggests: 'lodging', tone: 'text-indigo-300' },
  fuel:        { label: 'Fuel',        icon: '', minutes: 10,  suggests: 'fuel',    tone: 'text-green-300' },
  sightseeing: { label: 'Sightseeing', icon: '', minutes: 45,  tone: 'text-pink-300' },
  other:       { label: 'Other',       icon: '', minutes: 15,  tone: 'text-muted' },
};

/** The order the chips appear in — the rider's day, roughly in sequence. */
export const STOP_KIND_ORDER: StopKind[] = [
  'break', 'fuel', 'breakfast', 'snacks', 'lunch', 'dinner', 'night', 'sightseeing', 'other',
];

export const POI_KIND_META: Record<PoiKind, { label: string; icon: string; plural: string }> = {
  fuel:     { label: 'Petrol pump', icon: '', plural: 'Petrol pumps' },
  lodging:  { label: 'Stay',        icon: '', plural: 'Hotels & hostels' },
  food:     { label: 'Food',        icon: '', plural: 'Places to eat' },
  mechanic: { label: 'Mechanic',    icon: '', plural: 'Mechanics' },
  atm:      { label: 'ATM',         icon: '', plural: 'ATMs' },
  hospital: { label: 'Hospital',    icon: '', plural: 'Hospitals' },
};

export function stopMeta(kind?: StopKind | null) {
  return STOP_KIND_META[kind ?? 'break'] ?? STOP_KIND_META.other;
}

/** Total planned time off the bike, in minutes. */
export function plannedStopMinutes(stops: { kind?: StopKind; planned_minutes?: number | null }[]) {
  return stops.reduce((t, s) => t + (s.planned_minutes ?? stopMeta(s.kind).minutes), 0);
}
