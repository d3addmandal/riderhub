import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Motorcycle } from '../../types';
import { useGarageStore } from '../../store/garageStore';
import { Icon } from '../ui';

/**
 * The selected motorcycle, centred in the header (spec §3.1).
 *
 * One bike shows its name. Two or more turn it into a picker, and choosing one re-scopes
 * every screen in the app because the selection lives in the garage store.
 */
export default function BikeSwitcher() {
  const { selectedBikeId, setSelectedBike } = useGarageStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: bikes, isLoading } = useQuery<Motorcycle[]>({
    queryKey: ['bikes'],
    queryFn: () => api.get('/bikes'),
  });

  // Fall back to the primary bike, then the first, whenever the selection is empty or
  // points at a bike that has since been deleted.
  useEffect(() => {
    if (!bikes?.length) return;
    const stillExists = bikes.some(b => b.id === selectedBikeId);
    if (!stillExists) {
      setSelectedBike((bikes.find(b => b.is_primary) ?? bikes[0]).id);
    }
  }, [bikes, selectedBikeId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (isLoading) {
    return <div className="h-6 w-40 rounded-md bg-surface2 animate-pulse" />;
  }

  if (!bikes?.length) {
    return (
      <Link to="/garage" className="text-accent text-sm font-semibold">
        + Add your motorcycle
      </Link>
    );
  }

  const selected = bikes.find(b => b.id === selectedBikeId) ?? bikes[0];
  const single = bikes.length === 1;

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0 flex justify-center">
      <button
        onClick={() => !single && setOpen(o => !o)}
        disabled={single}
        aria-haspopup={single ? undefined : 'listbox'}
        aria-expanded={single ? undefined : open}
        className={`btn3d btn3d-surface flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg transition-colors ${
          single ? 'cursor-default' : 'hover:bg-surface2 active:scale-[0.98]'}`}
      >
        <span className="font-bold text-ink text-sm truncate">
          {selected.brand} {selected.model}
        </span>
        {!single && (
          <Icon name="chevronDown" size={14}
                className={`text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full mt-2 w-64 max-w-[85vw] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden z-50"
        >
          <p className="px-4 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-border">Switch motorcycle
          </p>
          <div className="max-h-72 overflow-y-auto scroll-y">
            {bikes.map(b => {
              const active = b.id === selected.id;
              return (
                <button
                  key={b.id}
                  role="option"
                  aria-selected={active}
                  onClick={() => { setSelectedBike(b.id); setOpen(false); }}
                  className={`btn3d btn3d-accent w-full text-left px-4 py-3 flex items-center gap-3 border-b border-border
                              last:border-b-0 transition-colors ${
                    active ? 'bg-accent/10' : 'hover:bg-surface2'}`}
                >
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0
                                    ${active ? 'bg-accent text-accent-ink' : 'bg-surface2'}`}>🏍️</span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-semibold truncate ${active ? 'text-accent' : 'text-ink'}`}>
                      {b.brand} {b.model}
                    </span>
                    <span className="block text-xs text-muted tabular-nums">{b.current_odometer.toLocaleString()} km</span>
                  </span>
                  {active && (
                    <span className="w-5 h-5 rounded-full bg-accent text-accent-ink flex items-center
                                     justify-center flex-shrink-0">
                      <Icon name="check" size={12} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <Link
            to="/garage"
            onClick={() => setOpen(false)}
            className="block px-4 py-3 text-center text-accent text-sm font-medium border-t border-border hover:bg-surface2"
          >Manage garage
          </Link>
        </div>
      )}
    </div>
  );
}
