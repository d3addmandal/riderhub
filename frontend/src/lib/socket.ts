import { io, Socket } from 'socket.io-client';
import { getIdToken } from './firebase';

let socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;

  const token = await getIdToken();

  socket = io(import.meta.env.VITE_API_URL || '', {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5,
  });

  // ID tokens expire after an hour; hand the server a fresh one on every reconnect.
  socket.io.on('reconnect_attempt', async () => {
    const fresh = await getIdToken();
    if (socket) socket.auth = { token: fresh };
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export { socket };
