import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import Splash from './components/common/Splash';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/DashboardPage';
import GaragePage from './pages/GaragePage';
import BikeDetailPage from './pages/BikeDetailPage';
import ServiceDetailPage from './pages/ServiceDetailPage';
import RidesPage from './pages/RidesPage';
import RideDetailPage from './pages/RideDetailPage';
import RideMapPage from './pages/RideMapPage';
import FuelPage from './pages/FuelPage';
import ServicePage from './pages/ServicePage';
import DocumentsPage from './pages/DocumentsPage';
import SOSPage from './pages/SOSPage';
import ProfilePage from './pages/ProfilePage';
import RemindersPage from './pages/RemindersPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore(); if (loading) return <Splash label="Signing you in" />;
  if (!user) return <Navigate to="/auth" replace />; return <>{children}</>;
}

export default function App() {
  const { setUser, fetchProfile, completeEmailLink } = useAuthStore();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    // A rider arriving from an email sign-in link lands here first. Redeem it before
    // wiring up the listener so onAuthStateChanged fires once, already signed in.
    completeEmailLink()
      .catch(err => console.error('Email link sign-in failed:', err))
      .finally(() => {
        if (cancelled) return;

        unsubscribe = onAuthStateChanged(auth, user => {
          setUser(user);
          if (user) fetchProfile();
          else useAuthStore.setState({ profile: null });
          useAuthStore.setState({ loading: false });
          setBooted(true);
        });
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  if (!booted) return null;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/auth/callback" element={<AuthPage />} />
        <Route path="/" element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<DashboardPage />} />
          <Route path="garage" element={<GaragePage />} />
          <Route path="garage/:bikeId" element={<BikeDetailPage />} />
          <Route path="rides" element={<RidesPage />} />
          <Route path="rides/:rideId" element={<RideDetailPage />} />
          <Route path="rides/:rideId/map" element={<RideMapPage />} />
          <Route path="fuel" element={<FuelPage />} />
          <Route path="service" element={<ServicePage />} />
          <Route path="service/:serviceId" element={<ServiceDetailPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="sos" element={<SOSPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="reminders" element={<RemindersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
