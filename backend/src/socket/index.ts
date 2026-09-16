import { Server, Socket } from 'socket.io';
import { auth } from '../config/firebase';
import { RiderLocation, RoomState } from '../types';

const rooms = new Map<string, RoomState>();

function getOrCreateRoom(groupId: string): RoomState {
  if (!rooms.has(groupId)) {
    rooms.set(groupId, { groupId, riders: new Map() });
  }
  return rooms.get(groupId)!;
}

export function initSocketIO(io: Server) {
  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) { next(new Error('Authentication required')); return; }

    try {
      const decoded = await auth.verifyIdToken(token);
      socket.data.userId = decoded.uid;
      socket.data.email = decoded.email ?? '';
      next();
    } catch {
      next(new Error('Auth failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id} (user: ${socket.data.userId})`);

    socket.on('join_group', async (data: { groupId: string; name: string; color: string }) => {
      const { groupId, name, color } = data;
      socket.join(groupId);
      socket.data.groupId = groupId;

      const room = getOrCreateRoom(groupId);
      room.riders.set(socket.data.userId, {
        userId: socket.data.userId,
        name,
        color,
        lat: 0,
        lng: 0,
        timestamp: new Date().toISOString(),
        status: 'online',
      });

      // Send current state to joiner
      socket.emit('room_state', {
        riders: Object.fromEntries(room.riders),
        destination: room.destination,
      });

      // Notify others
      socket.to(groupId).emit('rider_joined', {
        userId: socket.data.userId,
        name,
        color,
      });
    });

    socket.on('location', (data: {
      lat: number; lng: number;
      speed?: number; heading?: number; battery?: number;
    }) => {
      const { groupId, userId } = socket.data;
      if (!groupId || !userId) return;

      const room = rooms.get(groupId);
      if (!room) return;

      const rider = room.riders.get(userId);
      if (!rider) return;

      const prevLat = rider.lat, prevLng = rider.lng;
      rider.lat = data.lat;
      rider.lng = data.lng;
      rider.speed = data.speed;
      rider.heading = data.heading;
      rider.battery = data.battery;
      rider.timestamp = new Date().toISOString();

      const moved = Math.abs(data.lat - prevLat) > 0.00015 || Math.abs(data.lng - prevLng) > 0.00015;
      rider.status = moved ? 'moving' : 'idle';

      socket.to(groupId).emit('location_update', {
        userId,
        lat: data.lat,
        lng: data.lng,
        speed: data.speed,
        heading: data.heading,
        battery: data.battery,
        status: rider.status,
        timestamp: rider.timestamp,
        name: rider.name,
        color: rider.color,
      });
    });

    socket.on('set_destination', (dest: { name: string; lat: number; lng: number }) => {
      const { groupId } = socket.data;
      if (!groupId) return;

      const room = rooms.get(groupId);
      if (room) room.destination = dest;

      io.to(groupId).emit('destination_updated', dest);
    });

    socket.on('clear_destination', () => {
      const { groupId } = socket.data;
      if (!groupId) return;

      const room = rooms.get(groupId);
      if (room) delete room.destination;

      io.to(groupId).emit('destination_updated', null);
    });

    socket.on('send_message', (msg: { text: string }) => {
      const { groupId, userId } = socket.data;
      if (!groupId || !msg.text?.trim()) return;

      const room = rooms.get(groupId);
      const rider = room?.riders.get(userId);

      io.to(groupId).emit('group_message', {
        userId,
        name: rider?.name || 'Rider',
        color: rider?.color || '#888',
        text: msg.text.trim(),
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('disconnect', () => {
      const { groupId, userId } = socket.data;
      if (!groupId || !userId) return;

      const room = rooms.get(groupId);
      if (room) {
        const rider = room.riders.get(userId);
        room.riders.delete(userId);

        socket.to(groupId).emit('rider_left', { userId, name: rider?.name });

        if (room.riders.size === 0) rooms.delete(groupId);
      }
    });
  });
}
