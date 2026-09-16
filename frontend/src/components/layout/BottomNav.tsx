import { NavLink } from 'react-router-dom';
import { cn } from '../../lib/utils';

const NAV = [
  { to: '/', label: 'Home', exact: true },
  { to: '/garage', label: 'Garage' },
  { to: '/rides', label: 'Rides' },
  { to: '/fuel', label: 'Fuel' },
  { to: '/service', label: 'Service' },
];

/**
 * The footer, as five buttons.
 *
 * Words rather than pictures: five emoji in a row was decoration competing with itself,
 * and a house, a spanner and a fuel pump at 20px are harder to tell apart at a glance
 * than the words for them. The selected tab is a filled pill, which is unmistakable
 * without needing an icon to carry it.
 *
 * The bar shrinks on a sideways phone, where vertical space is the scarce thing.
 */
export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 short:h-12 bg-surface border-t border-border
                    flex items-center gap-1 px-2 z-40 safe-bottom">
      {NAV.map(({ to, label, exact }) => (
        <NavLink
          key={to}
          to={to}
          end={exact}
          className={({ isActive }) => cn(
              'flex-1 h-11 short:h-9 rounded-xl flex items-center justify-center',
              'text-xs font-semibold transition-colors active:scale-95',
              isActive
                ? 'bg-accent text-accent-ink': 'bg-surface2 text-muted hover:text-ink',
            )
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
