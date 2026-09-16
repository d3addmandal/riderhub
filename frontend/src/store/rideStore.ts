import { create } from 'zustand';
import { RideGroup, RiderLocation, GroupMessage } from '../types';
import { getSocket, disconnectSocket } from '../lib/socket';
import { Socket } from 'socket.io-client';

interface RideState {
  activeGroup: RideGroup | null;
  riders: Map<string, RiderLocation>;
  myLocation: { lat: number; lng: number } | null;
  messages: GroupMessage[];
  socket: Socket | null;
  watchId: number | null;
  setActiveGroup: (group: RideGroup | null) => void;
  joinGroupRoom: (groupId: string, name: string, color: string) => Promise<void>;
  leaveGroupRoom: () => void;
  sendLocation: (lat: number, lng: number, speed?: number, heading?: number, battery?: number) => void;
  sendMessage: (text: string) => void;
  setDestination: (name: string, lat: number, lng: number) => void;
  clearDestination: () => void;
  startTracking: () => void;
  stopTracking: () => void;
}

export const useRideStore = create<RideState>((set, get) => ({
  activeGroup: null,
  riders: new Map(),
  myLocation: null,
  messages: [],
  socket: null,
  watchId: null,

  setActiveGroup: (group) => set({ activeGroup: group }),

  joinGroupRoom: async (groupId, name, color) => {
    const socket = await getSocket();
    set({ socket });

    socket.emit('join_group', { groupId, name, color });

    socket.on('room_state', (data: { riders: Record<string, RiderLocation>; destination?: { name: string; lat: number; lng: number } }) => {
      const riders = new Map(Object.entries(data.riders));
      set(s => ({
        riders,
        activeGroup: s.activeGroup ? { ...s.activeGroup, ...(data.destination ? { destination_name: data.destination.name, destination_lat: data.destination.lat, destination_lng: data.destination.lng } : {}) } : null,
      }));
    });

    socket.on('rider_joined', (data: RiderLocation) => {
      set(s => {
        const riders = new Map(s.riders);
        riders.set(data.userId, data);
        return { riders };
      });
    });

    socket.on('rider_left', (data: { userId: string; name: string }) => {
      set(s => {
        const riders = new Map(s.riders);
        riders.delete(data.userId);
        return { riders };
      });
    });

    socket.on('location_update', (data: RiderLocation) => {
      set(s => {
        const riders = new Map(s.riders);
        riders.set(data.userId, data);
        return { riders };
      });
    });

    socket.on('destination_updated', (dest: { name: string; lat: number; lng: number } | null) => {
      set(s => ({
        activeGroup: s.activeGroup ? {
          ...s.activeGroup,
          destination_name: dest?.name,
          destination_lat: dest?.lat,
          destination_lng: dest?.lng,
        } : null,
      }));
    });

    socket.on('group_message', (msg: GroupMessage) => {
      set(s => ({ messages: [...s.messages.slice(-99), msg] }));
    });
  },

  leaveGroupRoom: () => {
    const { watchId } = get();
    if (watchId) navigator.geolocation.clearWatch(watchId);
    disconnectSocket();
    set({ activeGroup: null, riders: new Map(), messages: [], socket: null, watchId: null, myLocation: null });
  },

  sendLocation: (lat, lng, speed, heading, battery) => {
    const { socket } = get();
    socket?.emit('location', { lat, lng, speed, heading, battery });
    set({ myLocation: { lat, lng } });
  },

  sendMessage: (text) => {
    const { socket } = get();
    socket?.emit('send_message', { text });
  },

  setDestination: (name, lat, lng) => {
    const { socket } = get();
    socket?.emit('set_destination', { name, lat, lng });
  },

  clearDestination: () => {
    const { socket } = get();
    socket?.emit('clear_destination');
  },

  startTracking: () => {
    const { sendLocation } = get();
    if (!navigator.geolocation) return;

    let lastLat = 0, lastLng = 0, lastTime = 0;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, speed, heading } = pos.coords;
        const now = Date.now();
        const moved = Math.abs(lat - lastLat) >0.00015 || Math.abs(lng - lastLng) >0.00015;
        const elapsed = now - lastTime >5000;

        if (moved || elapsed) {
          sendLocation(lat, lng, speed ?? undefined, heading ?? undefined);
          lastLat = lat; lastLng = lng; lastTime = now;
        }
      },
      (err) => console.warn('Geolocation error:', err.message),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    set({ watchId });
  },

  stopTracking: () => {
    const { watchId } = get();
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      set({ watchId: null });
    }
  },
}));
