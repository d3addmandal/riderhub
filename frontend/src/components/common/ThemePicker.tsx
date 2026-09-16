import { useState } from 'react';
import { ThemeChoice, readTheme, applyTheme, effectiveTheme } from '../../lib/theme';
import { ChipTile } from '../ui';

const OPTIONS: { id: ThemeChoice; label: string; icon: string; hint: string }[] = [
  { id: 'light',  label: 'Light',  icon: '', hint: 'Bright, for daylight' },
  { id: 'dark',   label: 'Dark',   icon: '', hint: 'Easier at night' },
  { id: 'system', label: 'System', icon: '', hint: 'Follows your phone' },
];

/**
 * Dark, light, or follow the phone.
 *
 * "System" is the default because a phone that flips to light at sunrise should take the
 * app with it — a rider setting off at dawn should not have to remember to change this.
 */
export default function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map(o => (
          <ChipTile
            key={o.id}
            selected={choice === o.id}
            label={o.label}
            onClick={() => { setChoice(o.id); applyTheme(o.id); }}
          />
        ))}
      </div>
      <p className="text-muted text-[11px]">
        {OPTIONS.find(o => o.id === choice)?.hint}
        {choice === 'system' && ` — currently ${effectiveTheme('system')}.`}
      </p>
    </div>
  );
}
