/*
 * The loading screen: the club badge on the same dark ground as the manifest's
 * background_color and the static boot screen in index.html, so an installed app goes
 * system splash → HTML boot screen → this → the dashboard without a visible seam.
 *
 * Deliberately not theme-aware: Android's own splash is always the dark ground, and
 * flipping to light for one second before the app appears would look like a glitch.
 */
export default function Splash({ label }: { label?: string }) {
  return (
    <div className="fixed inset-0 grid place-items-center" style={{ background: '#0f1117' }} role="status" aria-label={label ?? 'Loading'}>
      <img src="/logo.webp" alt="" width={240} height={240} className="h-auto animate-pulse" style={{ width: 'min(58vw, 240px)' }} />
    </div>
  );
}
