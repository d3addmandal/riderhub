/**
 * Turn arrows, drawn the way a nav app draws them.
 *
 * Each glyph is a single stroked path on a 32×32 grid: the road comes up from the bottom
 * centre, and the arrowhead points where the rider is about to go. That shape — a stem
 * that rises then bends — is what makes "straight on, then right" readable at a glance,
 * which a bare "↱" character never manages. Everything inherits `currentColor`, so the
 * arrow and the distance beside it are always the same colour.
 */
export type Maneuver = string | null | undefined;

/** Path data per manoeuvre, plus whether it needs mirroring for the left-hand variant. */
const PATHS: Record<string, string> = {
  STRAIGHT: 'M16 29 V7 M16 5 l-6 7 M16 5 l6 7',
  // Rise, then bend right and point right.
  TURN_RIGHT: 'M11 29 V15 a6 6 0 0 1 6-6 h7 M22 3 l7 6 -7 6',
  TURN_SLIGHT_RIGHT: 'M12 29 V19 L23 8 M17 6 h8 v8',
  TURN_SHARP_RIGHT: 'M9 29 V17 a5 5 0 0 1 8-4 l7 5 M20 5 l6 8 -9 3',
  TURN_U_TURN_RIGHT: 'M10 29 V15 a6 6 0 0 1 12 0 v7 M16 20 l6 7 6-7',
  FORK_RIGHT: 'M13 29 V20 L22 10 M17 8 h7 v7 M13 20 V12',
  RAMP_RIGHT: 'M12 29 V18 a8 8 0 0 1 8-8 h5 M22 5 l6 5 -6 5',
  ROUNDABOUT_RIGHT: 'M16 29 V21 M16 21 a6 6 0 1 0 6-6 M27 15 l-5-4 -1 7',
  MERGE: 'M16 29 V16 a8 8 0 0 1 8-8 M16 16 a8 8 0 0 0-8-8 M24 5 l5 3 -5 3',
  DEPART: 'M16 29 V9 M16 7 l-5 6 M16 7 l5 6',
  ARRIVE: 'M16 4 a8 8 0 0 1 8 8 c0 6-8 16-8 16 S8 18 8 12 a8 8 0 0 1 8-8 Z M16 12 h.01',
  NAME_CHANGE: 'M16 29 V7 M16 5 l-6 7 M16 5 l6 7',
};

/** Left-hand turns are the right-hand path mirrored, so only one set is maintained. */
const MIRRORED: Record<string, string> = {
  TURN_LEFT: 'TURN_RIGHT',
  TURN_SLIGHT_LEFT: 'TURN_SLIGHT_RIGHT',
  TURN_SHARP_LEFT: 'TURN_SHARP_RIGHT',
  TURN_U_TURN_LEFT: 'TURN_U_TURN_RIGHT',
  FORK_LEFT: 'FORK_RIGHT',
  RAMP_LEFT: 'RAMP_RIGHT',
  ROUNDABOUT_LEFT: 'ROUNDABOUT_RIGHT',
};

export default function ManeuverIcon({ maneuver, size = 34, className, strokeWidth = 2.6 }: {
  maneuver: Maneuver;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const key = maneuver ?? 'STRAIGHT';
  const mirror = MIRRORED[key];
  const d = PATHS[mirror ?? key] ?? PATHS.STRAIGHT;
  const filled = (mirror ?? key) === 'ARRIVE';

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      // Mirroring about the centre turns every right-hand glyph into its left twin.
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d={d} fill={filled ? 'currentColor' : 'none'} fillOpacity={filled ? 0.18 : undefined} />
    </svg>
  );
}

/** A short spoken-style name for the manoeuvre, for labels and screen readers. */
export function maneuverLabel(maneuver: Maneuver): string {
  const key = (maneuver ?? 'STRAIGHT').replace(/_/g, ' ').toLowerCase();
  return key.replace(/\bturn\b/, 'turn').replace(/\bu turn\b/, 'U-turn');
}
