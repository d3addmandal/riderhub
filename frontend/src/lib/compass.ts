import { useEffect, useRef, useState } from 'react';

/**
 * Which way the rider is facing.
 *
 * GPS only knows a *course* — the direction you last moved — so it is right at speed and
 * useless at a standstill, where it either freezes on the last value or returns nothing.
 * The compass knows which way the phone points even when still. Nav apps blend the two,
 * and so does this: course above walking pace, compass below it.
 *
 * Reading the compass differs by platform. iOS exposes a true heading directly, but only
 * after an explicit permission prompt that must come from a tap. Android reports an
 * orientation angle that has to be turned into a heading and corrected for however the
 * screen itself is rotated — miss that and the arrow is 90° out in landscape, which is
 * exactly when a rider is most likely to be using it.
 */

/** Above this speed (km/h) the GPS course is the better answer. */
const MOVING_KMH = 6;

type OrientationEventish = DeviceOrientationEvent & { webkitCompassHeading?: number };

interface DeviceOrientationCtor {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
}

/** iOS refuses the compass until the rider allows it, and only from a user gesture. */
export function compassNeedsPermission(): boolean {
  const ctor = window.DeviceOrientationEvent as unknown as DeviceOrientationCtor | undefined;
  return typeof ctor?.requestPermission === 'function';
}

export async function requestCompassPermission(): Promise<boolean> {
  const ctor = window.DeviceOrientationEvent as unknown as DeviceOrientationCtor | undefined;
  if (typeof ctor?.requestPermission !== 'function') return true;
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** How far the screen itself is rotated, so the heading is relative to the world. */
function screenAngle(): number {
  const a = (screen as unknown as { orientation?: { angle?: number } }).orientation?.angle;
  return typeof a === 'number' ? a : (window.orientation as number | undefined) ?? 0;
}

function headingFrom(e: OrientationEventish): number | null {
  // iOS hands us a true heading already corrected for the device.
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    return e.webkitCompassHeading;
  }
  // Android: alpha counts anticlockwise from north, and ignores screen rotation.
  if (typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    return (360 - e.alpha + screenAngle()) % 360;
  }
  return null;
}

/** Shortest signed turn from a to b, so 350° → 10° is +20 and not −340. */
function shortestDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/**
 * A live heading in degrees, smoothed.
 *
 * Raw compass output jitters by several degrees a second; feeding that straight to a map
 * makes the whole world twitch. Easing toward the target across frames keeps the motion
 * readable, and going the short way round stops it spinning the long way at north.
 */
export function useHeading(gpsHeading: number | null, speedKmh: number | null) {
  const [heading, setHeading] = useState<number | null>(null);
  const [compassOk, setCompassOk] = useState(false);

  const compass = useRef<number | null>(null);
  const smoothed = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!window.DeviceOrientationEvent) return;

    const onOrient = (e: Event) => {
      const h = headingFrom(e as OrientationEventish);
      if (h == null) return;
      compass.current = h;
      if (!compassOk) setCompassOk(true);
    };

    // `absolute` is the one that is actually referenced to north; plain `deviceorientation`
    // is relative on some Android builds, so it is only a fallback.
    window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
    return () => {
      window.removeEventListener('deviceorientationabsolute', onOrient, true);
      window.removeEventListener('deviceorientation', onOrient, true);
    };
  }, [compassOk]);

  useEffect(() => {
    const tick = () => {
      const moving = (speedKmh ?? 0) >= MOVING_KMH;
      const target = moving ? (gpsHeading ?? compass.current) : (compass.current ?? gpsHeading);

      if (target != null) {
        smoothed.current = smoothed.current == null
          ? target
          : (smoothed.current + shortestDelta(smoothed.current, target) * 0.18 + 360) % 360;
        // Only re-render on a visible change, so the map is not redrawn for 0.2°.
        setHeading(prev => prev == null || Math.abs(shortestDelta(prev, smoothed.current!)) >1
            ? smoothed.current
            : prev);
      }
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current) cancelAnimationFrame(frame.current); };
  }, [gpsHeading, speedKmh]);

  return { heading, compassOk, source: (speedKmh ?? 0) >= MOVING_KMH ? 'gps' : 'compass' as const };
}
