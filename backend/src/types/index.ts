import { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

// @types/express v5 widens route params to `string | string[]`. Every route here uses
// plain `/:id` segments, so pin them to string rather than narrowing at each use site.
export interface AuthRequest extends Request<Record<string, string>> {
  user?: AuthUser;
}


export interface Motorcycle {
  id: string;
  user_id: string;
  brand: string;
  model: string;
  variant?: string;
  year?: number;
  registration_no?: string;
  current_odometer: number;
  fuel_capacity?: number;
  is_primary: boolean;
}

export interface FuelEntry {
  id: string;
  motorcycle_id: string;
  user_id: string;
  date: string;
  odometer: number;
  litres: number;
  amount: number;
  station?: string;
  fuel_type: string;
}

export interface ServiceRecord {
  id: string;
  motorcycle_id: string;
  user_id: string;
  service_date: string;
  odometer: number;
  workshop?: string;
  cost: number;
  notes?: string;
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
}
