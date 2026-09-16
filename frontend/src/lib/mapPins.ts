/**
 * Map pins, drawn.
 *
 * These used to be emoji carried in a marker *label* sitting on a zero-radius symbol.
 * That arrangement has two problems: stripping the emoji left the marker invisible, and a
 * label with empty text is a degenerate thing to hand Google — the kind of input a map
 * library is free to render however it likes. A drawn icon has neither problem: it is one
 * image, always visible, with nothing for the map to interpret.
 */

const PIN_SIZE = 44;

function uri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const SHADOW = `<filter id="s" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>
  </filter>`;

/** The finish: a chequered flag on a post, planted at the point. */
export function destinationPin(): string {
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 44 44">
  <defs>${SHADOW}</defs>
  <g filter="url(#s)">
    <path d="M14 38 V8" stroke="#0f1117" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M15.5 9 H33 V21 H15.5 Z" fill="#ffffff" stroke="#0f1117" stroke-width="1.5"/>
    <g fill="#0f1117">
      <rect x="15.5" y="9" width="4.4" height="3" /><rect x="24.3" y="9" width="4.4" height="3"/>
      <rect x="19.9" y="12" width="4.4" height="3"/><rect x="28.7" y="12" width="4.3" height="3"/>
      <rect x="15.5" y="15" width="4.4" height="3"/><rect x="24.3" y="15" width="4.4" height="3"/>
      <rect x="19.9" y="18" width="4.4" height="3"/><rect x="28.7" y="18" width="4.3" height="3"/>
    </g>
    <circle cx="14" cy="38" r="3.4" fill="#f97316" stroke="#ffffff" stroke-width="2"/>
  </g>
</svg>`);
}

/** A dropped pin, for the spot the rider just tapped. */
export function dropPin(): string {
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 44 44">
  <defs>${SHADOW}</defs>
  <g filter="url(#s)">
    <path d="M22 41 C22 41 34 26.5 34 18 A12 12 0 0 0 10 18 C10 26.5 22 41 22 41 Z"
          fill="#f97316" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="22" cy="18" r="4.6" fill="#ffffff"/>
  </g>
</svg>`);
}

/** Where the icon's point sits relative to its image, per pin. */
export const PIN_ANCHOR = {
  /** The flag is planted at the foot of its post. */
  destination: { x: 14, y: 38 },
  /** A teardrop points from its tip. */
  drop: { x: 22, y: 41 },
};

export const PIN_PX = PIN_SIZE;
