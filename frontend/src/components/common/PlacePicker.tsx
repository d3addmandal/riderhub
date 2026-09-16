import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { RidePoint } from '../../types';
import { Icon } from '../ui';

interface Suggestion {
  id: string;
  name: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
  provider: 'google' | 'photon';
}

/**
 * Search for a place and attach its coordinates to a ride point.
 *
 * A stop without coordinates cannot be navigated to, so this is what turns "Khandala
 * Ghat" from a note into a waypoint. The rider can still type a free-text name and move
 * on — the value is optional, not a gate.
 */
export default function PlacePicker({ label, value, onChange, placeholder, keepCoordsOnRename }: {
  label: string;
  value: RidePoint | null;
  onChange: (p: RidePoint | null) => void;
  placeholder?: string;
  /**
   * Set when the coordinates came from a deliberate act — tapping the map, or pinning the
   * rider's own position — rather than from a search result. Then the name is only a
   * label, so editing it must not throw the position away.
   */
  keepCoordsOnRename?: boolean;
}) {
  const [query, setQuery] = useState(value?.name ?? '');
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [locating, setLocating] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Google bills autocomplete per session, so keep one token for the whole interaction.
  const session = useRef<string>(crypto.randomUUID());

  /** A name that is already an answer — searching for it again would be pointless. */
  const resolved = useRef<string | null>(null);
  /** The last name this component itself emitted, to tell our edits from the parent's. */
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    const n = value?.name ?? '';
    setQuery(n);
    // A name we did not type came from a resolution — a map tap, a reverse geocode — so
    // it needs no lookup. Anything the rider types does, even over a pinned position.
    if (n !== lastEmitted.current) resolved.current = n;
  }, [value?.name]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Debounced so a typed word is one request, not eight.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) { setResults([]); return; }
    if (resolved.current === query) return; // already an answer — nothing to look up

    timer.current = setTimeout(async () => {
      setBusy(true); setNote('');
      try {
        const r = await api.get<{ results: Suggestion[]; provider: string }>(
          `/places/search?q=${encodeURIComponent(query.trim())}&session=${session.current}`
        );
        setResults(r.results);
        setOpen(true);
        if (!r.results.length) setNote('No matches. You can still use the name as typed.');
      } catch {
        setNote('Search unavailable — the typed name will be saved without coordinates.');
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 350);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  async function pick(s: Suggestion) {
    setOpen(false);
    setQuery(s.name);
    resolved.current = s.name;
    lastEmitted.current = s.name;

    if (s.lat != null && s.lng != null) {
      onChange({ name: s.name, lat: s.lat, lng: s.lng });
      return;
    }

    // Google returns coordinates only from the details call.
    setBusy(true);
    try {
      const d = await api.get<{ lat: number; lng: number }>(
        `/places/details?id=${encodeURIComponent(s.id)}&session=${session.current}`
      );
      onChange({ name: s.name, lat: d.lat, lng: d.lng });
      session.current = crypto.randomUUID(); // a resolved pick ends the billing session
    } catch {
      onChange({ name: s.name });
      setNote('Saved the name, but its position could not be resolved.');
    } finally {
      setBusy(false);
    }
  }

  function useCurrentPosition() {
    if (!navigator.geolocation) { setNote('This device has no GPS.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      p => {
        const name = query.trim() || 'Current location';
        resolved.current = name;
        lastEmitted.current = name;
        onChange({ name, lat: p.coords.latitude, lng: p.coords.longitude });
        setQuery(name);
        setNote('Pinned to where you are now.');
        setLocating(false);
        setOpen(false);
      },
      err => { setNote(`Could not get your location: ${err.message}`); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  const pinned = value?.lat != null && value?.lng != null;

  return (
    <div ref={wrapRef} className="flex flex-col gap-1.5 relative">
      <label className="text-sm font-medium text-muted">{label}</label>

      <div className="relative">
        <input
          value={query}
          placeholder={placeholder}
          onChange={e => {
            const name = e.target.value;
            setQuery(name);
            resolved.current = null;
            lastEmitted.current = name;
            if (!pinned) return;
            // Renaming a hand-placed pin keeps it — "Fuel stop" is a label for a position
            // the rider already chose. Renaming a search result drops its now-stale
            // coordinates, because there the name was what identified the place.
            onChange(keepCoordsOnRename
              ? { name, lat: value!.lat, lng: value!.lng }
              : { name });
          }}
          onFocus={() => results.length && setOpen(true)}
          className="w-full bg-surface2 border border-border rounded-xl px-4 py-3 pr-20 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {busy && <span className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
          {pinned && !busy && <span className="text-green-400 text-xs" title="Position set"></span>}
          <button
            type="button"
            onClick={useCurrentPosition}
            disabled={locating}
            title="Use my current position"
            className="btn3d btn3d-surface bg-surface2 border border-border rounded-lg text-muted hover:text-ink text-sm px-1.5 py-0.5"
          >
            {locating ? '…' : ''}
          </button>
        </div>
      </div>

      {open && results.length >0 && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-surface2 border border-border
                        rounded-2xl shadow-xl z-50 max-h-64 overflow-y-auto scroll-y">
          {results.map(s => {
            const chosen = s.name === value?.name && pinned;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => pick(s)}
                className={`btn3d btn3d-accent w-full text-left px-3 py-2.5 border-b border-border last:border-b-0
                            flex items-center gap-2 transition-colors ${
                  chosen ? 'bg-accent/10' : 'hover:bg-surface2'}`}
              >
                <Icon name="pin" size={15} className={chosen ? 'text-accent' : 'text-muted'} />
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm truncate ${chosen ? 'text-accent font-semibold' : 'text-ink'}`}>
                    {s.name}
                  </span>
                  {s.address && <span className="block text-muted text-xs truncate">{s.address}</span>}
                </span>
                {chosen && <Icon name="check" size={14} strokeWidth={3} className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}

      {note && <p className="text-muted text-[11px]">{note}</p>}
      {pinned && !note && (
        <p className="text-muted text-[11px]">Pinned at {value!.lat!.toFixed(4)}, {value!.lng!.toFixed(4)} — navigation can route here.
        </p>
      )}
      {!pinned && query.trim() && !busy && !note && (
        <p className="text-muted text-[11px]">Pick a match, or tap to pin your current spot.</p>
      )}
    </div>
  );
}
