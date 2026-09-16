import { useEffect, useRef, useState } from 'react';
import { RideStop, StopKind } from '../../types';
import { stopMeta, STOP_KIND_META, STOP_KIND_ORDER } from '../../lib/stopKinds';
import { Icon, ChipTile } from '../ui';

/** What the list needs to show for each stop beyond the stop itself. */
export interface StopRow {
  stop: RideStop;
  /** Its number in the ride — 1-based, counting reached stops too. */
  seq: number;
  /** Cumulative distance from the rider, metres. Null when not yet routed. */
  distance_m?: number | null;
  /** Cumulative time from the rider, seconds. */
  duration_s?: number | null;
  /** False when the figures are straight-line estimates. */
  exact?: boolean;
  /** The one being ridden toward. */
  isNext?: boolean;
}

/**
 * The ride's stops, in order, draggable.
 *
 * Reordering is the whole point: a rider who adds "fuel" as the last stop and then
 * realises they need it first should be able to drag it up, not delete and re-add it.
 * Built on pointer events rather than HTML5 drag-and-drop, which never fires on touch.
 */
export default function StopsEditor({
  rows, onReorder, onDelete, onLocate, onKind, onFindNearby, busy, editable,
}: {
  rows: StopRow[];
  /** Called with the stop ids in their new order. */
  onReorder: (ids: string[]) => void;
  onDelete: (id: string) => void;
  /** Centre the map on this stop. */
  onLocate?: (stop: RideStop) => void;
  /** Change what a stop is for. */
  onKind?: (id: string, kind: StopKind) => void;
  /** Search around a stop for what its kind suggests — beds at a night stop, food at lunch. */
  onFindNearby?: (stop: RideStop) => void;
  busy?: boolean;
  editable: boolean;
}) {
  /** Which row has its type chips open. */
  const [kindFor, setKindFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  /** Where the dragged row would land — drives the gap the other rows open up. */
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const startY = useRef(0);
  const fromIndex = useRef(0);

  // A row can vanish mid-drag if the ride refetches; never leave the list stuck.
  useEffect(() => {
    if (dragId && !rows.some(r => r.stop.id === dragId)) reset();
  }, [rows, dragId]);

  function reset() {
    setDragId(null);
    setOverIndex(null);
    setDragY(0);
  }

  function onPointerDown(e: React.PointerEvent, index: number) {
    if (!editable || busy) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    fromIndex.current = index;
    setDragId(rows[index].stop.id);
    setOverIndex(index);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragId) return;
    const dy = e.clientY - startY.current;
    setDragY(dy);

    // Land wherever the pointer is, by comparing against each row's midpoint.
    let target = fromIndex.current;
    for (let i = 0; i < rows.length; i++) {
      const el = rowRefs.current[i];
      if (!el || i === fromIndex.current) continue;
      const box = el.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      if (fromIndex.current < i && e.clientY >mid) target = i;
      if (fromIndex.current >i && e.clientY < mid) { target = i; break; }
    }
    setOverIndex(target);
  }

  function onPointerUp() {
    if (!dragId || overIndex == null) { reset(); return; }
    const from = fromIndex.current;
    if (from !== overIndex) {
      const ids = rows.map(r => r.stop.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(overIndex, 0, moved);
      onReorder(ids);
    }
    reset();
  }

  /** Keyboard and no-drag fallback — some riders wear gloves. */
  function nudge(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const ids = rows.map(r => r.stop.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    onReorder(ids);
  }

  if (!rows.length) { return <p className="text-muted text-xs px-2 py-3">No stops yet. Add one to build the route.</p>;
  }

  return (
    <div ref={listRef} className="flex flex-col gap-1" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {rows.map((r, i) => {
        const dragging = r.stop.id === dragId;
        const meta = stopMeta(r.stop.kind);
        const mins = r.stop.planned_minutes ?? meta.minutes;
        // Rows between the origin and the target slide out of the way.
        let shift = 0;
        if (dragId && overIndex != null && !dragging) {
          const h = rowRefs.current[i]?.offsetHeight ?? 44;
          if (fromIndex.current < i && i <= overIndex) shift = -(h + 4);
          if (fromIndex.current >i && i >= overIndex) shift = h + 4;
        }

        return (
          <div
            key={r.stop.id}
            ref={el => { rowRefs.current[i] = el; }}
            style={{
              transform: dragging ? `translateY(${dragY}px)` : `translateY(${shift}px)`,
              transition: dragging ? 'none' : 'transform 140ms ease',
              zIndex: dragging ? 30 : 1,
            }}
            className={`relative flex items-center gap-2 px-2 py-2 rounded-lg border ${
              dragging
                ? 'bg-surface border-accent shadow-xl scale-[1.02]': r.isNext
                  ? 'bg-accent/10 border-accent/40': 'bg-surface2 border-transparent'} ${r.stop.reached_at ? 'opacity-60' : ''}`}
          >
            {editable && (
              <button
                onPointerDown={e => onPointerDown(e, i)}
                className="touch-none cursor-grab active:cursor-grabbing text-muted hover:text-muted
                           px-0.5 select-none flex-shrink-0"
                aria-label={`Reorder ${r.stop.name}`}
                title="Drag to reorder"
              >
                <Icon name="drag" size={16} />
              </button>
            )}

            {/* The stop's number in the ride — the same number shown on its map pin. */}
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
              r.stop.reached_at
                ? 'bg-green-500 text-ink': r.isNext ? 'bg-accent text-accent-ink' : 'bg-black/40 text-ink'}`}>
              {r.stop.reached_at ? '' : r.seq}
            </span>

            <button
              onClick={() => r.stop.lat != null && onLocate?.(r.stop)}
              className="flex-1 min-w-0 text-left"
            >
              <p className="text-ink text-xs truncate">
                <span className="mr-1">{meta.icon}</span>{r.stop.name}
              </p>
              {r.stop.lat == null ? (
                <p className="text-yellow-400 text-[10px]">No position — drag its pin onto the map</p>
              ) : (
                <p className="text-muted text-[10px] tabular-nums">
                  <span className={meta.tone}>{meta.label}</span>
                  {mins >0 && ` · ${fmtMins(mins)} there`}
                  {' · '}
                  {r.distance_m != null ? fmtDistance(r.distance_m) : '—'}
                  {r.duration_s != null && ` · ${fmtEta(r.duration_s)}`}
                  {r.exact === false && r.distance_m != null && ' ~'}
                </p>
              )}
            </button>

            {/* Fuel, food and beds around this stop — whatever its kind, since any stop
                is somewhere you might need a pump */}
            <div className="flex items-center flex-shrink-0 text-muted">
              {onFindNearby && r.stop.lat != null && (
                <button onClick={() => onFindNearby(r.stop)}
                        title={`Find fuel, food and stays near ${r.stop.name}`}
                        aria-label={`Find fuel, food and stays near ${r.stop.name}`}
                        className="btn3d btn3d-surface p-1.5 rounded-lg hover:text-accent hover:bg-surface2 transition-colors">
                  <Icon name="search" size={14} />
                </button>
              )}

              {editable && onKind && (
                <button onClick={() => setKindFor(id => id === r.stop.id ? null : r.stop.id)}
                        className={`btn3d btn3d-surface p-1.5 rounded-lg transition-colors hover:bg-surface2 ${
                          kindFor === r.stop.id ? 'text-accent bg-surface2' : 'hover:text-ink'}`}
                        aria-label={`Change what ${r.stop.name} is for`}>
                  <Icon name="edit" size={14} />
                </button>
              )}

              {editable && (
                <>
                  <button onClick={() => nudge(i, -1)} disabled={i === 0} aria-label="Move up"
                          className="btn3d btn3d-surface bg-surface2 border border-border p-1 rounded-lg disabled:opacity-20 hover:text-ink">
                    <Icon name="up" size={13} />
                  </button>
                  <button onClick={() => nudge(i, 1)} disabled={i === rows.length - 1} aria-label="Move down"
                          className="btn3d btn3d-surface bg-surface2 border border-border p-1 rounded-lg disabled:opacity-20 hover:text-ink">
                    <Icon name="down" size={13} />
                  </button>
                  <button onClick={() => onDelete(r.stop.id)} aria-label={`Remove ${r.stop.name}`}
                          className="btn3d btn3d-surface p-1.5 rounded-lg hover:text-danger hover:bg-surface2 transition-colors">
                    <Icon name="trash" size={13} />
                  </button>
                </>
              )}
            </div>

            {/* Re-label the stop in place, without opening a modal mid-ride */}
            {kindFor === r.stop.id && onKind && (
              <div className="absolute left-0 right-0 top-full mt-1.5 z-40 bg-surface2 border border-border
                              rounded-2xl p-2 shadow-xl grid grid-cols-3 gap-1.5">
                {STOP_KIND_ORDER.map(k => (
                  <ChipTile
                    key={k}
                    selected={(r.stop.kind ?? 'break') === k}
                    icon={STOP_KIND_META[k].icon}
                    label={STOP_KIND_META[k].label}
                    className="min-h-[48px] py-1.5 text-[10px]"
                    onClick={() => { onKind(r.stop.id, k); setKindFor(null); }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtDistance(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtEta(s: number) {
  return fmtMins(Math.round(s / 60));
}

function fmtMins(mins: number) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
