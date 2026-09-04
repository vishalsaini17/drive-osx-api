-- Mail, meetings, notifications, audit and the domain-event outbox.

CREATE TABLE emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id      text,
  thread_id       text,
  from_address    text NOT NULL,
  to_address      text NOT NULL,
  cc_address      text,
  bcc_address     text,
  subject         text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  body_html       text,
  folder          text NOT NULL DEFAULT 'inbox'
                    CHECK (folder IN ('inbox', 'sent', 'drafts', 'trash', 'spam', 'archive')),
  is_unread       boolean NOT NULL DEFAULT true,
  is_starred      boolean NOT NULL DEFAULT false,
  is_pinned       boolean NOT NULL DEFAULT false,
  is_important    boolean NOT NULL DEFAULT false,
  labels          text[] NOT NULL DEFAULT '{}',
  -- Attachment metadata only; the bytes live in object storage (CLAUDE.md §26).
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  size_bytes      bigint NOT NULL DEFAULT 0,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search_vector   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(from_address, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(to_address, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'C')
  ) STORED
);

CREATE INDEX emails_mailbox_idx ON emails (user_id, folder, sent_at DESC);
CREATE INDEX emails_unread_idx ON emails (user_id, folder) WHERE is_unread;
CREATE INDEX emails_starred_idx ON emails (user_id) WHERE is_starred;
CREATE INDEX emails_search_idx ON emails USING gin (search_vector);
CREATE INDEX emails_thread_idx ON emails (thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE meetings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  host_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code                  text NOT NULL UNIQUE,
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled')),
  start_time            timestamptz NOT NULL DEFAULT now(),
  end_time              timestamptz,
  passcode              text,
  waiting_room_enabled  boolean NOT NULL DEFAULT true,
  allow_screen_share    boolean NOT NULL DEFAULT true,
  allow_chat            boolean NOT NULL DEFAULT true,
  allow_unmute          boolean NOT NULL DEFAULT true,
  allow_recording       boolean NOT NULL DEFAULT true,
  is_locked             boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meetings_host_idx ON meetings (host_id, status, start_time DESC);
CREATE INDEX meetings_schedule_idx ON meetings (organization_id, start_time) WHERE status IN ('scheduled', 'active');

CREATE TABLE meeting_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  display_name text NOT NULL,
  role         text NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'cohost', 'participant')),
  is_muted     boolean NOT NULL DEFAULT false,
  is_video_on  boolean NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz
);

CREATE UNIQUE INDEX meeting_participants_active_idx
  ON meeting_participants (meeting_id, user_id)
  WHERE left_at IS NULL AND user_id IS NOT NULL;

CREATE TABLE meeting_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  sender_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  sender_name text NOT NULL,
  body        text NOT NULL,
  attachment  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_messages_meeting_idx ON meeting_messages (meeting_id, created_at);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Append-only. Never updated or deleted by application code (CLAUDE.md §34).
CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  actor_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      text,
  user_agent      text,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

-- Transactional outbox: events are committed with the state change that caused
-- them, then dispatched by the worker (CLAUDE.md §24).
CREATE TABLE domain_events (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  organization_id uuid,
  actor_id        uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  processed_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);

CREATE INDEX domain_events_pending_idx ON domain_events (occurred_at) WHERE processed_at IS NULL;
CREATE INDEX domain_events_name_idx ON domain_events (name, occurred_at DESC);

CREATE TRIGGER emails_updated_at BEFORE UPDATE ON emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER meetings_updated_at BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
