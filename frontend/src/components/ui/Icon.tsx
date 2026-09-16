import { cn } from '../../lib/utils';

/**
 * A small, deliberately plain icon set.
 *
 * Drawn rather than typed: a text "←" renders in whatever font the phone happens to pick,
 * sits off the optical centre of its button, and cannot be given a consistent weight. A
 * stroked path lines up with the text around it, scales without blurring, and inherits
 * `currentColor` so one hover rule covers the icon and its label together.
 *
 * All paths are drawn on a 24×24 grid with a 2px stroke and round caps, so mixing them in
 * one row does not look like mixing two icon sets.
 */
export type IconName =
  | 'back' | 'forward' | 'close' | 'check' | 'chevronDown' | 'chevronRight' | 'search' | 'plus' | 'trash' | 'edit' | 'drag' | 'up' | 'down' | 'pin' | 'navigate' | 'target' | 'route' | 'download' | 'refresh' | 'user' | 'flag' | 'play' | 'pause' | 'note';

const PATHS: Record<IconName, JSX.Element> = { back:         <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>, forward:      <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>, close:        <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  check:        <path d="M20 6 9 17l-5-5" />,
  chevronDown:  <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />, search:       <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, plus:         <><path d="M12 5v14" /><path d="M5 12h14" /></>, trash:        <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>, edit:         <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  drag:         <><circle cx="9" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" />
                   <circle cx="15" cy="6" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="15" cy="18" r="1.4" /></>,
  up:           <path d="m6 15 6-6 6 6" />,
  down:         <path d="m6 9 6 6 6-6" />, pin:          <><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
  navigate:     <path d="m3 11 19-9-9 19-2-8-8-2Z" />,
  target:       <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" />
                   <path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  route:        <><circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" />
                   <path d="M9 19h4a4 4 0 0 0 0-8h-2a4 4 0 0 1 0-8h4" /></>, download:     <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></>, refresh:      <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>, user:         <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, flag:         <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  play:         <path d="M7 4.5v15l12-7.5-12-7.5Z" />, pause:        <><path d="M9 4v16" /><path d="M15 4v16" /></>, note:         <><path d="M5 3h9l5 5v13H5Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
};

/** Icons that read better filled than stroked. */
const FILLED: IconName[] = ['navigate', 'play'];

export default function Icon({ name, className, size = 20, strokeWidth = 2 }: {
  name: IconName;
  className?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const filled = FILLED.includes(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('flex-shrink-0', className)}
    >
      {PATHS[name]}
    </svg>
  );
}
