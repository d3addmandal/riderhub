/**
 * The shape the routing service returns.
 *
 * Lives in its own module because both the live map and the offline store need it, and
 * neither should have to import the other.
 */

export interface RouteStep {
  instruction: string;
  distance_m: number;
  duration_s: number;
  end: { lat: number; lng: number } | null;
  maneuver: string | null;
}

export interface RouteLeg {
  distance_m: number;
  duration_s: number;
  /** [lng, lat] pairs, GeoJSON order. */
  geometry: [number, number][];
  steps: RouteStep[];
}

export interface RouteResult {
  provider: string;
  geometry: [number, number][];
  distance_m: number;
  duration_s: number;
  steps: RouteStep[];
  legs: RouteLeg[];
  approximate: boolean;
  traffic_aware?: boolean;
  note?: string;
  /** Which vehicle profile produced this. */
  mode?: 'general' | 'bike' | 'car';
  /** The way round in words, e.g. "NH 48". */
  summary?: string;
  labels?: string[];
  /** Every way round Google offered, fastest first. Only on the primary result. */
  alternatives?: RouteResult[];
  /** Why there are no alternatives, when there are none. */
  alternatives_note?: string;
}

/** One GPS reading, as recorded and as sent to the server. */
export interface Fix {
  lat: number;
  lng: number;
  t: string;
  speed: number | null;
  accuracy: number | null;
  heading: number | null;
}
