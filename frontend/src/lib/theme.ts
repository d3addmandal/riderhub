/**
 * Dark, light, or whatever the phone is set to.
 *
 * "system" deliberately stores no attribute at all — the stylesheet falls through to a
 * `prefers-color-scheme` media query — so a rider whose phone flips to light at sunrise
 * follows along without the app having to watch for it.
 */
export type ThemeChoice = 'dark' | 'light' | 'system';

const KEY = 'riderhub.theme';

export function readTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  localStorage.setItem(KEY, choice);

  // Keep the browser chrome (status bar, address bar) in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(root).getPropertyValue('--c-bg').trim();
    if (bg) meta.setAttribute('content', `rgb(${bg})`);
  }
}

/** Which theme is actually showing right now, once "system" is resolved. */
export function effectiveTheme(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Apply the saved choice before React mounts, so the first paint is already right.
 * Without this the app flashes dark on a light phone.
 */
export function initTheme() {
  applyTheme(readTheme());

  // On "system", follow the phone if it changes mid-session.
  window.matchMedia?.('(prefers-color-scheme: light)')
    .addEventListener?.('change', () => {
      if (readTheme() === 'system') applyTheme('system');
    });
}
