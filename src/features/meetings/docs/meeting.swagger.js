export default {
  '/api/v1/meetings': {
    post: {
      tags: ['Meetings'],
      summary: 'Create a new meeting',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', example: 'Weekly Sync' },
                description: { type: 'string', example: 'Weekly team sync meeting' },
                startTime: { type: 'string', format: 'date-time' },
                endTime: { type: 'string', format: 'date-time' },
                passcode: { type: 'string', example: '1234' },
                waitingRoomEnabled: { type: 'boolean', example: true },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Meeting created successfully' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/today': {
    get: {
      tags: ['Meetings'],
      summary: 'Get today\'s meetings',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'List of today\'s meetings' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}': {
    get: {
      tags: ['Meetings'],
      summary: 'Get meeting by ID',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Meeting details' },
        404: { description: 'Meeting not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/start': {
    post: {
      tags: ['Meetings'],
      summary: 'Start a meeting',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Meeting started' },
        404: { description: 'Meeting not found' },
        400: { description: 'Meeting already ended or cancelled' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/join': {
    post: {
      tags: ['Meetings'],
      summary: 'Join a meeting',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                passcode: { type: 'string', example: '1234' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Joined meeting successfully' },
        404: { description: 'Meeting not found' },
        403: { description: 'Meeting locked or incorrect passcode' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/leave': {
    post: {
      tags: ['Meetings'],
      summary: 'Leave a meeting',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Left meeting successfully' },
        404: { description: 'Meeting not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/end': {
    post: {
      tags: ['Meetings'],
      summary: 'End a meeting (host only)',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Meeting ended' },
        404: { description: 'Meeting not found' },
        403: { description: 'Only host can end meeting' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/chat': {
    post: {
      tags: ['Meetings'],
      summary: 'Send a chat message',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                text: { type: 'string', example: 'Hello everyone!' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Message sent' },
        404: { description: 'Meeting not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/v1/meetings/{meetingId}/participant': {
    patch: {
      tags: ['Meetings'],
      summary: 'Update participant status',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'meetingId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                isMuted: { type: 'boolean' },
                isVideoOn: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Participant updated' },
        404: { description: 'Meeting or participant not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
};
