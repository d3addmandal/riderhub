/**
 * Someone to reach when things go wrong.
 *
 * `phone` is dialled and texted; `whatsapp` is separate because many riders carry a
 * different number there, and sending to the wrong one only shows up when it matters.
 */
export interface EmergencyContact {
  name?: string;
  phone?: string;
  whatsapp?: string;
}

export interface Profile {
  id: string;
  name: string;
  phone?: string;
  city?: string;
  country?: string;
  blood_group?: string;
  medical_notes?: string;
  avatar_url?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  /** Up to two contacts. Supersedes the single pair above. */
  emergency_contacts?: EmergencyContact[];
  telegram_chat_id?: string;
  created_at: string;
}

export interface Motorcycle {
  id: string;
  user_id: string;
  brand: string;
  model: string;
  variant?: string;
  year?: number;
  registration_no?: string;
  engine_no?: string;
  chassis_no?: string;
  purchase_date?: string;
  current_odometer: number;
  fuel_capacity?: number;
  engine_oil_type?: string;
  tyre_size?: string;
  battery_model?: string;
  color?: string;
  avatar_url?: string;
  is_primary: boolean;
  created_at: string;
}

export interface RideGroup {
  id: string;
  name: string;
  owner_id: string;
  invite_code: string;
  destination_name?: string;
  destination_lat?: number;
  destination_lng?: number;
  status: 'active' | 'ended';
  created_at: string;
}

export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  color_code: string;
  role: 'admin' | 'member';
  joined_at: string;
  profiles?: { name: string; avatar_url?: string; blood_group?: string };
}

export interface FuelEntry {
  id: string;
  motorcycle_id: string;
  user_id: string;
  date: string;
  odometer: number;
  litres: number;
  amount: number;
  price_per_l?: number;
  station?: string;
  fuel_type: string;
  full_tank: boolean;
  notes?: string;
  motorcycles?: { brand: string; model: string };
}

export interface ServicePart {
  id?: string;
  service_id?: string;
  part_name: string;
  brand?: string;
  cost: number;
  quantity: number;
}

export interface ServiceRecord {
  id: string;
  motorcycle_id: string;
  user_id: string;
  service_date: string;
  odometer: number;
  workshop?: string;
  cost: number;
  service_type?: string;
  notes?: string;
  invoice_url?: string;
  service_parts?: ServicePart[];
  motorcycles?: { brand: string; model: string };
}

/**
 * Paperwork the rider tracks the *expiry* of. No file is stored — see the note in
 * backend/src/routes/documents.ts.
 */
export interface Document {
  id: string;
  motorcycle_id?: string;
  user_id: string;
  doc_type: 'RC' | 'Insurance' | 'PUC' | 'Driving License' | 'Service Invoice' | 'Purchase Invoice' | 'Other';
  title: string;
  issuer?: string;
  policy_number?: string;
  issue_date?: string;
  expiry_date?: string;
  notes?: string;
  motorcycles?: { brand: string; model: string };
}

export interface Reminder {
  id: string;
  motorcycle_id: string;
  user_id: string;
  reminder_type: string;
  trigger_type: 'distance' | 'date';
  trigger_km?: number;
  trigger_date?: string;
  interval_km?: number;
  interval_days?: number;
  last_done_km?: number;
  last_done_date?: string;
  is_active: boolean;
  notify_telegram: boolean;
  notify_email: boolean;
  motorcycles?: { brand: string; model: string; current_odometer: number };
  isDue?: boolean;
  kmRemaining?: number | null;
  daysRemaining?: number | null;
}

// ── Maintenance (spec §7) ──────────────────────────────────────
export type MaintenanceStatus = 'healthy' | 'due_soon' | 'due' | 'overdue' | 'unknown';

export interface MaintenanceItem {
  id: string;
  motorcycle_id: string;
  component_key: string | null;
  name: string;
  category: string;
  interval_km?: number | null;
  interval_days?: number | null;
  last_changed_km?: number | null;
  last_changed_date?: string | null;
  next_due_km: number | null;
  next_due_date: string | null;
  km_remaining: number | null;
  days_remaining: number | null;
  status: MaintenanceStatus;
  status_label: string;
  driver: 'distance' | 'date' | null;
  progress: number | null;
  notes?: string | null;
  last_cost?: number | null;
}

export interface MaintenanceResponse {
  bike: { id: string; brand: string; model: string; current_odometer: number };
  components: MaintenanceItem[];
  summary: Record<'overdue' | 'due' | 'due_soon' | 'healthy' | 'unknown', number>;
}

/** Everything the Home screen needs for one bike (spec §4). */
export interface BikeDashboard {
  bike: {
    id: string; brand: string; model: string; year: number | null;
    registration_no: string | null; current_odometer: number; fuel_capacity: number | null;
  };
  distance: { total: number; current_odometer: number; tracked_from: number | null };
  mileage: { value: number | null; samples: number; reliable: boolean };
  range: number | null;
  costs: {
    period: string; fuel: number; service: number; other: number; total: number;
    fuel_entries: number; service_entries: number; cost_per_km: number | null;
  };
  last_service: { id: string; date: string; odometer: number; workshop: string | null; cost: number } | null;
  next_service: {
    due_km: number | null; due_date: string | null;
    km_remaining: number | null; days_remaining: number | null;
    status: MaintenanceStatus; status_label: string;
  } | null;
  maintenance: {
    attention: MaintenanceItem[];
    counts: Record<'overdue' | 'due' | 'due_soon' | 'healthy', number>;
  };
  expiring_docs: Document[];
}

// ── Rides (spec §11–§13) ───────────────────────────────────────
export type RideType = 'solo' | 'duo' | 'group';
export type RideStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';

/** What a stop is for — drives what the app offers when you get there. */
export type StopKind =
  | 'break' | 'breakfast' | 'snacks' | 'lunch' | 'dinner' | 'night' | 'fuel' | 'sightseeing' | 'other';

export interface RidePoint {
  name: string;
  lat?: number | null;
  lng?: number | null;
  kind?: StopKind;
  planned_minutes?: number | null;
}

export interface RideStop extends RidePoint {
  id: string;
  order: number;
  reached_at: string | null;
}

/** A place found near the route — a pump, a bed, a plate of food. */
export interface Poi {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: PoiKind;
  /** Metres off the route — how far the detour costs you. */
  detour_m: number;
  rating?: number | null;
  open_now?: boolean | null;
  provider: 'google' | 'photon';
}

export type PoiKind = 'fuel' | 'lodging' | 'food' | 'mechanic' | 'atm' | 'hospital';

/**
 * Which vehicle the route is planned for.
 *
 * Only `bike` changes which roads are eligible — Google's two-wheeler engine knows the
 * expressways and bridges that bar them. `general` and `car` share the driving engine.
 */
export type RouteMode = 'general' | 'bike' | 'car';

export interface PlaceReview {
  author: string;
  author_photo: string | null;
  rating: number | null;
  text: string;
  relative_time: string | null;
}

/** The full card for one place — what a rider reads before committing to a detour. */
export interface PlaceDetail {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  rating_count: number | null;
  price_level: string | null;
  open_now: boolean | null;
  hours: string[];
  phone: string | null;
  website: string | null;
  /** The vendor's own page on Google. */
  google_maps_url: string | null;
  summary: string | null;
  types: string[];
  /** Paths on our API, not Google URLs — fetch them through `api.blobUrl`. */
  photos: string[];
  reviews: PlaceReview[];
  provider: 'google';
}

/** One entry in a ride's notebook, optionally pinned to where it was written. */
export interface RideNote {
  id: string;
  text: string;
  lat?: number | null;
  lng?: number | null;
  created_at: string;
  updated_at?: string | null;
}

/** Someone riding along, and where they were last seen. */
export interface RideMember {
  user_id: string;
  name: string;
  bike_name?: string | null;
  start_location?: RidePoint | null;
  /** Their dot on the map. The leader is always the accent orange. */
  colour: string;
  is_owner: boolean;
  is_you?: boolean;
  joined_at?: string | null;
  last_position?: { lat: number; lng: number; t: string; speed: number | null } | null;
}

/** A live position for someone else on the ride. */
export interface LiveRider {
  user_id: string;
  name: string;
  colour: string;
  lat: number;
  lng: number;
  t: string;
  speed?: number | null;
  heading?: number | null;
}

/** What a code resolves to, before committing to join. */
export interface RideLookup {
  id: string;
  name: string;
  ride_type: RideType;
  status: RideStatus;
  planned_date?: string | null;
  destination?: RidePoint | null;
  start_location?: RidePoint | null;
  owner_name: string;
  member_count: number;
  already_joined: boolean;
  is_owner: boolean;
  joinable: boolean;
}

export interface Ride {
  id: string;
  user_id: string;
  motorcycle_id: string;
  bike_name?: string | null;
  name: string;
  ride_type: RideType;
  status: RideStatus;
  planned_date?: string | null;
  start_location?: RidePoint | null;
  destination?: RidePoint | null;
  stops: RideStop[];
  stops_count?: number;
  start_odometer: number | null;
  end_odometer: number | null;
  started_at: string | null;
  ended_at: string | null;
  paused_ms?: number;
  distance_km: number | null;
  planned_distance?: number | null;
  duration_ms?: number | null;
  avg_speed?: number | null;
  max_speed?: number | null;
  mileage?: number | null;
  fuel_litres?: number | null;
  fuel_cost?: number | null;
  other_cost?: number | null;
  total_cost?: number;
  /** Fill-ups logged against this ride — they drive its fuel cost and mileage. */
  fuel_entries?: FuelEntry[];
  fuel_from_entries?: { litres: number; cost: number; count: number };
  current_odometer?: number | null;
  /** The single free-text note captured when the ride was planned or finished. */
  notes?: string | null;
  /** The ride's notebook — timestamped entries added any time, including afterwards. */
  ride_notes?: RideNote[];
  notes_count?: number;
  /** False when this ride belongs to someone else and was joined. */
  is_owner?: boolean;
  member_count?: number;
  members?: RideMember[];
  invite_code?: string;
  member_ids?: string[];
}

export interface RiderLocation {
  userId: string;
  name: string;
  color: string;
  lat: number;
  lng: number;
  speed?: number;
  heading?: number;
  battery?: number;
  status: 'online' | 'idle' | 'moving' | 'offline';
  timestamp: string;
}

export interface GroupMessage {
  userId: string;
  name: string;
  color: string;
  text: string;
  timestamp: string;
}

export interface DashboardStats {
  bikes: Motorcycle[];
  total_fuel_cost: number;
  total_service_cost: number;
  month_fuel_cost: number;
  month_service_cost: number;
  expiring_docs: Document[];
  due_reminders_count: number;
  bikes_count: number;
}

export interface HealthScore {
  score: number;
  issues: string[];
  bike: Motorcycle;
  last_service: ServiceRecord | null;
}
