import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Poi, PoiKind, StopKind } from '../../types';
import { Button, Modal, Chip, ChipRow } from '../ui';
import { POI_KIND_META } from '../../lib/stopKinds';

/** Somewhere the rider can search from. */
export interface FindScope {
  id: string;
  label: string;
  icon?: string;
  /** Search around a single point. */
  at?: { lat: number; lng: number } | null;
  /** Search along a line — takes precedence over `at` when both are given. */
  points?: { lat: number; lng: number }[] | null;
  /** Why this scope cannot be searched, if it cannot. */
  disabled?: string;
}

/**
 * Find fuel, food and a bed — around whichever point the rider picks.
 *
 * The two questions are separate and both stay changeable while the sheet is open:
 * *where* (near me, a particular stop, or anywhere along the road ahead) and *what*
 * (fuel, food, stay, and the occasional mechanic or hospital). Riders switch between
 * them constantly — "is there fuel near tonight's hotel?" is one tap from "is there
 * fuel near me?" — so neither is baked into how the sheet was opened.
 */
export default function NearbyFinder({
  open, onClose, scopes, initialScopeId, initialKind = 'fuel',
  kinds = ['fuel', 'food', 'lodging', 'mechanic', 'atm', 'hospital'],
  onAdd, addLabel = 'Add as stop', addKindFor, title, onOpen,
}: {
  /** Open the full card for a place — rating, photos, reviews, its Google page. */
  onOpen?: (poi: Poi) => void;
  open: boolean;
  onClose: () => void;
  scopes: FindScope[];
  initialScopeId?: string;
  initialKind?: PoiKind;
  kinds?: PoiKind[];
  onAdd?: (poi: Poi, asKind: StopKind, scope: FindScope) => Promise<void> | void;
  addLabel?: string;
  /** What kind of stop a chosen place becomes. Defaults by category. */
  addKindFor?: (kind: PoiKind) => StopKind;
  title?: string;
}) {
  const [scopeId, setScopeId] = useState(initialScopeId ?? scopes[0]?.id);
  const [kind, setKind] = useState<PoiKind>(initialKind);
  const [radiusKm, setRadiusKm] = useState(5);

  const [results, setResults] = useState<Poi[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  // Re-open from a different place — honour where the caller pointed us.
  useEffect(() => {
    if (!open) return;
    setScopeId(initialScopeId ?? scopes[0]?.id);
    setKind(initialKind);
    setAdded(new Set());
  }, [open, initialScopeId, initialKind]);

  const scope = scopes.find(s => s.id === scopeId) ?? scopes[0];
  const meta = POI_KIND_META[kind];

  /*
   * Where this search is anchored — captured once, then held.
   *
   * "Near me" follows a live GPS watch, and on a phone that reports a slightly different
   * position every second even standing still. Following it meant the effect below
   * re-ran on every tick: it clears the list and shows the spinner before each fetch, so
   * the sheet visibly blinked and results reshuffled under the rider's thumb while they
   * were trying to tap one.
   *
   * Holding the anchor also matches what the rider is doing. They open the sheet to read
   * a list and pick a place; a list that keeps changing is worse, not fresher. "Search
   * again" below re-anchors on demand for anyone who has genuinely moved on.
   */
  const [anchor, setAnchor] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => { setAnchor(null); }, [open, scopeId]);
  useEffect(() => {
    if (!open || anchor || !scope?.at) return;
    setAnchor({ lat: scope.at.lat, lng: scope.at.lng });
  }, [open, anchor, scope?.at?.lat, scope?.at?.lng]);

  useEffect(() => {
    if (!open || !scope) return;
    if (scope.disabled) { setResults([]); setError(scope.disabled); return; }
    // A point scope with no anchor yet is simply waiting for its first fix.
    if (!scope.points?.length && !anchor) return;

    let cancelled = false;
    (async () => {
      setLoading(true); setError(''); setResults([]);
      try {
        const alongRoute = !!scope.points?.length;
        const body = alongRoute
          ? { kind, points: scope.points, radius_m: radiusKm * 1000, spacing_m: 25000, max_anchors: 5 }
          : anchor
            ? { kind, lat: anchor.lat, lng: anchor.lng, radius_m: radiusKm * 1000 }
            : null;

        if (!body) { setError('No position to search around yet.'); return; }

        const r = await api.post<{ results: Poi[] }>(
          alongRoute ? '/places/along-route' : '/places/nearby', body);
        if (!cancelled) setResults(r.results);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Search failed. Check your signal.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // Deliberately keyed on the held anchor, never on scope.at: the live position
    // changes every second and re-running on it is what made the sheet blink.
  }, [open, kind, radiusKm, scopeId, anchor?.lat, anchor?.lng, scope?.points?.length]);

  async function add(p: Poi) {
    if (!onAdd || !scope) return;
    setAdding(p.id);
    try {
      await onAdd(p, addKindFor?.(kind) ?? defaultStopKind(kind), scope);
      setAdded(s => new Set(s).add(p.id));
    } catch (e: any) {
      setError(e.message || 'Could not add that.');
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title ?? 'Find along the way'}>
      <div className="flex flex-col gap-3">

        {/* Where to look */}
        <ChipRow label="Search near">
          {scopes.map(s => (
            <Chip key={s.id} selected={s.id === scopeId} onClick={() => setScopeId(s.id)}
                  disabled={!!s.disabled} title={s.disabled} icon={s.icon}>
              {s.label}
            </Chip>
          ))}
        </ChipRow>

        {/* What to look for */}
        <ChipRow label="Looking for">
          {kinds.map(k => (
            <Chip key={k} selected={k === kind} onClick={() => setKind(k)} icon={POI_KIND_META[k].icon}>
              {POI_KIND_META[k].label}
            </Chip>
          ))}
        </ChipRow>

        <ChipRow label="Within">
          {[2, 5, 10, 25].map(km => (
            <Chip key={km} selected={radiusKm === km} onClick={() => setRadiusKm(km)}>
              {km} km
            </Chip>
          ))}
          {/* The anchor is held while the sheet is open so the list stays still. This is
              how a rider who has covered ground since opening it asks again from here. */}
          {!scope?.points?.length && (
            <Chip selected={false} onClick={() => setAnchor(null)} disabled={loading}
                  title="Search again from where you are now">
              Search again
            </Chip>
          )}
        </ChipRow>

        <p className="text-muted text-[11px]">
          {scope?.points?.length
            ? `${meta.plural} at points spread along the road ahead, nearest to the route first.`
            : `${meta.plural} near ${scope?.label ?? 'here'}, closest first.`}
        </p>

        {loading && (
          <div className="flex items-center gap-2 py-6 justify-center">
            <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-muted text-sm">Looking…</span>
          </div>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        {!loading && !error && !results.length && (
          <p className="text-muted text-sm py-4">No {meta.plural.toLowerCase()} within {radiusKm} km. Try a wider radius, or
            another place to search from.
          </p>
        )}

        <div className="flex flex-col gap-2 max-h-[45vh] overflow-y-auto scroll-y">
          {results.map(p => (
            <div key={p.id} className="bg-surface2 rounded-xl px-3 py-2.5 flex items-center gap-3">
              {/* The row itself opens the full card — rating, photos, reviews */}
              <button onClick={() => onOpen?.(p)}
                      disabled={!onOpen}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-default">
                <span className="text-xl flex-shrink-0">{meta.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-ink text-sm truncate">{p.name}</span>
                  <span className="block text-muted text-[11px] truncate">{p.address || '—'}</span>
                  <span className="block text-muted text-[11px]">
                    {fmtKm(p.detour_m)} {scope?.points?.length ? 'off route' : 'away'}
                    {p.rating != null && ` ·  ${p.rating}`}
                    {p.open_now === true && ' · open now'}
                    {p.open_now === false && ' · closed'}
                  </span>
                </span>
                {onOpen && p.provider === 'google' && (
                  <span className="text-muted text-[10px] flex-shrink-0">Details ›</span>
                )}
              </button>
              {onAdd && (
                added.has(p.id)
                  ? <span className="text-green-400 text-xs flex-shrink-0">Added</span>
                  : <Button size="sm" variant="ghost" loading={adding === p.id}
                            onClick={() => add(p)} className="flex-shrink-0">
                      {addLabel}
                    </Button>
              )}
            </div>
          ))}
        </div>

        {!!results.length && (
          <p className="text-muted text-[10px]">Places from Google Maps. Distances are straight-line, not riding distance.
          </p>
        )}
      </div>
    </Modal>
  );
}

/** What a chosen place becomes when added to the route. */
function defaultStopKind(kind: PoiKind): StopKind {
  switch (kind) {
    case 'fuel': return 'fuel';
    case 'lodging': return 'night';
    case 'food': return 'lunch';
    default: return 'break';
  }
}

function fmtKm(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
