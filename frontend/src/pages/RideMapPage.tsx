import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Ride, RideStop, RidePoint, StopKind, Poi, PoiKind, RouteMode, LiveRider } from '../types';
import { Button, Modal, Icon, IconButton, Chip } from '../components/ui';
import PlacePicker from '../components/common/PlacePicker';
import StopsEditor, { StopRow } from '../components/rides/StopsEditor';
import StopKindPicker from '../components/rides/StopKindPicker';
import OfflineRouteCanvas from '../components/rides/OfflineRouteCanvas';
import { loadGoogleMaps, DARK_MAP_STYLE, isConfigured, mapId, supportsHeading } from '../lib/googleMaps';
import { RouteResult, Fix } from '../lib/routeTypes';
import { stopMeta } from '../lib/stopKinds';
import NearbyFinder, { FindScope } from '../components/rides/NearbyFinder';
import PlaceDetailSheet from '../components/rides/PlaceDetailSheet';
import ManeuverIcon from '../components/rides/ManeuverIcon';
import { lockOrientation, unlockOrientation, isLandscape } from '../lib/orientation';
import { avatarDataUri, quantiseHeading, AVATAR_PX } from '../lib/navigatorAvatar';
import { destinationPin, dropPin, PIN_ANCHOR, PIN_PX } from '../lib/mapPins';
import { riderBadge, BADGE_PX } from '../lib/riderBadge';
import { useHeading, compassNeedsPermission, requestCompassPermission } from '../lib/compass';
import { POI_KIND_META, ROUTE_MODE_META } from '../lib/stopKinds';
import {
  savePack, loadPack, deletePack, releaseRide, RidePack,
  queueFixes, queuedFixes, dropFixes, persistStorage,
} from '../lib/offlineRide';

/** Within this many metres of a stop counts as arrived. */
const ARRIVE_RADIUS_M = 120;
/** Re-route when the rider strays this far from the drawn line. */
const REROUTE_AFTER_M = 250;
/** Flush buffered GPS points once we have this many, or on pause/exit. */
const TRACK_BATCH = 25;


/** Arrow for each Google manoeuvre code, so the banner reads at a glance. */
// ── Local geo maths — works with no network at all ────────────
function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compassOf = (d: number) => COMPASS[Math.round(d / 45) % 8];

const fmtDistance = (m: number) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

const fmtBytes = (b: number) => b < 1024 ? `${b} B`
  : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB`
  : `${(b / (1024 * 1024)).toFixed(1)} MB`;

function fmtEta(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const mins = Math.round(s / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function metresFromLine(p: { lat: number; lng: number }, line: [number, number][]): number {
  let best = Infinity;
  for (const [lng, lat] of line) {
    const d = metresBetween(p, { lat, lng });
    if (d < best) best = d;
  }
  return best;
}

export default function RideMapPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const meMarker = useRef<google.maps.Marker | null>(null);
  const accuracyCircle = useRef<google.maps.Circle | null>(null);
  const stopMarkers = useRef<google.maps.Marker[]>([]);
  /** One marker per other rider, keyed by user id so they can be moved not rebuilt. */
  const riderMarkers = useRef<Map<string, google.maps.Marker>>(new Map());
  /** The leg being ridden — bright. */
  const activeLine = useRef<google.maps.Polyline | null>(null);
  /** Everything after it — dimmed, so the whole journey is visible at once. */
  const aheadLine = useRef<google.maps.Polyline | null>(null);
  const watchId = useRef<number | null>(null);
  const buffer = useRef<Fix[]>([]);
  const wakeLock = useRef<any>(null);
  const spokenFor = useRef<string | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState('');
  const [pos, setPos] = useState<Fix | null>(null);
  /**
   * The latest fix, readable from inside long-lived timers.
   *
   * The faster-route check runs on an interval; closing over `pos` would either pin it to
   * a stale value or force the interval to be torn down and rebuilt on every GPS tick.
   */
  /**
   * Which way the rider is actually facing.
   *
   * GPS gives a course, which is right at speed and meaningless standing still; the
   * compass is the reverse. `useHeading` blends them, so the avatar keeps pointing the
   * right way at a red light instead of freezing on the last direction of travel.
   */
  const posRef = useRef<Fix | null>(null);
  useEffect(() => { posRef.current = pos; }, [pos]);

  const { heading: facing, compassOk } = useHeading(pos?.heading ?? null, pos?.speed ?? null);
  /** iOS will not report a compass until the rider allows it, and only on a tap. */
  const [compassAsked, setCompassAsked] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routing, setRouting] = useState(false);
  const [follow, setFollow] = useState(true);
  const [voice, setVoice] = useState(false);
  const [synced, setSynced] = useState<'idle' | 'pending' | 'synced' | 'failed'>('idle');
  const [online, setOnline] = useState(navigator.onLine);

  // Adding a stop mid-ride
  const [showAddStop, setShowAddStop] = useState(false);
  const [newStop, setNewStop] = useState<RidePoint | null>(null);
  const [stopPosition, setStopPosition] = useState<'next' | 'end'>('next');
  const [addingStop, setAddingStop] = useState(false);
  const [addError, setAddError] = useState('');
  /** Tap-the-map mode for choosing a stop position. */
  const [pickingOnMap, setPickingOnMap] = useState(false);
  const [resolvingPin, setResolvingPin] = useState(false);
  const pinMarker = useRef<google.maps.Marker | null>(null);
  const [showItinerary, setShowItinerary] = useState(false);
  /**
   * True when the stop's coordinates came from tapping the map or pinning the rider's own
   * position, so renaming it must not discard them.
   */
  const [pinnedByHand, setPinnedByHand] = useState(false);
  /** The stop being repositioned by dragging its pin, so the UI can confirm the move. */
  const [movedStop, setMovedStop] = useState<string>('');
  const [stopsBusy, setStopsBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  /** GPS fixes sitting in durable storage waiting for signal. */
  const [queuedCount, setQueuedCount] = useState(0);

  // Stop kinds
  const [newStopKind, setNewStopKind] = useState<StopKind>('break');
  const [newStopMinutes, setNewStopMinutes] = useState<number | null>(null);

  // Finding things nearby — which place to search from, and what for
  const [finder, setFinder] = useState<null | { scopeId?: string; kind: PoiKind }>(null);
  /** The place whose full card is open — rating, photos, reviews. */
  const [openPoi, setOpenPoi] = useState<Poi | null>(null);
  /** Whether we have forced the screen sideways, and why it failed if it did. */
  const [rotated, setRotated] = useState(false);
  const [rotateNote, setRotateNote] = useState('');

  // Offline
  const [pack, setPack] = useState<RidePack | null>(null);
  const [savingPack, setSavingPack] = useState(false);
  const [packMsg, setPackMsg] = useState('');
  /** Tiles are unreachable — fall back to drawing the cached route ourselves. */
  const [tilesDown, setTilesDown] = useState(false);
  /** The whole remaining journey — geometry, legs and turn steps, from one call. */
  const [plan, setPlan] = useState<RouteResult | null>(null);
  /** Turn-by-turn mode: tilted, heading-up, instruction banner, voice. */
  const [navMode, setNavMode] = useState(false);

  /**
   * Which vehicle the route is planned for. Kept per ride so a rider who picked the
   * motorcycle profile does not silently get car roads back after a reload.
   */
  const [routeMode, setRouteMode] = useState<RouteMode>(() =>
    (localStorage.getItem('riderhub.routeMode') as RouteMode) || 'bike');
  useEffect(() => { localStorage.setItem('riderhub.routeMode', routeMode); }, [routeMode]);

  /** Every way round Google offered, and which one the rider is on. */
  const [alternatives, setAlternatives] = useState<RouteResult[]>([]);
  const [altNote, setAltNote] = useState('');
  const [chosenAlt, setChosenAlt] = useState(0);
  const [showRoutes, setShowRoutes] = useState(false);
  /** A quicker way spotted mid-ride, waiting for the rider to accept or wave off. */
  const [betterRoute, setBetterRoute] = useState<{ route: RouteResult; saves_s: number } | null>(null);
  /** Alternatives the rider already declined, so the same one is not offered on a loop. */
  const declined = useRef<Set<string>>(new Set());

  const { data: ride } = useQuery<Ride>({
    queryKey: ['ride', rideId],
    queryFn: () => api.get(`/rides/${rideId}`),
    enabled: !!rideId,
  });

  const stops: RideStop[] = [...(ride?.stops ?? [])].sort((a, b) => a.order - b.order);
  const nextStop = stops.find(s => !s.reached_at) ?? null;
  const target = nextStop
    ?? (ride?.destination?.lat != null
        ? ({ ...ride.destination, id: 'dest', order: 999, reached_at: null } as RideStop)
        : null);
  const targetHasCoords = target?.lat != null && target?.lng != null;

  /**
   * Everything still ahead: each unreached stop, then the destination. The route is
   * planned across all of them so the rider always sees the path to the final target.
   */
  const remainingPoints: RideStop[] = [
    ...stops.filter(s => !s.reached_at && s.lat != null && s.lng != null),
    ...(ride?.destination?.lat != null && ride?.destination?.lng != null
      ? [{ ...ride.destination, id: 'dest', order: 999, reached_at: null } as RideStop]
      : []),
  ];
  /**
   * Stable identity for the route shape. Coordinates are part of it, not just ids, so
   * dragging a pin to a new spot re-routes instead of leaving the old line on screen.
   */
  const remainingPointsKey = remainingPoints
    .map(s => `${s.id}:${s.lat?.toFixed(5)},${s.lng?.toFixed(5)}`).join(' | ');

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ── Map ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;

    if (!isConfigured()) {
      setMapError('Google Maps is not configured. Add VITE_GOOGLE_MAPS_API_KEY to frontend/.env.');
      return;
    }

    let cancelled = false;
    loadGoogleMaps()
      .then(maps => {
        if (cancelled || !mapDiv.current) return;
        const vector = supportsHeading();
        const map = new maps.Map(mapDiv.current, {
          center: { lat: 20.5937, lng: 78.9629 },
          zoom: 5,
          // A vector map (Map ID) can tilt and rotate for heading-up navigation, but
          // ignores inline styles — its theme is set in the cloud console. A raster map
          // takes our dark styles but stays north-up.
          ...(vector ? { mapId: mapId() } : { styles: DARK_MAP_STYLE }),
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'greedy',   // one-finger pan, for gloves
          clickableIcons: false,
          ...(vector ? { tiltInteractionEnabled: true, headingInteractionEnabled: true } : {}),
        } as google.maps.MapOptions);
        // Dragging means the rider wants to look around, so stop re-centring.
        map.addListener('dragstart', () => setFollow(false));
        mapRef.current = map;
        setMapReady(true);
      })
      .catch(e => { if (!cancelled) setMapError(e.message); });

    return () => { cancelled = true; };
  }, []);

  // ── GPS upload, batched and durable ─────────────────────────
  /**
   * Fixes go to IndexedDB first and are only deleted once the server has them.
   *
   * The old in-memory buffer lost the whole trail if the browser was killed — which, on a
   * phone in a tank bag on a long day, happens. Now a crash costs nothing: the queue is
   * still there on restart and drains when signal returns.
   */
  const flush = useCallback(async (force = false) => {
    if (!rideId) return;

    // Park anything new in durable storage before attempting the network.
    if (buffer.current.length) {
      const pending = buffer.current.splice(0, buffer.current.length);
      try {
        await queueFixes(pending.map(f => ({ ...f, rideId })));
      } catch {
        buffer.current.unshift(...pending);   // storage refused — keep them in memory
      }
    }

    let queued: Awaited<ReturnType<typeof queuedFixes>> = [];
    try { queued = await queuedFixes(rideId); } catch { /* storage unavailable */ }

    if (!queued.length) return;
    if (!force && queued.length < TRACK_BATCH) { setQueuedCount(queued.length); return; }
    if (!navigator.onLine) { setSynced('failed'); setQueuedCount(queued.length); return; }

    setSynced('pending');
    try {
      await api.post(`/rides/${rideId}/track`, {
        points: queued.map(({ seq, rideId: _r, ...f }) => f),
      });
      await dropFixes(queued.map(q => q.seq));
      setSynced('synced');
      setQueuedCount(0);
    } catch {
      // Left in the queue deliberately — the next flush retries them.
      setSynced('failed');
      setQueuedCount(queued.length);
    }
  }, [rideId]);

  // Drain whatever a previous session left behind, and again whenever signal returns.
  useEffect(() => {
    if (!rideId) return;
    void flush(true);
    const onOnline = () => void flush(true);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [rideId, flush]);

  useEffect(() => {
    if (!navigator.geolocation) { setGpsError('This device has no GPS.'); return; }

    watchId.current = navigator.geolocation.watchPosition(
      p => {
        setGpsError('');
        const fix: Fix = {
          lat: p.coords.latitude, lng: p.coords.longitude,
          t: new Date(p.timestamp).toISOString(),
          speed: p.coords.speed != null ? +(p.coords.speed * 3.6).toFixed(1) : null,
          accuracy: p.coords.accuracy != null ? Math.round(p.coords.accuracy) : null,
          heading: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
        };
        setPos(fix);
        if (ride?.status === 'active') { buffer.current.push(fix); void flush(); }
      },
      err => setGpsError(err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Enable it to navigate.': `Could not get your location: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );

    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      void flush(true);
    };
  }, [ride?.status, flush]);

  // Keep the screen awake while riding.
  useEffect(() => {
    if (ride?.status !== 'active') return;
    (async () => {
      try { wakeLock.current = await (navigator as any).wakeLock?.request('screen'); } catch { /* unsupported */ }
    })();
    return () => { try { wakeLock.current?.release(); } catch { /* ignore */ } };
  }, [ride?.status]);

  // ── The navigator: the rider's own marker ───────────────────
  /**
   * What the rider is drawn as, by route profile.
   *
   * The vehicle is the clearest possible reminder of which set of roads is being
   * followed — glance down mid-ride and the car icon tells you instantly that you are
   * on a car route, which for a motorcycle can mean a barred flyover ahead. `general`
   * keeps the plain orange arrow.
   *
   * In nav mode the map is rotated so travel is up the screen, and markers stay screen-
   * aligned, so the arrow points straight up. North-up, it is rotated to the bearing.
   */
  /**
   * One image, anchored at its own centre.
   *
   * The previous version stacked a text label on a circle symbol, and Google positions a
   * marker label independently of its symbol — which is why the vehicle sat low and
   * outside the disc. A single SVG cannot come apart like that.
   */
  const navigatorIcon = useCallback((mode: RouteMode, heading: number, nav: boolean) => ({
    // Rotation is baked into the image. In nav mode the map is already turned to the
    // heading and markers stay screen-aligned, so an unrotated mark points up the
    // screen — which is the direction of travel.
    url: avatarDataUri(mode, nav ? 0 : heading),
    scaledSize: new google.maps.Size(AVATAR_PX, AVATAR_PX),
    anchor: new google.maps.Point(AVATAR_PX / 2, AVATAR_PX / 2),
  } as google.maps.Icon), []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !pos) return;
    const here = { lat: pos.lat, lng: pos.lng };
    const look = navigatorIcon(routeMode, quantiseHeading(facing ?? pos.heading ?? 0), navMode);

    if (!meMarker.current) {
      meMarker.current = new google.maps.Marker({
        map, position: here, zIndex: 999, icon: look, optimized: false,
      });
      accuracyCircle.current = new google.maps.Circle({
        map, center: here, radius: pos.accuracy ?? 0,
        fillColor: '#f97316', fillOpacity: 0.10,
        strokeColor: '#f97316', strokeOpacity: 0.3, strokeWeight: 1,
      });
      map.setCenter(here);
      map.setZoom(15);
    } else {
      meMarker.current.setPosition(here);
      meMarker.current.setIcon(look);
      accuracyCircle.current?.setCenter(here);
      accuracyCircle.current?.setRadius(pos.accuracy ?? 0);
    }

    // The accuracy ring is noise once you are navigating turn by turn.
    accuracyCircle.current?.setVisible(!navMode);

    // In nav mode the camera effect below owns the framing, so it is left alone here.
    if (follow && !navMode) map.panTo(here);
  }, [pos, mapReady, follow, navMode, routeMode, navigatorIcon, facing]);

  // ── Stop and destination markers ────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !ride) return;

    stopMarkers.current.forEach(m => m.setMap(null));
    stopMarkers.current = [];

    const canEdit = ride.status !== 'completed' && ride.status !== 'cancelled';

    stops.forEach((s, i) => {
      if (s.lat == null || s.lng == null) return;
      // The number is the stop's place in the ride, so a pin and its list row always agree.
      const isNext = s.id === nextStop?.id;
      const marker = new google.maps.Marker({
        map, position: { lat: s.lat, lng: s.lng },
        title: canEdit ? `${i + 1}. ${s.name} — drag to move` : `${i + 1}. ${s.name}`,
        draggable: canEdit && !s.reached_at,
        // Always a real string — an empty label is a degenerate thing to hand Google.
        label: { text: s.reached_at ? '✓' : String(i + 1), color: '#ffffff', fontSize: '12px', fontWeight: '700' },
        zIndex: isNext ? 200 : 100,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isNext ? 15 : 13,
          fillColor: s.reached_at ? '#22c55e' : isNext ? '#f97316' : '#1a1d27',
          fillOpacity: 1,
          strokeColor: s.reached_at ? '#22c55e' : '#f97316',
          strokeWeight: isNext ? 3 : 2,
        },
      });

      // Dragging a pin moves the stop itself — the rider nudges it onto the actual pump
      // rather than the road outside it.
      if (canEdit && !s.reached_at) {
        marker.addListener('dragend', async (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const lat = e.latLng.lat(), lng = e.latLng.lng();
          try {
            await api.patch(`/rides/${rideId}/stops/${s.id}`, { lat, lng });
            await qc.invalidateQueries({ queryKey: ['ride', rideId] });
            setMovedStop(s.name);
            window.setTimeout(() => setMovedStop(''), 2500);
          } catch {
            // Put it back where it was rather than leave the map lying about the route.
            marker.setPosition({ lat: s.lat!, lng: s.lng! });
            setAddError(`Could not move “${s.name}”. Check your signal.`);
          }
        });
      }

      stopMarkers.current.push(marker);
    });

    if (ride.destination?.lat != null && ride.destination?.lng != null) {
      stopMarkers.current.push(new google.maps.Marker({
        map, position: { lat: ride.destination.lat, lng: ride.destination.lng },
        title: ride.destination.name,
        zIndex: 150,
        icon: {
          url: destinationPin(),
          scaledSize: new google.maps.Size(PIN_PX, PIN_PX),
          anchor: new google.maps.Point(PIN_ANCHOR.destination.x, PIN_ANCHOR.destination.y),
        },
      }));
    }
  }, [ride, mapReady, rideId, qc, nextStop?.id,
      stops.map(s => `${s.id}:${s.lat},${s.lng},${s.reached_at}`).join(' | ')]);

  // ── Route drawing ───────────────────────────────────────────
  /**
   * Draws the entire remaining journey: the leg being ridden in bright orange, and every
   * leg after it dimmed. The rider sees the whole route to the final destination, not
   * just the next hop, while still knowing which part is live.
   */
  const drawPlan = useCallback((r: RouteResult) => {
    const map = mapRef.current;
    if (!map) return;

    const toPath = (g: [number, number][]) => g.map(([lng, lat]) => ({ lat, lng }));
    const first = r.legs?.[0]?.geometry?.length ? r.legs[0].geometry : r.geometry;
    const rest = (r.legs ?? []).slice(1).flatMap(l => l.geometry);

    if (!activeLine.current) {
      activeLine.current = new google.maps.Polyline({
        map, path: toPath(first), zIndex: 20,
        strokeColor: '#f97316', strokeOpacity: 0.95, strokeWeight: 7,
      });
    } else {
      activeLine.current.setPath(toPath(first));
    }

    if (!aheadLine.current) {
      aheadLine.current = new google.maps.Polyline({
        map, path: toPath(rest), zIndex: 10,
        strokeColor: '#f97316', strokeOpacity: 0.35, strokeWeight: 5,
      });
    } else {
      aheadLine.current.setPath(toPath(rest));
    }
  }, []);

  const requestRoute = useCallback(async () => {
    // Before the ride starts there is no "here" that matters — plan from the start point
    // the rider chose, so the planned route is the one they will actually be given.
    const origin = ride?.status === 'planned' && ride.start_location?.lat != null
      ? { lat: ride.start_location.lat, lng: ride.start_location.lng! }
      : pos ? { lat: pos.lat, lng: pos.lng } : null;

    if (!origin || remainingPoints.length === 0) return;
    setRouting(true);
    try {
      const last = remainingPoints[remainingPoints.length - 1];
      const via = remainingPoints.slice(0, -1)
        .filter(s => s.lat != null && s.lng != null)
        .map(s => ({ lat: s.lat!, lng: s.lng! }));

      // One call covers the whole journey — geometry, per-leg totals and turn steps,
      // plus every other way round when the route has no stops in between.
      const r = await api.post<RouteResult>('/routing/route', {
        from: origin,
        to: { lat: last.lat, lng: last.lng },
        ...(via.length ? { via } : {}),
        mode: routeMode,
        alternatives: true,
      });

      // The backend sorts fastest first, so index 0 is the default selection.
      setAlternatives(r.alternatives ?? []);
      setAltNote(r.alternatives_note ?? '');
      setChosenAlt(0);
      declined.current.clear();

      setPlan(r);
      setRoute(r);
      drawPlan(r);
    } catch (e) {
      console.error('Routing failed', e);
    } finally {
      setRouting(false);
    }
  }, [pos, remainingPointsKey, drawPlan, routeMode,
      ride?.status, ride?.start_location?.lat, ride?.start_location?.lng]);

  /** Switch to one of the offered ways round without re-asking Google. */
  const pickAlternative = useCallback((i: number) => {
    const r = alternatives[i];
    if (!r) return;
    setChosenAlt(i);
    setPlan(r);
    setRoute(r);
    drawPlan(r);
    setShowRoutes(false);
  }, [alternatives, drawPlan]);

  const planningOnly = ride?.status === 'planned';

  // Route once, then only when the rider strays off the drawn line. A planned ride draws
  // its route without waiting for a GPS fix — you plan indoors.
  useEffect(() => {
    if (!mapReady || remainingPoints.length === 0) return;
    if (!plan) {
      if (pos || planningOnly) void requestRoute();
      return;
    }
    if (!pos || planningOnly) return;
    if (plan.geometry.length && metresFromLine(pos, plan.geometry) >REROUTE_AFTER_M) {
      void requestRoute();
    }
  }, [pos, mapReady, plan, requestRoute, remainingPoints.length, planningOnly]);

  /**
   * Watch for a quicker way round while riding.
   *
   * Google is asked again every couple of minutes for the road ahead, and if one of the
   * ways back is meaningfully quicker than the one being ridden, the rider is offered the
   * switch — they decide, the app never silently reroutes them.
   *
   * The check is deliberately conservative: traffic-aware ETAs wobble by tens of seconds
   * on their own, so a saving has to clear a real threshold before it is worth a prompt
   * at 80 km/h. Anything declined is remembered so the same road is not offered on a loop.
   */
  const MIN_SAVING_S = 150;        // ~2½ minutes
  const BETTER_CHECK_MS = 120_000; // every two minutes

  useEffect(() => {
    if (!navMode || !pos || ride?.status !== 'active' || !plan || plan.approximate) return;
    if (remainingPoints.length === 0) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      if (!navigator.onLine || betterRoute) return;
      const here = posRef.current;
      if (!here) return;

      // Alternatives only come back for a route with no stops in between, so the check
      // runs against the current leg — which is where a detour would actually help.
      const target = remainingPoints[0];
      if (target?.lat == null) return;

      try {
        const r = await api.post<RouteResult>('/routing/route', {
          from: { lat: here.lat, lng: here.lng },
          to: { lat: target.lat, lng: target.lng },
          mode: routeMode,
          alternatives: true,
        });
        if (cancelled || !r.alternatives?.length) return;

        // Compare like with like: the same leg on the route currently being ridden.
        const currentLeg = plan.legs?.[0]?.duration_s ?? plan.duration_s;
        const best = r.alternatives[0];
        const saves = currentLeg - best.duration_s;
        const id = best.summary ?? String(Math.round(best.distance_m));

        if (saves >= MIN_SAVING_S && !declined.current.has(id)) {
          setBetterRoute({ route: best, saves_s: saves });
        }
      } catch { /* a failed check is not worth telling the rider about */ }
    }, BETTER_CHECK_MS);

    return () => { cancelled = true; clearInterval(timer); };
  }, [navMode, ride?.status, plan, routeMode, remainingPointsKey, betterRoute]);

  /** Take the quicker road — redraw and carry on, the way a nav app does. */
  function acceptBetterRoute() {
    if (!betterRoute) return;
    setPlan(betterRoute.route);
    setRoute(betterRoute.route);
    drawPlan(betterRoute.route);
    announced.current.clear();   // the turns are different now
    setBetterRoute(null);
    if (voice) speak('Taking the faster route');
  }

  function declineBetterRoute() {
    if (!betterRoute) return;
    declined.current.add(betterRoute.route.summary ?? String(Math.round(betterRoute.route.distance_m)));
    setBetterRoute(null);
  }

  // Frame the whole planned route, since there is no rider position to follow yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !planningOnly || !plan?.geometry?.length) return;
    const bounds = new google.maps.LatLngBounds();
    plan.geometry.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    map.fitBounds(bounds, 48);
  }, [mapReady, planningOnly, plan?.geometry]);

  // The route changes shape when a stop is reached or added — redraw from scratch.
  useEffect(() => {
    setPlan(null);
    setRoute(null);
    activeLine.current?.setPath([]);
    aheadLine.current?.setPath([]);
  }, [remainingPointsKey]);

  // ── Arrival ─────────────────────────────────────────────────
  const distanceToTarget = pos && targetHasCoords && target
    ? metresBetween(pos, { lat: target.lat!, lng: target.lng! }) : null;

  useEffect(() => {
    if (!nextStop || distanceToTarget == null || ride?.status !== 'active') return;
    if (distanceToTarget >ARRIVE_RADIUS_M) return;
    (async () => {
      try {
        await api.post(`/rides/${rideId}/stops/${nextStop.id}/reached`, {});
        qc.invalidateQueries({ queryKey: ['ride', rideId] });
        if (voice) speak(`Arrived at ${nextStop.name}`);
      } catch { /* retries on the next fix */ }
    })();
  }, [distanceToTarget, nextStop?.id, ride?.status, rideId, voice, qc]);

  /** Cumulative distance and time to each remaining waypoint. */
  const itinerary = remainingPoints.map((s, i) => {
    const legs = plan?.legs ?? [];
    const upTo = legs.slice(0, i + 1);
    const haveAll = legs.length >= i + 1;
    const straight = pos && s.lat != null
      ? metresBetween(pos, { lat: s.lat, lng: s.lng! })
      : null;
    return {
      stop: s,
      distance_m: haveAll ? upTo.reduce((a, l) => a + l.distance_m, 0) : straight,
      duration_s: haveAll ? upTo.reduce((a, l) => a + l.duration_s, 0) : null,
      exact: haveAll && !plan?.approximate,
    };
  });

  /**
   * Every stop, numbered by its place in the ride — the same number its map pin carries.
   * Stops with no coordinates are listed too, flagged, rather than silently dropped the
   * way the routing list has to drop them.
   */
  const legInfo = new Map(itinerary.map(it => [it.stop.id, it]));
  const stopRows: StopRow[] = stops.map((s, i) => {
    const info = legInfo.get(s.id);
    return {
      stop: s,
      seq: i + 1,
      isNext: s.id === nextStop?.id,
      distance_m: info?.distance_m ?? null,
      duration_s: info?.duration_s ?? null,
      exact: info?.exact ?? false,
    };
  });

  const stopsEditable = ride?.status !== 'completed' && ride?.status !== 'cancelled';

  /**
   * Everywhere the rider might want to search from: where they are, each stop on the
   * route, the final destination, and the whole road ahead. Offered as one list so
   * "fuel near tonight's hotel" is the same two taps as "fuel near me".
   */
  const findScopes: FindScope[] = [
    {
      id: 'me',
      label: 'Near me',
      icon: '',
      at: pos ? { lat: pos.lat, lng: pos.lng } : null,
      disabled: pos ? undefined : 'No GPS fix yet.',
    },
    {
      id: 'route',
      label: 'Along the route',
      icon: '',
      points: (plan?.geometry ?? pack?.route?.geometry ?? []).map(([lng, lat]) => ({ lat, lng })),
      disabled: (plan?.geometry?.length ?? pack?.route?.geometry?.length)
        ? undefined
        : 'No route drawn yet.',
    },
    ...stops.map((s, i) => ({
      id: s.id,
      label: `${i + 1}. ${s.name}`,
      icon: stopMeta(s.kind).icon,
      at: s.lat != null ? { lat: s.lat, lng: s.lng! } : null,
      disabled: s.lat != null ? undefined : 'This stop has no position yet.',
    })),
    ...(ride?.destination?.name ? [{
      id: 'dest',
      label: ride.destination.name,
      icon: '',
      at: ride.destination.lat != null
        ? { lat: ride.destination.lat, lng: ride.destination.lng! } : null,
      disabled: ride.destination.lat != null ? undefined : 'The destination has no position.',
    }] : []),
  ];

  /** Persist a new order, then let the route redraw around it. */
  async function reorderStops(ids: string[]) {
    setStopsBusy(true); setAddError('');
    try {
      await api.put(`/rides/${rideId}/stops/reorder`, { order: ids });
      await qc.invalidateQueries({ queryKey: ['ride', rideId] });
    } catch (e: any) {
      setAddError(e.message || 'Could not save the new order.');
    } finally {
      setStopsBusy(false);
    }
  }

  // ── The others on the ride ──────────────────────────────────
  /**
   * Where everyone else is.
   *
   * Polled rather than pushed: a socket for a handful of club riders is a lot of moving
   * parts for something a request every ten seconds answers just as well, and polling
   * survives the patchy signal these rides actually happen in. Only asked for on a
   * shared ride that is under way.
   */
  const sharedRide = ride?.ride_type !== 'solo' && (ride?.member_ids?.length ?? 0) > 1;

  const { data: liveRiders } = useQuery<{ riders: LiveRider[] }>({
    queryKey: ['ride-live', rideId],
    queryFn: () => api.get(`/rides/${rideId}/live`),
    enabled: Boolean(rideId) && sharedRide && ride?.status === 'active' && online,
    refetchInterval: 10000,
  });

  /**
   * Draw the others as a coloured disc bearing the first letter of their name.
   *
   * Deliberately not the vehicle avatar: that one means *you*. A rider glancing down has
   * to tell their own heading apart from everyone else's position instantly, and giving
   * the group the same arrow would make that a reading exercise at 80 km/h.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const riders = liveRiders?.riders ?? [];
    const seen = new Set(riders.map(r => r.user_id));

    // Anyone who dropped out stops being drawn.
    for (const [id, marker] of riderMarkers.current) {
      if (!seen.has(id)) { marker.setMap(null); riderMarkers.current.delete(id); }
    }

    for (const r of riders) {
      const icon = {
        url: riderBadge(r.name, r.colour),
        scaledSize: new google.maps.Size(BADGE_PX, BADGE_PX),
        anchor: new google.maps.Point(BADGE_PX / 2, BADGE_PX / 2),
      };
      const existing = riderMarkers.current.get(r.user_id);
      if (existing) {
        existing.setPosition({ lat: r.lat, lng: r.lng });
        existing.setIcon(icon);
      } else {
        riderMarkers.current.set(r.user_id, new google.maps.Marker({
          map, position: { lat: r.lat, lng: r.lng }, zIndex: 800,
          title: `${r.name}${r.speed ? ` — ${Math.round(r.speed)} km/h` : ''}`,
          icon,
        }));
      }
    }
  }, [liveRiders, mapReady]);

  // Clear the group when leaving the screen.
  useEffect(() => () => {
    riderMarkers.current.forEach(m => m.setMap(null));
    riderMarkers.current.clear();
  }, []);

  // ── Offline ride pack ───────────────────────────────────────
  // Show what is already saved, so the button can say "saved" rather than lie.
  useEffect(() => {
    if (!rideId) return;
    loadPack(rideId).then(p => setPack(p ?? null)).catch(() => setPack(null));
  }, [rideId]);

  // With no network the tiles will never paint; swap to the cached-route canvas rather
  // than leaving the rider staring at a grey rectangle.
  useEffect(() => {
    setTilesDown(!online && !!pack);
  }, [online, pack]);

  /**
   * A finished ride does not need its offline copy any more — clear it the moment the
   * ride ends, rather than leaving the largest thing we store on the phone for good.
   * The GPS queue is flushed first, so nothing unsent is thrown away with it.
   */
  useEffect(() => {
    if (!rideId || !pack) return;
    if (ride?.status !== 'completed' && ride?.status !== 'cancelled') return;

    (async () => {
      await flush(true);   // hand over anything still owed before letting go of it

      // Whatever is left is unsent. Keep it — the route pack is what we came to free.
      const stillOwed = await queuedFixes(rideId).catch(() => []);
      const { keptFixes } = await releaseRide(rideId, { discardQueue: stillOwed.length === 0 });

      setPack(null);
      setTilesDown(false);
      setPackMsg(keptFixes >0
        ? `Ride ${ride.status} — offline copy removed (${fmtBytes(pack.sizeBytes)} freed). `
          + `${keptFixes} GPS points are still waiting for signal and have been kept.`
        : `Ride ${ride.status} — the offline copy (${fmtBytes(pack.sizeBytes)}) has been removed.`);
    })();
  }, [ride?.status, rideId, pack, flush]);

  /**
   * Save everything needed to navigate this ride with no signal.
   *
   * Note what is absent: map tiles. Google's terms forbid downloading or storing their
   * imagery, so the honest offering is the route, the turns, the stops and the pumps —
   * driven by GPS, which needs no network at all.
   */
  async function saveForOffline() {
    if (!rideId || !ride) return;
    setSavingPack(true); setPackMsg('');

    try {
      await persistStorage();

      // Route the whole planned journey, not just what is left, so the pack stays useful
      // even if it is saved before setting off.
      let full: RouteResult | null = plan;
      const all = [
        ...(ride.start_location?.lat != null ? [ride.start_location] : []),
        ...stops.filter(s => s.lat != null),
        ...(ride.destination?.lat != null ? [ride.destination] : []),
      ];

      if (all.length >= 2) {
        try {
          full = await api.post<RouteResult>('/routing/route', {
            from: { lat: all[0].lat, lng: all[0].lng },
            to: { lat: all[all.length - 1].lat, lng: all[all.length - 1].lng },
            ...(all.length >2
              ? { via: all.slice(1, -1).map(s => ({ lat: s.lat!, lng: s.lng! })) }
              : {}),
          });
        } catch {
          full = plan;   // fall back to whatever is already drawn
        }
      }

      // Pumps along the way, so a fuel search still works with no signal.
      let pois: Poi[] = [];
      if (full?.geometry?.length) {
        try {
          const r = await api.post<{ results: Poi[] }>('/places/along-route', {
            kind: 'fuel',
            points: full.geometry.map(([lng, lat]) => ({ lat, lng })),
            radius_m: 5000, spacing_m: 25000, max_anchors: 5,
          });
          pois = r.results;
        } catch { /* a pack without pumps is still worth having */ }
      }

      const saved = await savePack({ rideId, ride, route: full, pois, bounds: null });
      setPack(saved);
      setPackMsg(`Saved for offline — ${fmtBytes(saved.sizeBytes)}, ${pois.length} pumps, ${full?.steps?.length ?? 0} turns.`);
    } catch (e: any) {
      setPackMsg(e.message || 'Could not save for offline.');
    } finally {
      setSavingPack(false);
    }
  }

  async function clearPack() {
    if (!rideId) return;
    await deletePack(rideId);
    setPack(null);
    setPackMsg('Offline copy removed.');
  }

  // ── Adding a place found nearby as a stop ───────────────────
  async function addPoiAsStop(p: Poi, asKind: StopKind) {
    await api.post(`/rides/${rideId}/stops`, {
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      kind: asKind,
      planned_minutes: stopMeta(asKind).minutes,
      position: asKind === 'night' ? 'end' : 'next',
    });
    await qc.invalidateQueries({ queryKey: ['ride', rideId] });
    setShowItinerary(true);
  }

  /** Change what an existing stop is for — and its time there. */
  async function setStopKind(id: string, kind: StopKind) {
    setStopsBusy(true); setAddError('');
    try {
      await api.patch(`/rides/${rideId}/stops/${id}`, {
        kind, planned_minutes: stopMeta(kind).minutes,
      });
      await qc.invalidateQueries({ queryKey: ['ride', rideId] });
    } catch (e: any) {
      setAddError(e.message || 'Could not change the stop type.');
    } finally {
      setStopsBusy(false);
    }
  }

  /**
   * Force the screen sideways for a wide view of the road ahead, and back again.
   *
   * Browsers only permit an orientation lock in fullscreen, and some refuse entirely, so
   * a refusal is reported rather than silently swallowed.
   */
  async function toggleRotation() {
    setRotateNote('');
    if (rotated) {
      await unlockOrientation();
      setRotated(false);
      return;
    }
    const r = await lockOrientation(mapDiv.current?.parentElement ?? null,
      isLandscape() ? 'portrait' : 'landscape');
    if (r.ok) setRotated(true);
    else setRotateNote(r.reason);
  }

  // Leaving fullscreen by the phone back gesture must not leave the button lying.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setRotated(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /** Set off without leaving the map the route was planned on. */
  async function startRide() {
    setStarting(true); setAddError('');
    try {
      await api.post(`/rides/${rideId}/start`, {});
      await qc.invalidateQueries({ queryKey: ['ride', rideId] });
      await qc.invalidateQueries({ queryKey: ['rides'] });
    } catch (e: any) {
      setAddError(e.message || 'Could not start the ride.');
    } finally {
      setStarting(false);
    }
  }

  async function deleteStop(id: string) {
    setStopsBusy(true); setAddError('');
    try {
      await api.delete(`/rides/${rideId}/stops/${id}`);
      await qc.invalidateQueries({ queryKey: ['ride', rideId] });
    } catch (e: any) {
      setAddError(e.message || 'Could not remove that stop.');
    } finally {
      setStopsBusy(false);
    }
  }

  async function submitStop() {
    if (!newStop?.name.trim()) { setAddError('Give the stop a name.'); return; }
    setAddingStop(true); setAddError('');
    try {
      await api.post(`/rides/${rideId}/stops`, {
        name: newStop.name.trim(),
        lat: newStop.lat ?? null,
        lng: newStop.lng ?? null,
        kind: newStopKind,
        planned_minutes: newStopMinutes ?? stopMeta(newStopKind).minutes,
        position: stopPosition,
      });
      await qc.invalidateQueries({ queryKey: ['ride', rideId] });
      setShowAddStop(false);
      setNewStop(null);
      setStopPosition('next');
      setPinnedByHand(false);
      setNewStopKind('break');
      setNewStopMinutes(null);
      // Show the rider where it landed in the sequence.
      setShowItinerary(true);
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAddingStop(false);
    }
  }

  /**
   * Drop a stop exactly where the rider is standing, naming it from the map so they do
   * not have to type while stopped at the roadside.
   */
  async function addStopHere() {
    if (!pos) { setAddError('No GPS fix yet.'); return; }
    setStopPosition('next');
    setAddError('');
    setPinnedByHand(true);
    setNewStop({ name: '', lat: pos.lat, lng: pos.lng });
    setShowAddStop(true);
    await nameFromMap(pos.lat, pos.lng);
  }

  /** Ask the server what a coordinate is called, and pre-fill the name. */
  async function nameFromMap(lat: number, lng: number) {
    setResolvingPin(true);
    try {
      const r = await api.get<{ name: string; address: string }>(
        `/places/reverse?lat=${lat}&lng=${lng}`
      );
      setNewStop({ name: r.name || '', lat, lng });
    } catch {
      setNewStop({ name: '', lat, lng });
    } finally {
      setResolvingPin(false);
    }
  }

  // ── Turn-by-turn tracking ───────────────────────────────────
  /**
   * The manoeuvre being ridden toward: the first step whose end point is still ahead.
   * Steps are consumed as they are passed, which is what makes the banner advance the
   * way a nav app does.
   */
  const currentStep = (() => {
    if (!pos || !plan?.legs?.length) return null;
    for (const leg of plan.legs) {
      for (const step of leg.steps) {
        if (!step.end) continue;
        const d = metresBetween(pos, step.end);
        // Treat a manoeuvre as passed once inside 40 m of its end point.
        if (d >40) return { step, distance_m: d };
      }
    }
    // Every manoeuvre passed — the remaining instruction is the arrival itself.
    const lastLeg = plan.legs[plan.legs.length - 1];
    const last = lastLeg?.steps[lastLeg.steps.length - 1];
    return last ? { step: last, distance_m: distanceToTarget ?? 0 } : null;
  })();

  /** Announce a turn once when it comes into range, and again just before it. */
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!voice || !navMode || !currentStep) return;
    const { step, distance_m } = currentStep;
    const band = distance_m <= 80 ? 'now' : distance_m <= 350 ? 'soon' : null;
    if (!band) return;

    const key = `${step.instruction}:${band}`;
    if (announced.current.has(key)) return;
    announced.current.add(key);

    speak(band === 'now'? step.instruction
      : `In ${Math.round(distance_m / 50) * 50} metres, ${step.instruction}`);
  }, [voice, navMode, currentStep?.step.instruction, currentStep?.distance_m]);

  useEffect(() => { announced.current.clear(); }, [remainingPointsKey]);

  // ── Navigation camera ───────────────────────────────────────
  /**
   * How far down the screen the rider sits while navigating, as a fraction of height.
   *
   * Centring the rider wastes the top half on road already ridden. Every nav app puts
   * the vehicle low and gives the space to the road ahead; 0.72 is about where Google
   * Maps holds it.
   */
  const NAV_PUCK_Y = 0.72;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (navMode) {
      if (supportsHeading()) map.setTilt(45);
      map.setZoom(17.5);
    } else {
      if (supportsHeading()) { map.setTilt(0); map.setHeading(0); }
      map.setZoom(15);
    }
  }, [navMode, mapReady]);

  /**
   * Hold the rider still and slide the world underneath.
   *
   * Two things together produce the effect every rider expects from a nav app: the map
   * is rotated so the direction of travel is always up the screen, and the camera is
   * re-pinned to the rider on every fix. Because the rider never moves relative to the
   * screen, it reads as the map scrolling past a stationary vehicle rather than a dot
   * crawling over a static map.
   *
   * `panBy` after centring is what pushes the rider down to NAV_PUCK_Y — it works in
   * screen pixels, so it stays correct whatever heading the map is rotated to.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navMode || !follow || !pos || !mapReady) return;

    if (supportsHeading()) {
      // The device heading is the truth when moving; when stopped it is noise, so fall
      // back to the bearing toward the next manoeuvre.
      const moving = (pos.speed ?? 0) >3;
      const h = (moving ? pos.heading : null)
        ?? (currentStep?.step.end ? bearing(pos, currentStep.step.end) : null)
        ?? pos.heading;
      if (h != null) map.setHeading(h);
    }

    map.setCenter({ lat: pos.lat, lng: pos.lng });
    const h = mapDiv.current?.clientHeight ?? 0;
    if (h) map.panBy(0, -Math.round(h * (NAV_PUCK_Y - 0.5)));
  }, [pos, navMode, follow, mapReady, currentStep?.step.end, facing]);

  // ── Tap the map to place a stop ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    map.setOptions({ draggableCursor: pickingOnMap ? 'crosshair' : undefined });
    if (!pickingOnMap) return;

    const listener = map.addListener('click', async (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const lat = e.latLng.lat(), lng = e.latLng.lng();

      pinMarker.current?.setMap(null);
      pinMarker.current = new google.maps.Marker({
        map, position: { lat, lng }, zIndex: 500,
        icon: {
          url: dropPin(),
          scaledSize: new google.maps.Size(PIN_PX, PIN_PX),
          anchor: new google.maps.Point(PIN_ANCHOR.drop.x, PIN_ANCHOR.drop.y),
        },
      });

      setPickingOnMap(false);
      setShowAddStop(true);
      setPinnedByHand(true);
      await nameFromMap(lat, lng);
    });

    return () => google.maps.event.removeListener(listener);
  }, [pickingOnMap, mapReady]);

  // Clear the temporary pin once the stop is saved or abandoned.
  useEffect(() => {
    if (!showAddStop && !pickingOnMap) {
      pinMarker.current?.setMap(null);
      pinMarker.current = null;
    }
  }, [showAddStop, pickingOnMap]);

  function speak(text: string) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch { /* unsupported */ }
  }


  // ── Readouts ────────────────────────────────────────────────
  const legMetres = route?.distance_m ?? distanceToTarget ?? 0;
  const etaSeconds = route && !route.approximate
    ? route.duration_s
    : distanceToTarget != null && pos?.speed && pos.speed >5
      ? distanceToTarget / (pos.speed / 3.6)
      : distanceToTarget != null ? distanceToTarget / (40 / 3.6) : 0;

  const remaining = stops.filter(s => !s.reached_at).length;
  const done = stops.length - remaining;
  const progress = stops.length ? done / stops.length : 0;
  const dirDeg = pos && targetHasCoords && target ? bearing(pos, { lat: target.lat!, lng: target.lng! }) : null;

  return (
    <div className="relative w-full h-full">
      <div ref={mapDiv} className="absolute inset-0 w-full h-full bg-surface" />

      {/* No signal, but a saved pack: draw the route ourselves rather than show dead tiles */}
      {tilesDown && (
        <OfflineRouteCanvas
          route={pack?.route ?? null}
          stops={stops}
          pois={pack?.pois}
          pos={pos}
          heading={navMode ? (pos?.heading ?? null) : null}
          followZoom={navMode ? 6 : 1}
        />
      )}

      {!mapReady && !mapError && !tilesDown && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center p-6 z-30">
          <div className="bg-surface border border-danger rounded-2xl p-5 max-w-sm text-center flex flex-col gap-3">
            <p className="text-3xl"></p>
            <p className="text-ink font-semibold">Map could not load</p>
            <p className="text-muted text-sm">{mapError}</p>
            <p className="text-muted text-xs">Navigation below still works — distance, direction and stops come from GPS, not the map.
            </p>
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </div>
        </div>
      )}

      {/* Turn banner — replaces the top bar while navigating, the way a nav app does */}
      {navMode && currentStep && (
        <div className="absolute top-0 left-0 right-0 z-30 bg-accent text-accent-ink safe-top shadow-lg">
          <div className="px-4 py-3 flex items-center gap-3">
            {/* The drawn arrow and the distance to it, side by side — the two things a
                rider needs at a glance. Black on the orange, which reads far better than
                white in daylight. */}
            <ManeuverIcon maneuver={currentStep.step.maneuver} size={40} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-2xl font-black tabular-nums leading-none">
                {fmtDistance(currentStep.distance_m)}
              </p>
              <p className="text-sm leading-tight mt-1 line-clamp-2 font-medium">
                {currentStep.step.instruction}
              </p>
            </div>
            <button onClick={() => setNavMode(false)} aria-label="Exit navigation"
                    className="btn3d btn3d-surface w-10 h-10 rounded-xl bg-black/25 hover:bg-black/40 flex items-center
                               justify-center flex-shrink-0 transition-colors active:scale-90">
              <Icon name="close" size={19} />
            </button>
          </div>
        </div>
      )}

      {/* Top bar — RIDE MODE, deliberately sparse */}
      <div className={`absolute top-0 left-0 right-0 z-20 flex items-center gap-1.5 px-2 py-2
                       bg-surface/90 backdrop-blur border-b border-border safe-top
                       ${navMode ? 'hidden' : ''}`}>
        {/* Flush the GPS queue on the way out, so leaving never loses the trail */}
        <IconButton icon="back" label="Back to ride"
                    onClick={() => { void flush(true); navigate(`/rides/${rideId}`); }} />
        <div className="btn3d btn3d-surface flex-1 min-w-0 bg-surface2 border border-border
                        rounded-xl px-3 py-1.5 text-center">
          <p className="text-ink font-bold text-sm truncate">{ride?.name ?? 'Ride'}</p>
          <p className="text-muted text-[11px] truncate">
            {ride?.status === 'active' ? ' Riding' : ride?.status === 'paused' ? 'Paused' : ride?.status}
            {!online && ' · offline'}
            {synced === 'pending' && ' · saving…'}
            {synced === 'failed' && ' · will retry'}
            {synced === 'synced' && ' · saved'}
            {/* Without a compass the avatar can only face the way you last moved. */}
            {!compassOk && ' · no compass'}
            {sharedRide && liveRiders?.riders?.length
              ? ` · ${liveRiders.riders.length} riding with you`
              : ''}
          </p>
        </div>
        <button onClick={() => setVoice(v => !v)}
                aria-label="Toggle voice guidance" aria-pressed={voice}
                className={`btn3d btn3d-accent h-10 px-3 rounded-xl text-xs font-semibold flex items-center justify-center
                            flex-shrink-0 transition-all active:scale-90 border ${
                  voice ? 'bg-accent border-accent text-accent-ink': 'bg-surface2 border-border text-muted'}`}>
          {voice ? 'Voice on' : 'Voice off'}
        </button>
        {/* Turn the phone sideways for a wider view of the road ahead */}
        <button onClick={() => void toggleRotation()}
                aria-label="Rotate the screen" aria-pressed={rotated}
                className={`btn3d btn3d-accent h-10 px-3 rounded-xl text-xs font-semibold flex items-center justify-center
                            flex-shrink-0 transition-all active:scale-90 border ${
                  rotated ? 'bg-accent border-accent text-accent-ink': 'bg-surface2 border-border text-muted'}`}>Rotate
        </button>
      </div>

      {rotateNote && (
        <div className="absolute top-16 left-3 right-3 z-30 bg-surface border border-border
                        rounded-xl px-3 py-2 flex items-center gap-2">
          <p className="text-muted text-xs flex-1">{rotateNote}</p>
          <button onClick={() => setRotateNote('')} className="text-muted text-xs px-1">Dismiss</button>
        </div>
      )}

      {gpsError && (
        <div className="absolute top-16 left-3 right-3 z-20 bg-danger/90 text-ink text-xs rounded-xl px-3 py-2">
          {gpsError}
        </div>
      )}

      {!online && (
        <div className={`absolute top-16 left-3 right-3 z-20 text-xs rounded-xl px-3 py-2 ${
          tilesDown ? 'bg-indigo-500/90 text-ink' : 'bg-yellow-500/90 text-black'}`}>
          {tilesDown
            ? ` Offline — navigating from the saved route. Turns, stops and distance all work.${
                queuedCount ? ` ${queuedCount} GPS points held.` : ''}`
            : `No signal — the map cannot refresh, but GPS, distance and stops keep working.${
                pack ? '' : ' Save this ride for offline next time.'}`}
        </div>
      )}

      {/* Map-picking overlay */}
      {pickingOnMap && (
        <div className="absolute top-0 left-0 right-0 z-30 bg-accent text-accent-ink safe-top shadow-lg">
          <div className="px-4 py-3 flex items-center gap-3">
            <span className="text-xl"></span>
            <p className="flex-1 text-sm font-semibold">Tap anywhere on the map to place the stop</p>
            <button onClick={() => { setPickingOnMap(false); setShowAddStop(true); }}
                    aria-label="Cancel picking on the map"
                    className="btn3d btn3d-surface w-9 h-9 rounded-xl bg-black/25 hover:bg-black/40 flex items-center
                               justify-center transition-colors active:scale-90">
              <Icon name="close" size={17} />
            </button>
          </div>
        </div>
      )}

      {/* Recentre, floating — appears only after the rider pans away while navigating */}
      {navMode && !follow && (
        <button
          onClick={() => { setFollow(true); if (pos) mapRef.current?.panTo({ lat: pos.lat, lng: pos.lng }); }}
          className="btn3d btn3d-surface absolute bottom-28 right-4 z-30 w-12 h-12 rounded-full bg-surface border border-accent text-accent shadow-lg flex items-center justify-center text-xl"
          aria-label="Recentre on my position"
        >
          ◎
        </button>
      )}

      {/* Compact nav bar — the only chrome while navigating */}
      {navMode && target && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-surface/95 backdrop-blur
                        border-t border-border safe-bottom">
          <div className="px-4 py-3 short:py-1.5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-ink font-bold text-lg leading-none tabular-nums">
                {fmtEta(plan?.duration_s ?? etaSeconds)}
              </p>
              <p className="text-muted text-xs mt-1">
                {fmtDistance(plan?.distance_m ?? legMetres)} left
                {' · arrive '}
                {new Date(Date.now() + (plan?.duration_s ?? etaSeconds) * 1000)
                  .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            {pos?.speed != null && (
              <div className="text-center flex-shrink-0">
                <p className="text-ink font-black text-xl leading-none tabular-nums">{Math.round(pos.speed)}</p>
                <p className="text-muted text-[10px]">km/h</p>
              </div>
            )}
            <Button size="sm" variant="outline" className="flex-shrink-0" onClick={() => setNavMode(false)}>Exit
            </Button>
          </div>
        </div>
      )}

      {/* A quicker way spotted mid-ride. The rider decides — never a silent reroute. */}
      {betterRoute && (
        <div className="absolute left-3 right-3 z-40 bottom-32 bg-surface border-2 border-accent
                        rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <span className="text-2xl flex-shrink-0"></span>
            <div className="flex-1 min-w-0">
              <p className="text-ink font-bold text-sm">Faster route — saves {fmtEta(betterRoute.saves_s)}
              </p>
              <p className="text-muted text-[11px] truncate">via {betterRoute.route.summary ?? 'another road'} ·{' '}
                {fmtDistance(betterRoute.route.distance_m)} · {fmtEta(betterRoute.route.duration_s)}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="flex-1" onClick={declineBetterRoute}>Stay on this one
            </Button>
            <Button size="sm" className="flex-1" onClick={acceptBetterRoute}>Take it
            </Button>
          </div>
        </div>
      )}

      {/* Navigation card */}
      {target && !navMode && (
        /*
         * Capped and scrollable, always.
         *
         * Anchored to the bottom with uncapped content, this panel grows upward off the
         * top of the screen — on a phone held sideways there is barely 400px of height,
         * so the route-profile chips and the top bar were being clipped away entirely
         * with no way to scroll to them. The cap leaves the top bar and a strip of map
         * visible, and anything that does not fit scrolls inside the panel instead of
         * escaping it.
         */
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-surface/95 backdrop-blur
                        border-t border-border safe-bottom
                        max-h-[62vh] short:max-h-[calc(100dvh-3.5rem)] overflow-y-auto scroll-y
                        overscroll-contain">
          <div className="p-3 short:p-2 flex flex-col gap-3 short:gap-2">

            {/* Which vehicle the roads are chosen for. Only the motorcycle profile
                changes what is legal to ride, which is the point of having it. */}
            {stopsEditable && (
              <div className="flex gap-2">
                {(['general', 'bike', 'car'] as RouteMode[]).map(m => (
                  <Chip key={m} selected={routeMode === m} className="flex-1 justify-center"
                        icon={ROUTE_MODE_META[m].icon}
                        onClick={() => { setRouteMode(m); setPlan(null); }}>
                    {ROUTE_MODE_META[m].label}
                  </Chip>
                ))}
              </div>
            )}
            {routeMode === 'bike' && (
              <p className="text-muted text-[10px] -mt-1.5">
                🏍️ Avoiding roads that bar two-wheelers.
              </p>
            )}

            <div className="flex items-center gap-3">
              {dirDeg != null && (
                <div className="w-12 h-12 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-2xl" style={{ transform: `rotate(${dirDeg}deg)`, display: 'inline-block' }}>↑</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-muted text-[10px] uppercase tracking-wider">
                  {nextStop ? `Next stop ${done + 1} of ${stops.length}` : 'Destination'}
                </p>
                <p className="text-ink font-bold truncate">{target.name}</p>
                {dirDeg != null && <p className="text-muted text-[11px]">Head {compassOf(dirDeg)}</p>}
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-2xl font-black text-ink tabular-nums leading-none">
                  {targetHasCoords ? fmtDistance(legMetres) : '—'}
                </p>
                <p className="text-muted text-[11px]">
                  {targetHasCoords ? fmtEta(etaSeconds) : 'no coordinates'}
                  {route?.traffic_aware && ' · live traffic'}
                </p>
              </div>
            </div>

            {/* Planning a ride that has not begun: the route is a proposal, and the only
                sensible primary action is to set off. */}
            {/* Every way round Google offered, quickest first and selected by default */}
            {alternatives.length >1 && (
              <div className="flex flex-col gap-1.5">
                <button onClick={() => setShowRoutes(v => !v)}
                        className="flex items-center justify-between text-left w-full">
                  <span className="text-muted text-[11px]">
                    {alternatives.length} ways round · on{' '}
                    <span className="text-ink">
                      {alternatives[chosenAlt]?.summary ?? `route ${chosenAlt + 1}`}
                    </span>
                    {chosenAlt === 0 && ' (quickest)'}
                  </span>
                  <span className="text-muted text-[11px]">{showRoutes ? 'Hide ▲' : 'Compare ▼'}</span>
                </button>

                {showRoutes && (
                  <div className="flex flex-col gap-1.5">
                    {alternatives.map((r, i) => {
                      const delta = r.duration_s - alternatives[0].duration_s;
                      return (
                        <button key={i} onClick={() => pickAlternative(i)}
                                className={`btn3d btn3d-accent flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
                                  i === chosenAlt
                                    ? 'bg-accent/10 border-accent': 'bg-surface2 border-border hover:border-accent/40'}`}>
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                            i === chosenAlt ? 'bg-accent text-accent-ink' : 'bg-black/30 text-muted'}`}>
                            {i === chosenAlt
                              ? <Icon name="check" size={12} strokeWidth={3} />
                              : <span className="text-[10px] font-bold">{i + 1}</span>}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-ink text-xs truncate">
                              {r.summary ?? `Route ${i + 1}`}
                            </span>
                            <span className="block text-muted text-[10px] tabular-nums">
                              {fmtDistance(r.distance_m)}
                              {i === 0
                                ? ' · quickest': delta >0 ? ` · ${fmtEta(delta)} slower` : ''}
                            </span>
                          </span>
                          <span className="text-ink text-sm font-bold tabular-nums flex-shrink-0">
                            {fmtEta(r.duration_s)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {alternatives.length <= 1 && altNote && (
              <p className="text-muted text-[10px]">{altNote}</p>
            )}

            {planningOnly ? (
              <>
                {plan && (
                  <p className="text-muted text-[11px]">Planned route · {fmtDistance(plan.distance_m)} · {fmtEta(plan.duration_s)}
                    {plan.approximate ? ' (straight-line estimate)' : ''}
                  </p>
                )}
                <Button fullWidth loading={starting} onClick={startRide}>Start this ride</Button>
                <p className="text-muted text-[10px]">Add stops, drag the pins and reorder the list — then start when you are ready.
                </p>
              </>
            ) : null}

            {!navMode && currentStep?.step.instruction && (
              <div className="bg-surface2 rounded-xl px-3 py-2 flex items-center gap-3">
                <ManeuverIcon maneuver={currentStep.step.maneuver} size={22} className="text-accent" />
                <p className="text-ink text-sm flex-1">{currentStep.step.instruction}</p>
                <span className="text-muted text-xs tabular-nums">{fmtDistance(currentStep.distance_m)}</span>
              </div>
            )}

            {route?.approximate && route.note && (
              <p className="text-muted text-[11px]"> {route.note}</p>
            )}

            {!targetHasCoords && (
              <p className="text-muted text-[11px]">
                “{target.name}” has no position. Edit the ride and search for it so navigation can route there.
              </p>
            )}

            {stops.length >0 && (
              <div className="flex flex-col gap-1">
                <div className="h-1.5 rounded-full bg-surface2 overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
                </div>
                <p className="text-muted text-[10px]">
                  {done} of {stops.length} stops reached
                  {pos?.accuracy != null && ` · GPS ±${pos.accuracy} m`}
                  {pos?.speed != null && pos.speed >0 && ` · ${Math.round(pos.speed)} km/h`}
                </p>
              </div>
            )}

            {/* The stop list — numbered, draggable, matching the pins on the map */}
            {stops.length >0 && (
              <button onClick={() => setShowItinerary(v => !v)}
                      className="flex items-center justify-between text-left w-full">
                <span className="text-muted text-[11px]">
                  {stops.length} {stops.length === 1 ? 'stop' : 'stops'}
                  {plan && ` · ${fmtDistance(plan.distance_m)} · ${fmtEta(plan.duration_s)} to go`}
                </span>
                <span className="text-muted text-[11px]">{showItinerary ? 'Hide ▲' : 'Edit ▼'}</span>
              </button>
            )}

            {showItinerary && (
              <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto scroll-y">
                <StopsEditor
                  rows={stopRows}
                  editable={stopsEditable}
                  busy={stopsBusy}
                  onReorder={reorderStops}
                  onDelete={deleteStop}
                  onKind={setStopKind}
                  // Open scoped to this stop, starting on whatever its kind implies —
                  // beds at a night stop — but every category stays one tap away.
                  onFindNearby={s => setFinder({
                    scopeId: s.id,
                    kind: (stopMeta(s.kind).suggests ?? 'fuel') as PoiKind,
                  })}
                  onLocate={s => {
                    setFollow(false);
                    mapRef.current?.panTo({ lat: s.lat!, lng: s.lng! });
                    mapRef.current?.setZoom(16);
                  }}
                />
                <p className="text-muted text-[10px] px-2">Drag ⠿ to reorder · drag a pin on the map to move a stop ·  changes what
                  a stop is for ·  finds beds or food around it.
                </p>
              </div>
            )}

            {movedStop && (
              <p className="text-green-400 text-[11px]">Moved “{movedStop}” — route updated.</p>
            )}
            {addError && !showAddStop && (
              <p className="text-danger text-[11px]">{addError}</p>
            )}

            {/* Start, Recentre and Re-route share one row — they are the three things a
                rider reaches for on the move, and stacking them pushed the map away. */}
            <div className="flex gap-2">
              {!navMode && plan && !plan.approximate && targetHasCoords && (
                <Button size="sm" className="flex-1"
                        onClick={async () => {
                          if (compassNeedsPermission() && !compassAsked) {
                            setCompassAsked(true);
                            await requestCompassPermission();
                          }
                          setNavMode(true); setFollow(true); setVoice(true);
                        }}>Start
                </Button>
              )}
              <Button size="sm" variant={follow ? 'primary' : 'outline'} className="flex-1"
                      onClick={() => {
                        setFollow(true);
                        if (pos) { mapRef.current?.panTo({ lat: pos.lat, lng: pos.lng }); mapRef.current?.setZoom(15); }
                      }}>Recentre
              </Button>
              <Button size="sm" variant="outline" className="flex-1" loading={routing}
                      onClick={() => void requestRoute()}>Re-route
              </Button>
              {nextStop && ride?.status === 'active' && (
                <Button size="sm" variant="secondary" className="flex-1"
                        onClick={async () => {
                          await api.post(`/rides/${rideId}/stops/${nextStop.id}/reached`, {});
                          qc.invalidateQueries({ queryKey: ['ride', rideId] });
                        }}>Reached
                </Button>
              )}
            </div>

            {/* Fuel, food and a bed — opens near the rider, switchable to any stop */}
            <div className="flex gap-2">
              {(['fuel', 'food', 'lodging'] as PoiKind[]).map(k => (
                <Button key={k} size="sm" variant="ghost" className="flex-1"
                        onClick={() => setFinder({
                          // Default to where they are; the sheet offers every stop too.
                          scopeId: pos ? 'me' : (nextStop?.lat != null ? nextStop.id : 'route'),
                          kind: k,
                        })}>
                  {POI_KIND_META[k].icon} {POI_KIND_META[k].label}
                </Button>
              ))}
            </div>

            {/* Offline readiness */}
            <div className="flex items-center gap-2">
              {pack ? (
                <>
                  <span className="text-green-400 text-[11px] flex-1">Saved offline · {fmtBytes(pack.sizeBytes)} · {pack.pois.length} pumps
                  </span>
                  <button onClick={() => void saveForOffline()} disabled={savingPack} className="text-muted text-[11px] underline px-1">Refresh</button>
                  <button onClick={() => void clearPack()} className="text-muted text-[11px] underline px-1">Remove</button>
                </>
              ) : (
                <Button size="sm" variant="ghost" className="flex-1" loading={savingPack}
                        onClick={() => void saveForOffline()}>Save for offline
                </Button>
              )}
            </div>
            {packMsg && <p className="text-muted text-[10px]">{packMsg}</p>}

            {/* One way in. The three ways of choosing a place live inside the sheet,
                which keeps the card readable with a glove on. */}
            {ride?.status !== 'completed' && ride?.status !== 'cancelled' && (
              <Button size="sm" fullWidth
                      onClick={() => {
                        setNewStop(null); setStopPosition('next');
                        setAddError(''); setPinnedByHand(false); setShowAddStop(true);
                      }}>Add stop
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Add a stop mid-ride */}
      <Modal open={showAddStop} onClose={() => setShowAddStop(false)} title="Add a Stop">
        <div className="flex flex-col gap-3">
          {/* Always searchable, however the modal was opened — pinning a position should
              never cost the rider place suggestions. */}
          <PlacePicker
            label="Where?"
            placeholder="Search a fuel pump, dhaba, viewpoint…"
            value={newStop}
            onChange={setNewStop}
            keepCoordsOnRename={pinnedByHand}
          />

          <StopKindPicker
            value={newStopKind}
            onChange={setNewStopKind}
            minutes={newStopMinutes}
            onMinutes={setNewStopMinutes}
          />

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void addStopHere()}
              disabled={!pos}
              title={pos ? 'Use where you are now' : 'No GPS fix yet'}
              className="btn3d btn3d-surface flex items-center justify-center gap-2 py-2.5 rounded-xl
                         border border-border bg-surface2 text-ink text-sm font-semibold
                         disabled:opacity-40 disabled:pointer-events-none"
            >Stop here
            </button>
            <button
              onClick={() => { setShowAddStop(false); setPickingOnMap(true); }}
              className="btn3d btn3d-surface flex items-center justify-center gap-2 py-2.5 rounded-xl
                         border border-border bg-surface2 text-ink text-sm font-semibold"
            >Pick on map
            </button>
          </div>

          {resolvingPin && (
            <p className="text-muted text-xs flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              Looking up what this place is called…
            </p>
          )}

          {!resolvingPin && newStop?.lat != null && (
            <p className="text-muted text-xs">Positioned at {newStop.lat.toFixed(4)}, {newStop.lng!.toFixed(4)}
              {!newStop.name.trim() && ' — give it a name'}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-muted">Where in the route?</p>
            <div className="flex gap-2">
              <Chip selected={stopPosition === 'next'} onClick={() => setStopPosition('next')}
                    className="flex-1 justify-center">Next — go here first
              </Chip>
              <Chip selected={stopPosition === 'end'} onClick={() => setStopPosition('end')}
                    className="flex-1 justify-center">Last — before the finish
              </Chip>
            </div>
          </div>

          {newStop?.lat == null && newStop?.name && (
            <p className="text-muted text-xs">This stop has no position, so it will show in the list but cannot be navigated to.
            </p>
          )}

          {addError && <p className="text-danger text-sm">{addError}</p>}

          <Button fullWidth loading={addingStop} disabled={!newStop?.name.trim()} onClick={() => void submitStop()}>Add Stop
          </Button>
        </div>
      </Modal>

      {/* Fuel, food and beds — near the rider, near any stop, or along the road ahead */}
      <NearbyFinder
        open={!!finder}
        onClose={() => setFinder(null)}
        scopes={findScopes}
        initialScopeId={finder?.scopeId}
        initialKind={finder?.kind ?? 'fuel'}
        onAdd={stopsEditable ? addPoiAsStop : undefined}
        onOpen={p => setOpenPoi(p)}
      />

      {/* The full card for one place: rating, photos, reviews, its page on Google */}
      <PlaceDetailSheet
        poi={openPoi}
        open={!!openPoi}
        onClose={() => setOpenPoi(null)}
        onAdd={stopsEditable ? addPoiAsStop : undefined}
      />
    </div>
  );
}
