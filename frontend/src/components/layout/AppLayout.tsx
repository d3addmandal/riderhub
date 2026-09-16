import { Outlet, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav';
import AppHeader from './AppHeader';
import SOSFloatingButton from '../common/SOSFloatingButton';

/**
 * Two modes (spec §56).
 *
 * GARAGE MODE keeps the header, bottom nav and SOS button.
 * RIDE MODE — the live map — strips all of it so the rider sees only the road.
 */
export default function AppLayout() {
  const { pathname } = useLocation();
  const rideMode = pathname.includes('/rides/') && pathname.endsWith('/map');

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      {!rideMode && <AppHeader />}
      <main className={`flex-1 overflow-hidden ${rideMode ? '' : 'pb-16'}`}>
        <Outlet />
      </main>
      {!rideMode && <BottomNav />}
      {!rideMode && <SOSFloatingButton />}
    </div>
  );
}
