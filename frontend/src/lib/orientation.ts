/**
 * Locking the screen sideways.
 *
 * Browsers only allow an orientation lock while the page is fullscreen, and several
 * refuse outright — iOS Safari has no Screen Orientation lock at all, and desktop
 * browsers reject it. So this always reports back what actually happened rather than
 * pretending: the caller can tell the rider to use the phone's own rotation lock when
 * the browser will not do it.
 */
export type LockResult =
  | { ok: true; orientation: 'landscape' | 'portrait' }
  | { ok: false; reason: string };

/**
 * `lock` is not in every lib.dom, and `unlock` is typed as always present when it is not.
 * Describing only what we call keeps this honest about what may be missing at runtime.
 */
interface OrientationWithLock {
  type?: string;
  lock?: (o: string) => Promise<void>;
  unlock?: () => void;
}

function orientationApi(): OrientationWithLock | null {
  return (screen?.orientation as unknown as OrientationWithLock | undefined) ?? null;
}

export function isLandscape(): boolean {
  const type = orientationApi()?.type;
  if (type) return type.startsWith('landscape');
  return window.innerWidth >window.innerHeight;
}

/** True when this browser can even attempt a lock. */
export function canLockOrientation(): boolean {
  return typeof orientationApi()?.lock === 'function';
}

/**
 * Turn the given element fullscreen and lock the screen to an orientation.
 * Fullscreen first, because the lock is refused outside it.
 */
export async function lockOrientation(
  el: HTMLElement | null,
  want: 'landscape' | 'portrait',
): Promise<LockResult> {
  const api = orientationApi();
  if (!api?.lock) {
    return {
      ok: false,
      reason: 'This browser cannot rotate the screen for you. Use your phone rotation lock instead.',
    };
  }

  try {
    const target = el ?? document.documentElement;
    if (!document.fullscreenElement && target.requestFullscreen) {
      await target.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions);
    }
    await api.lock(want);
    return { ok: true, orientation: want };
  } catch (e: any) {
    // Leaving fullscreen on failure avoids stranding the rider in a fullscreen page
    // that did not rotate.
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
    return {
      ok: false,
      reason: e?.name === 'NotSupportedError'? 'Your phone will not let the browser rotate the screen. Use its own rotation lock.': 'Could not rotate the screen. Check that rotation is unlocked on your phone.',
    };
  }
}

/** Release the lock and drop out of fullscreen. */
export async function unlockOrientation(): Promise<void> {
  try { orientationApi()?.unlock?.(); } catch { /* ignore */ }
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
}
