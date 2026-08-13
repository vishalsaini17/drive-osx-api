/**
 * Domain events decouple side effects (thumbnails, indexing, notifications,
 * audit) from the transaction that produced them (CLAUDE.md §24).
 *
 * The catalogue is a closed union on purpose — this is a deliberate set of
 * business facts, not an open event bus.
 */
export interface DomainEventMap {
  'user.registered': { userId: string; organizationId: string; username: string };
  'user.logged_in': { userId: string; organizationId: string | null };
  'organization.created': { organizationId: string; ownerId: string; type: string };
  'organization.member_added': { organizationId: string; userId: string; role: string; invitedBy: string };
  'file.uploaded': { organizationId: string; fileId: string; ownerId: string; mimeType: string; size: number };
  'file.updated': { organizationId: string; fileId: string; actorId: string };
  'file.version_created': { organizationId: string; fileId: string; versionId: string; actorId: string };
  'file.renamed': { organizationId: string; fileId: string; actorId: string; from: string; to: string };
  'file.moved': { organizationId: string; fileId: string; actorId: string; toParentId: string | null };
  'file.trashed': { organizationId: string; fileId: string; actorId: string };
  'file.restored': { organizationId: string; fileId: string; actorId: string };
  'file.deleted': { organizationId: string; fileId: string; actorId: string; storageKeys: string[] };
  'file.shared': {
    organizationId: string;
    fileId: string;
    actorId: string;
    principalType: string;
    principalId: string | null;
    role: string;
  };
  'mail.received': { organizationId: string; emailId: string; userId: string };
  'mail.sent': { organizationId: string; emailId: string; userId: string; to: string };
  'meeting.created': { organizationId: string; meetingId: string; hostId: string };
  'meeting.ended': { organizationId: string; meetingId: string };
  'chat.request_sent': { organizationId: string; requestId: string; requesterId: string; recipientId: string };
  'chat.request_accepted': {
    organizationId: string;
    requestId: string;
    conversationId: string;
    requesterId: string;
    recipientId: string;
  };
  'chat.message_sent': {
    organizationId: string;
    conversationId: string;
    messageId: string;
    senderId: string;
  };
}

export type DomainEventName = keyof DomainEventMap;

export interface DomainEvent<N extends DomainEventName = DomainEventName> {
  id: string;
  name: N;
  organizationId: string | null;
  actorId: string | null;
  payload: DomainEventMap[N];
  occurredAt: string;
}

export type DomainEventHandler<N extends DomainEventName = DomainEventName> = (
  event: DomainEvent<N>,
) => Promise<void>;
