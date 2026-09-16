import { useNavigate, useLocation } from 'react-router-dom';
import BikeSwitcher from '../common/BikeSwitcher';
import { IconButton } from '../ui';

/**
 * Header with the selected motorcycle centred (spec §3.1).
 *
 * Back arrow appears on any screen that is not a bottom-nav destination, so deep screens
 * are always one tap from where the rider came.
 */
const ROOT_PATHS = ['/', '/garage', '/rides', '/fuel', '/profile'];

export default function AppHeader() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isRoot = ROOT_PATHS.includes(pathname);

  return (
    <header className="flex-shrink-0 h-14 bg-surface border-b border-border flex items-center gap-1 px-2 safe-top">
      {isRoot
        ? <span className="w-9 flex-shrink-0" aria-hidden="true" />
        : <IconButton icon="back" label="Go back" onClick={() => navigate(-1)} />}

      <BikeSwitcher />

      <IconButton icon="user" label="Profile" onClick={() => navigate('/profile')} />
    </header>
  );
}
