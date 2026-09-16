import { StopKind } from '../../types';
import { STOP_KIND_META, STOP_KIND_ORDER } from '../../lib/stopKinds';
import { ChipTile } from '../ui';

/**
 * Pick what a stop is for.
 *
 * Choosing the kind also sets a sensible time there — a night stop is not a ten-minute
 * affair — which the rider can then override. Guessing beats making them type.
 */
export default function StopKindPicker({ value, onChange, minutes, onMinutes }: {
  value: StopKind;
  onChange: (k: StopKind) => void;
  minutes?: number | null;
  onMinutes?: (m: number | null) => void;
}) {
  const meta = STOP_KIND_META[value];

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-muted">What is this stop for?</label>

      <div className="grid grid-cols-3 gap-2">
        {STOP_KIND_ORDER.map(k => (
          <ChipTile
            key={k}
            selected={k === value}
            icon={STOP_KIND_META[k].icon}
            label={STOP_KIND_META[k].label}
            onClick={() => {
              onChange(k);
              // Only re-suggest the duration if the rider has not set their own.
              if (onMinutes && (minutes == null || minutes === STOP_KIND_META[value].minutes)) {
                onMinutes(STOP_KIND_META[k].minutes);
              }
            }}
          />
        ))}
      </div>

      {onMinutes && (
        <div className="flex items-center gap-2">
          <label className="text-muted text-xs flex-shrink-0">Time there</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={1440}
            value={minutes ?? meta.minutes}
            onChange={e => {
              const v = e.target.value;
              onMinutes(v === '' ? null : Math.max(0, Math.min(1440, parseInt(v, 10) || 0)));
            }}
            className="w-20 bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm text-ink tabular-nums focus:outline-none focus:border-accent"
          />
          <span className="text-muted text-xs">minutes</span>
          {value === 'night' && (
            <span className="text-indigo-300 text-[11px] ml-auto">beds searchable</span>
          )}
        </div>
      )}
    </div>
  );
}
