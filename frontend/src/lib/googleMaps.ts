/**
 * Loads the Google Maps JavaScript API.
 *
 * It cannot be bundled — Google requires it be fetched from their servers at runtime, and
 * their terms forbid caching it. One consequence worth knowing: with no connection the
 * map will not render at all.
 *
 * Loading detail that matters: with `loading=async` Google populates `google.maps` some
 * time AFTER the script element's onload fires. Checking for the API in onload therefore
 * races and usually loses. The documented pairing is `loading=async` plus a `callback`,
 * which is what this does.
 */

import { api } from './api';

let loader: Promise<typeof google.maps> | null = null;

/** Set by Google when the key itself is rejected — wrong key, no billing, blocked referrer. */
let authFailure = false;

interface MapsConfig {
  maps_key: string;
  map_id: string | null;
  configured: boolean;
  using_shared_key?: boolean;
}

/**
 * The browser key, fetched at runtime rather than compiled in.
 *
 * Baking it into the bundle put it in a file anyone could download and grep. Fetching it
 * behind Firebase auth means an anonymous scraper cannot reach it, and the key can be
 * rotated without rebuilding the frontend.
 *
 * It is not thereby secret — a signed-in rider can read it from their own network tab,
 * which is unavoidable for a key the browser has to hand to Google. The control that
 * actually protects it is an HTTP-referrer restriction in the Cloud console.
 */
let configPromise: Promise<MapsConfig> | null = null;
let config: MapsConfig | null = null;

export function mapsConfig(): Promise<MapsConfig> {
  if (!configPromise) {
    configPromise = api.get<MapsConfig>('/config/maps')
      .then(c => { config = c; return c; })
      .catch(e => {
        configPromise = null;   // let a later attempt retry
        throw e;
      });
  }
  return configPromise;
}

/**
 * Whether a map can be drawn.
 *
 * Optimistic before the config has arrived: the alternative is flashing a
 * "not configured" error at every rider for the fraction of a second it takes to ask.
 */
export function isConfigured(): boolean {
  return config ? config.configured : true;
}

/**
 * A Map ID switches Google to *vector* rendering, which is the only mode where tilt and
 * heading can be set programmatically — i.e. the only way to get heading-up, tilted
 * turn-by-turn navigation. Without one the map still works, just north-up and flat.
 *
 * Create one free at Google Cloud → Google Maps Platform → Map management, choosing
 * JavaScript / Vector. Styling then lives in the cloud console rather than in `styles`
 * below, because a vector map ignores inline styles.
 */
export function mapId(): string | undefined {
  return config?.map_id || undefined;
}

/** True when the map can tilt and rotate — i.e. a vector map is configured. */
export function supportsHeading(): boolean {
  return Boolean(mapId());
}

export function hadAuthFailure(): boolean {
  return authFailure;
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (loader) return loader;

  const pending: Promise<typeof google.maps> = mapsConfig().then(cfg => {
    if (!cfg.configured) {
      throw new Error(
        'Google Maps key missing. Set GOOGLE_MAPS_BROWSER_KEY (or GOOGLE_MAPS_API_KEY) '
        + 'in backend/.env and restart the API.');
    }
    return injectScript(cfg.maps_key);
  }).catch(e => {
    loader = null;   // allow a retry once the problem is fixed
    throw e;
  });

  loader = pending;
  return pending;
}

/** Insert Google's script tag and resolve once the API is genuinely usable. */
function injectScript(key: string): Promise<typeof google.maps> {
  return new Promise((resolve, reject) => {
    // Already loaded — e.g. a hot reload re-ran this module.
    if (typeof google !== 'undefined' && google.maps?.Map) {
      resolve(google.maps);
      return;
    }

    const callbackName = `__riderhubMapsReady_${Date.now()}`;
    let settled = false;

    const cleanup = () => { delete (window as any)[callbackName]; };

    // Google calls this once the API is genuinely usable.
    (window as any)[callbackName] = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (google?.maps?.Map) resolve(google.maps);
      else reject(new Error('Google Maps initialised but the Maps library is missing.'));
    };

    // Fires for InvalidKeyMapError, RefererNotAllowedMapError, BillingNotEnabled, etc.
    // Google reports these here rather than by failing the script request.
    (window as any).gm_authFailure = () => {
      authFailure = true;
      if (settled) return;
      settled = true;
      cleanup();
      loader = null;
      reject(new Error(
        'Google rejected the API key. Check that the Maps JavaScript API is enabled, ' +
        'billing is on for the project, and the key\'s HTTP-referrer restrictions allow this address.'));
    };

    const params = new URLSearchParams({
      key,
      v: 'weekly',
      libraries: 'geometry',
      loading: 'async',
      callback: callbackName,
      language: 'en',
      region: 'IN',
    });

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      loader = null; // allow a retry
      reject(new Error('Could not reach Google Maps. Check your internet connection.'));
    };

    // The callback should fire quickly; if it never does, say so rather than spinning.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      loader = null;
      reject(new Error('Google Maps did not finish loading. Check the browser console for a Maps error.'));
    }, 20000);

    document.head.appendChild(script);
  });
}

/** Dark styling so the map matches the app rather than glaring at a rider at night. */
export const DARK_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1a1d27' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8b90a8' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0f1117' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2d3148' }] },
  { featureType: 'poi', stylers: [{ visibility: 'simplified' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#16281f' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d3148' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#22252f' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3d4260' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#2d3148' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#343850' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1520' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3d5a80' }] },
];
