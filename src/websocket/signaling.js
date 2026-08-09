import { Server } from 'ws';
import jwt from 'jsonwebtoken';

const meetings = new Map();

export function createSignalingServer(server) {
  const wss = new Server({ server, path: '/ws/meetings' });

  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    let userId = null;

    try {
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
        userId = decoded.id;
      }
    } catch {
      userId = 'anonymous';
    }

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, userId, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      console.log(`WebSocket disconnected: ${userId}`);
    });
  });

  return wss;
}

function handleMessage(ws, userId, message) {
  const { type, meetingId, payload } = message;

  switch (type) {
    case 'join':
      handleJoin(ws, userId, meetingId, payload);
      break;
    case 'leave':
      handleLeave(ws, userId, meetingId);
      break;
    case 'offer':
      broadcastToMeeting(meetingId, { type: 'offer', from: userId, payload });
      break;
    case 'answer':
      broadcastToMeeting(meetingId, { type: 'answer', from: userId, payload });
      break;
    case 'ice-candidate':
      broadcastToMeeting(meetingId, { type: 'ice-candidate', from: userId, payload });
      break;
    default:
      console.warn('Unknown WebSocket message type:', type);
  }
}

function handleJoin(ws, userId, meetingId, payload) {
  if (!meetings.has(meetingId)) {
    meetings.set(meetingId, new Map());
  }

  const meeting = meetings.get(meetingId);
  meeting.set(userId, ws);

  ws.meetingId = meetingId;
  ws.userId = userId;

  console.log(`User ${userId} joined meeting ${meetingId}`);

  broadcastToMeeting(meetingId, {
    type: 'user-joined',
    userId,
    participants: Array.from(meeting.keys()),
  });
}

function handleLeave(ws, userId, meetingId) {
  const meeting = meetings.get(meetingId);
  if (meeting) {
    meeting.delete(userId);
    if (meeting.size === 0) {
      meetings.delete(meetingId);
    }
  }

  broadcastToMeeting(meetingId, {
    type: 'user-left',
    userId,
    participants: Array.from(meeting?.keys() || []),
  });
}

function broadcastToMeeting(meetingId, message) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;

  const data = JSON.stringify(message);
  meeting.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}
