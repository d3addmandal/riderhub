/**
 * Another rider on the map: a coloured disc with the first letter of their name.
 *
 * Deliberately not the vehicle avatar — that one means *you*. Mid-ride a rider has to
 * tell their own heading apart from everyone else's position without thinking about it,
 * and giving the whole group the same arrow would turn that into a reading exercise at
 * speed. A lettered disc reads as "someone", the arrow reads as "me".
 *
 * The colour matches the one beside their name in the members list, so a dot on the map
 * and a row in the list are obviously the same person.
 */

const SIZE = 40;
const C = SIZE / 2;

/**
 * The letter to show.
 *
 * Takes the first letter of the first real word, so "  raj kumar" gives R rather than a
 * space. Falls back to a dot rather than rendering an empty badge.
 */
export function initialOf(name: string): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const ch = [...first][0];
  return ch ? ch.toUpperCase() : '•';
}

/** Escape the few characters that would break the SVG document. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function riderBadgeSvg(name: string, colour: string): string {
  const letter = esc(initialOf(name));
  // A hex colour only — anything else could inject markup into the document.
  const fill = /^#[0-9a-fA-F]{3,8}$/.test(colour) ? colour : '#94a3b8';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <filter id="d" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <g filter="url(#d)">
    <circle cx="${C}" cy="${C}" r="14" fill="${fill}" stroke="#ffffff" stroke-width="3"/>
    <text x="${C}" y="${C}" fill="#ffffff" font-size="15" font-weight="700"
          font-family="-apple-system, Segoe UI, Roboto, sans-serif"
          text-anchor="middle" dominant-baseline="central">${letter}</text>
  </g>
</svg>`;
}

export function riderBadge(name: string, colour: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(riderBadgeSvg(name, colour))}`;
}

export const BADGE_PX = 34;
