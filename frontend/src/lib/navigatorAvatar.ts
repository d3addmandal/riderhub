import { RouteMode } from '../types';

/**
 * The rider's own marker — the thing that moves along the road.
 *
 * Drawn as one SVG rather than a circle with a text label on top of it. A Google Maps
 * marker label is positioned independently of its symbol, so a glyph label on a circle
 * sits low and slightly off-centre — which is exactly the "icon under the box" problem
 * this replaces. One image with an explicit centre anchor cannot come apart.
 *
 * The depth is done with light rather than tricks: a shadow beneath, a lit top-left on
 * the dome, a darker rim at the bottom, and a specular highlight. At 56 px on a phone
 * that reads as a physical puck sitting on the map instead of a flat sticker.
 */

const SIZE = 96;          // viewBox units; the marker is scaled down when placed
const C = SIZE / 2;
const R = 25;             // dome radius

/**
 * Vehicle marks, drawn nose-up on a 96-unit grid.
 *
 * The motorcycle is a real motorcycle seen from above-behind — front wheel, forks,
 * handlebars, tank, seat and rear wheel — not a generic two-circle scooter. At this size
 * the fork line and the bar sweep are what make it read as a bike at a glance.
 */
const GLYPH: Record<RouteMode, string> = {
  // A chevron, the clearest possible "this way".
  general: `<path class="glyph" d="M48 31 L58 60 L48 54 L38 60 Z"
      fill="url(#gloss)" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>`,

  bike: `<g class="glyph" fill="none" stroke="#ffffff" stroke-width="3.4"
        stroke-linecap="round" stroke-linejoin="round">
      <path d="M39 33 H57"/>
      <path d="M48 33 V41"/>
      <path d="M48 41 L42 50 L48 57 L54 50 Z" fill="#ffffff" stroke-width="2.6"/>
      <circle cx="48" cy="36" r="3.4" fill="#ffffff" stroke="none"/>
      <path d="M43 62 H53"/>
      <circle cx="48" cy="65" r="4.2"/>
    </g>`,

  car: `<g class="glyph" fill="none" stroke="#ffffff" stroke-width="3.2"
        stroke-linecap="round" stroke-linejoin="round">
      <path d="M39 40 q9 -8 18 0 l2 20 q-11 5 -22 0 Z" fill="#ffffff" fill-opacity="0.18"/>
      <path d="M41 45 q7 -4 14 0"/>
      <path d="M40 58 h16"/>
    </g>`,
};

/**
 * A data URI for the marker at a given heading.
 *
 * `heading` is degrees clockwise from north. Pass 0 when the map itself is already
 * rotated to the heading — markers stay screen-aligned, so an unrotated mark is already
 * pointing up the screen, which is the direction of travel.
 */
export function avatarSvg(mode: RouteMode, heading: number, opts?: { beam?: boolean }): string {
  const beam = opts?.beam !== false;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="beam" cx="50%" cy="100%" r="80%">
      <stop offset="0%" stop-color="#f97316" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#f97316" stop-opacity="0"/>
    </radialGradient>
    <!-- Lit from the top left, the way everything else on a screen is. -->
    <radialGradient id="dome" cx="36%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#5a6270"/>
      <stop offset="55%" stop-color="#232936"/>
      <stop offset="100%" stop-color="#0b0e15"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffb066"/>
      <stop offset="100%" stop-color="#c2540a"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d8dee8"/>
    </linearGradient>
    <filter id="drop" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.2" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>

  <g transform="rotate(${heading.toFixed(1)} ${C} ${C})">
    ${beam ? `<path d="M48 46 L10 4 A56 56 0 0 1 86 4 Z" fill="url(#beam)"/>` : ''}
    <g filter="url(#drop)">
      <!-- Outer ring, lit top to bottom so the puck has a thickness to it. -->
      <circle cx="${C}" cy="${C}" r="${R}" fill="url(#rim)"/>
      <circle class="disc" cx="${C}" cy="${C}" r="${R - 3.5}" fill="url(#dome)"/>
      <!-- Specular sweep across the upper dome. -->
      <path d="M${C - 17} ${C - 9} A20 20 0 0 1 ${C + 15} ${C - 13}"
            fill="none" stroke="#ffffff" stroke-opacity="0.30" stroke-width="3.4" stroke-linecap="round"/>
    </g>
    ${GLYPH[mode]}
  </g>
</svg>`;
}

export function avatarDataUri(mode: RouteMode, heading: number, opts?: { beam?: boolean }): string {
  // encodeURIComponent rather than base64: smaller, and readable in devtools.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(mode, heading, opts))}`;
}

/**
 * Heading quantised for redraw purposes.
 *
 * The compass reports many times a second. Rebuilding the marker image for a third of a
 * degree would churn the DOM for nothing, so the icon is only regenerated once the
 * heading has actually moved enough to see.
 */
export function quantiseHeading(h: number, step = 3): number {
  return Math.round(((h % 360) + 360) % 360 / step) * step % 360;
}

/** Natural size on screen, in CSS pixels. Big enough to read at a glance mid-ride. */
export const AVATAR_PX = 58;
