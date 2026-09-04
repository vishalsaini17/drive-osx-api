import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyAccessToken } from '../../platform/authentication/tokens.js';
import { rootLogger } from '../observability/logger.js';
import { redis, subscriber } from '../redis/client.js';

/**
 * Realtime gateway (CLAUDE.md §22).
 *
 * Two concerns share one socket:
 *  - WebRTC signalling for meetings (offer/answer/ICE relay), and
 *  - per-user notification delivery.
 *
 * Room membership is per-process, so cross-instance fan-out goes through Redis
 * pub/sub — a client connected to instance A still receives an event published
 * by instance B.
 */
interface SocketState {
  userId: string;
  username: string;
  meetingId?: string;
}

const sockets = new Map<WebSocket, SocketState>();
const rooms = new Map<string, Set<WebSocket>>();
const userSockets = new Map<string, Set<WebSocket>>();

const MEETING_CHANNEL = 'realtime:meetings';
const NOTIFICATION_CHANNEL = 'realtime:notifications';

export function createRealtimeServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');

    // Unauthenticated sockets are closed rather than downgraded to anonymous:
    // every message this gateway relays is tenant data.
    if (!token) {
      socket.close(4401, 'Authentication required');
      return;
    }

    let state: SocketState;
    try {
      const claims = verifyAccessToken(token);
      state = { userId: claims.id ?? claims.sub, username: claims.username };
    } catch {
      socket.close(4401, 'Invalid or expired token');
      return;
    }

    sockets.set(socket, state);
    addUserSocket(state.userId, socket);
    rootLogger.debug({ userId: state.userId }, 'realtime client connected');

    socket.on('message', (raw) => {
      void handleMessage(socket, raw.toString());
    });

    socket.on('close', () => {
      handleDisconnect(socket);
    });

    socket.on('error', (error) => {
      rootLogger.warn({ err: error, userId: state.userId }, 'realtime socket error');
    });

    send(socket, { type: 'connected', userId: state.userId });
  });

  subscribeToRedis();

  return wss;
}

async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
  const state = sockets.get(socket);
  if (!state) return;

  let message: { type?: string; meetingId?: string; target?: string; payload?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    send(socket, { type: 'error', message: 'Message must be valid JSON' });
    return;
  }

  switch (message.type) {
    case 'ping':
      send(socket, { type: 'pong' });
      break;

    case 'join':
      if (!message.meetingId) {
        send(socket, { type: 'error', message: 'meetingId is required to join' });
        return;
      }
      joinRoom(socket, state, message.meetingId);
      break;

    case 'leave':
      leaveRoom(socket, state);
      break;

    case 'offer':
    case 'answer':
    case 'ice-candidate':
      if (!state.meetingId) {
        send(socket, { type: 'error', message: 'Join a meeting before sending signalling messages' });
        return;
      }
      await broadcast(state.meetingId, {
        type: message.type,
        from: state.userId,
        target: message.target ?? null,
        payload: message.payload ?? null,
      });
      break;

    // Mic/camera toggle, broadcast to the whole room rather than one target —
    // every tile in the call needs to reflect it, not just one peer.
    case 'state':
      if (!state.meetingId) {
        send(socket, { type: 'error', message: 'Join a meeting before sending signalling messages' });
        return;
      }
      await broadcast(state.meetingId, {
        type: 'state',
        from: state.userId,
        payload: message.payload ?? null,
      });
      break;

    default:
      send(socket, { type: 'error', message: `Unsupported message type "${message.type}"` });
  }
}

function joinRoom(socket: WebSocket, state: SocketState, meetingId: string): void {
  leaveRoom(socket, state);

  state.meetingId = meetingId;
  const room = rooms.get(meetingId) ?? new Set<WebSocket>();
  room.add(socket);
  rooms.set(meetingId, room);

  void broadcast(meetingId, {
    type: 'user-joined',
    userId: state.userId,
    username: state.username,
    participants: participantsOf(meetingId),
  });
}

function leaveRoom(socket: WebSocket, state: SocketState): void {
  const meetingId = state.meetingId;
  if (!meetingId) return;

  const room = rooms.get(meetingId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(meetingId);
  delete state.meetingId;

  void broadcast(meetingId, {
    type: 'user-left',
    userId: state.userId,
    participants: participantsOf(meetingId),
  });
}

function handleDisconnect(socket: WebSocket): void {
  const state = sockets.get(socket);
  if (!state) return;

  leaveRoom(socket, state);
  removeUserSocket(state.userId, socket);
  sockets.delete(socket);
  rootLogger.debug({ userId: state.userId }, 'realtime client disconnected');
}

function participantsOf(meetingId: string): string[] {
  const room = rooms.get(meetingId);
  if (!room) return [];
  return [...room].map((socket) => sockets.get(socket)?.userId).filter((id): id is string => Boolean(id));
}

/** Publishes to Redis so every instance relays to its own local sockets. */
async function broadcast(meetingId: string, message: Record<string, unknown>): Promise<void> {
  deliverToRoom(meetingId, message);
  try {
    await redis.publish(MEETING_CHANNEL, JSON.stringify({ meetingId, message, origin: process.pid }));
  } catch (error) {
    rootLogger.warn({ err: error, meetingId }, 'could not fan out realtime message across instances');
  }
}

function deliverToRoom(meetingId: string, message: Record<string, unknown>): void {
  const room = rooms.get(meetingId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const socket of room) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

function deliverToUser(userId: string, message: unknown): void {
  const targets = userSockets.get(userId);
  if (!targets) return;
  const data = JSON.stringify({ type: 'notification', payload: message });
  for (const socket of targets) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

let subscribed = false;

function subscribeToRedis(): void {
  if (subscribed) return;
  subscribed = true;

  const connection = subscriber();
  void connection.subscribe(MEETING_CHANNEL, NOTIFICATION_CHANNEL);

  connection.on('message', (channel, raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (channel === MEETING_CHANNEL) {
        // Skip the echo of a message this process just published locally.
        if (parsed.origin === process.pid) return;
        deliverToRoom(parsed.meetingId, parsed.message);
      } else if (channel === NOTIFICATION_CHANNEL) {
        deliverToUser(parsed.userId, parsed.payload);
      }
    } catch (error) {
      rootLogger.warn({ err: error, channel }, 'could not process realtime broadcast');
    }
  });
}

function addUserSocket(userId: string, socket: WebSocket): void {
  const existing = userSockets.get(userId) ?? new Set<WebSocket>();
  existing.add(socket);
  userSockets.set(userId, existing);
}

function removeUserSocket(userId: string, socket: WebSocket): void {
  const existing = userSockets.get(userId);
  existing?.delete(socket);
  if (existing && existing.size === 0) userSockets.delete(userId);
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
