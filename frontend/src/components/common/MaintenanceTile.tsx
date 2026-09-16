import { MaintenanceItem, MaintenanceStatus } from '../../types';

/**
 * Shading for a maintenance component (spec §7.3).
 *
 * The tile's shade escalates with urgency, but the status word, the remaining distance and
 * the remaining days are always printed too — colour is never the only signal, which is
 * what makes this readable for colour-blind riders (§40).
 */
export const STATUS_STYLE: Record<MaintenanceStatus, { box: string; text: string; dot: string }> = {
  healthy:  { box: 'bg-surface border-border',            text: 'text-green-400',  dot: 'bg-green-400' },
  due_soon: { box: 'bg-yellow-500/10 border-yellow-500/40', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  due:      { box: 'bg-orange-500/15 border-orange-500/60', text: 'text-orange-400', dot: 'bg-orange-400' },
  overdue:  { box: 'bg-red-500/15 border-red-500/70',       text: 'text-red-400',    dot: 'bg-red-400' },
  unknown:  { box: 'bg-surface border-border border-dashed', text: 'text-muted',     dot: 'bg-muted' },
};

/** "1,200 km left" / "24 days left" / "Overdue by 300 km" — always words, never just a hue. */
export function remainingText(m: MaintenanceItem): string {
  const parts: string[] = [];
  if (m.km_remaining != null) {
    parts.push(m.km_remaining < 0
      ? `${Math.abs(m.km_remaining).toLocaleString()} km over`
      : `${m.km_remaining.toLocaleString()} km left`);
  }
  if (m.days_remaining != null) {
    parts.push(m.days_remaining < 0
      ? `${Math.abs(m.days_remaining)} days over`
      : `${m.days_remaining} days left`);
  }
  return parts.join(' · ') || 'No interval set';
}

export default function MaintenanceTile({ item, onClick }: { item: MaintenanceItem; onClick?: () => void }) {
  const s = STATUS_STYLE[item.status] ?? STATUS_STYLE.unknown;

  return (
    <button
      onClick={onClick}
      className={`btn3d btn3d-surface w-full text-left border rounded-2xl p-3.5 flex flex-col gap-2 ${s.box} ${onClick ? 'hover:brightness-110 active:scale-[0.99]' : 'cursor-default'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink text-sm truncate">{item.name}</p>
          <p className="text-muted text-[11px]">{item.category}</p>
        </div>
        <span className={`flex items-center gap-1.5 text-[11px] font-bold whitespace-nowrap ${s.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
          {item.status_label}
        </span>
      </div>

      <p className={`text-xs font-medium ${s.text}`}>{remainingText(item)}</p>

      {item.progress != null && (
        <div className="h-1.5 rounded-full bg-black/30 overflow-hidden" aria-hidden="true">
          <div
            className={`h-full rounded-full ${item.status === 'overdue' ? 'bg-red-400' : item.status === 'due' ? 'bg-orange-400' : item.status === 'due_soon' ? 'bg-yellow-400' : 'bg-green-400'}`}
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </div>
      )}

      <p className="text-muted text-[11px]">
        {item.last_changed_km != null
          ? `Last done at ${item.last_changed_km.toLocaleString()} km`
          : 'Never recorded'}
        {item.next_due_km != null && ` · next ${item.next_due_km.toLocaleString()} km`}
      </p>
    </button>
  );
}
