-- Direct messaging, chat requests, contacts and presence.
--
-- Messaging is gated: two users cannot exchange messages until a chat request
-- has been accepted. Accepting a request creates the conversation and the
-- reciprocal contact rows in one transaction, so the three always agree.

-- ---------------------------------------------------------------------------
-- Chat requests
-- ---------------------------------------------------------------------------

CREATE TABLE chat_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  requester_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Deliberately short: a request carries an introduction, not a conversation.
  message         text NOT NULL DEFAULT '' CHECK (char_length(message) <= 280),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  responded_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_requests_not_self CHECK (requester_id <> recipient_id)
);

-- At most one live request between a given pair, in either direction.
CREATE UNIQUE INDEX chat_requests_pending_pair_idx
  ON chat_requests (least(requester_id, recipient_id), greatest(requester_id, recipient_id))
  WHERE status = 'pending';

CREATE INDEX chat_requests_recipient_idx ON chat_requests (recipient_id, status, created_at DESC);
CREATE INDEX chat_requests_requester_idx ON chat_requests (requester_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'group')),
  -- Group conversations carry a title; direct ones are named after the peer.
  title           text,
  topic           text,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Denormalised for conversation-list ordering without touching messages.
  last_message_at timestamptz,
  last_message_preview text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversations_org_idx ON conversations (organization_id, last_message_at DESC NULLS LAST);

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  is_muted        boolean NOT NULL DEFAULT false,
  is_pinned       boolean NOT NULL DEFAULT false,
  -- Everything after this timestamp counts as unread for this participant.
  last_read_at    timestamptz,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id);

-- One direct conversation per pair. The generated pair key lets a unique index
-- enforce it without a trigger.
CREATE TABLE direct_conversation_keys (
  conversation_id uuid PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  user_a_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT direct_pair_ordered CHECK (user_a_id < user_b_id)
);

CREATE UNIQUE INDEX direct_conversation_pair_idx
  ON direct_conversation_keys (user_a_id, user_b_id);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  body            text NOT NULL DEFAULT '',
  -- Threads: a reply points at the message that opened the thread.
  thread_parent_id uuid REFERENCES messages (id) ON DELETE CASCADE,
  reply_to_id     uuid REFERENCES messages (id) ON DELETE SET NULL,
  -- Attachment metadata only; bytes live in object storage (CLAUDE.md §11).
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  reactions       jsonb NOT NULL DEFAULT '{}'::jsonb,
  mentions        text[] NOT NULL DEFAULT '{}',
  is_edited       boolean NOT NULL DEFAULT false,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_idx
  ON messages (conversation_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX messages_thread_idx
  ON messages (thread_parent_id, created_at) WHERE thread_parent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- A contact normally points at a platform user; external ones do not.
  contact_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  display_name    text NOT NULL,
  email           text,
  phone           text,
  company         text,
  job_title       text,
  notes           text,
  is_favourite    boolean NOT NULL DEFAULT false,
  -- How this contact came to exist, so the UI can explain it.
  source          text NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'chat_request', 'import')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_not_self CHECK (owner_id <> contact_user_id)
);

CREATE UNIQUE INDEX contacts_owner_user_idx
  ON contacts (owner_id, contact_user_id) WHERE contact_user_id IS NOT NULL;
CREATE INDEX contacts_owner_idx ON contacts (owner_id, display_name);

-- ---------------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------------

-- Durable presence. Redis holds the live heartbeat (CLAUDE.md §12); this row
-- is the rebuildable projection that survives a restart and drives "last seen".
CREATE TABLE user_presence (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'offline'
                 CHECK (status IN ('online', 'away', 'busy', 'dnd', 'offline')),
  status_text  text NOT NULL DEFAULT '',
  status_emoji text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_presence_status_idx ON user_presence (status, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER chat_requests_updated_at BEFORE UPDATE ON chat_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER messages_updated_at BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_presence_updated_at BEFORE UPDATE ON user_presence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
