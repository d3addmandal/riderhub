import { create } from 'zustand';
import { Motorcycle } from '../types';
import { api } from '../lib/api';

// Which bike the whole app is currently showing. Survives reloads so a rider with two
// machines is not re-selecting on every visit.
const SELECTED_KEY = 'riderhub:selectedBikeId';
const storedSelection = (() => {
  try { return window.localStorage.getItem(SELECTED_KEY); } catch { return null; }
})();

interface GarageState {
  bikes: Motorcycle[];
  activeBike: Motorcycle | null;
  /** Drives every bike-scoped screen: home, fuel, service, reminders. */
  selectedBikeId: string | null;
  loading: boolean;
  fetchBikes: () => Promise<void>;
  addBike: (data: Partial<Motorcycle>) => Promise<Motorcycle>;
  updateBike: (id: string, data: Partial<Motorcycle>) => Promise<void>;
  deleteBike: (id: string) => Promise<void>;
  setActiveBike: (bike: Motorcycle | null) => void;
  setSelectedBike: (id: string | null) => void;
}

export const useGarageStore = create<GarageState>((set, get) => ({
  bikes: [],
  activeBike: null,
  selectedBikeId: storedSelection,
  loading: false,

  fetchBikes: async () => {
    set({ loading: true });
    try {
      const bikes = await api.get<Motorcycle[]>('/bikes');
      set({ bikes, activeBike: get().activeBike || bikes.find(b => b.is_primary) || bikes[0] || null });
    } finally {
      set({ loading: false });
    }
  },

  addBike: async (data) => {
    const bike = await api.post<Motorcycle>('/bikes', data);
    set(s => ({ bikes: [bike, ...s.bikes] }));
    return bike;
  },

  updateBike: async (id, data) => {
    const updated = await api.put<Motorcycle>(`/bikes/${id}`, data);
    set(s => ({
      bikes: s.bikes.map(b => b.id === id ? updated : b),
      activeBike: s.activeBike?.id === id ? updated : s.activeBike,
    }));
  },

  deleteBike: async (id) => {
    await api.delete(`/bikes/${id}`);
    set(s => ({
      bikes: s.bikes.filter(b => b.id !== id),
      activeBike: s.activeBike?.id === id ? s.bikes.find(b => b.id !== id) || null : s.activeBike,
    }));
  },

  setActiveBike: (bike) => set({ activeBike: bike }),

  setSelectedBike: (id) => {
    try {
      if (id) window.localStorage.setItem(SELECTED_KEY, id);
      else window.localStorage.removeItem(SELECTED_KEY);
    } catch { /* private browsing — selection just won't persist */ }
    set({ selectedBikeId: id });
  },
}));
