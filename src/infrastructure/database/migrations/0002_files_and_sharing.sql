-- Files are metadata + references to stored objects (CLAUDE.md §11, §38).
-- Bytes live in object storage; this table never holds file contents.

CREATE TABLE files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  parent_id       uuid REFERENCES files (id) ON DELETE RESTRICT,
  name            text NOT NULL,
  type            text NOT NULL DEFAULT 'file' CHECK (type IN ('file', 'folder')),
  mime_type       text NOT NULL DEFAULT 'application/octet-stream',
  size            bigint NOT NULL DEFAULT 0,
  storage_key     text,
  checksum        text,
  starred         boolean NOT NULL DEFAULT false,
  pinned          boolean NOT NULL DEFAULT false,
  version_no      integer NOT NULL DEFAULT 1,
  -- Extracted text, maintained by the indexing worker. Kept separate from the
  -- object so search never has to read from storage.
  content_text    text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search_vector   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(mime_type, '')), 'D') ||
    setweight(to_tsvector('english'::regconfig, coalesce(content_text, '')), 'C')
  ) STORED
);

-- Name collisions are prevented per owner and folder. NULL parent_id means the
-- drive root, so it is normalised to a sentinel to keep the unique index usable.
CREATE UNIQUE INDEX files_unique_name_in_folder
  ON files (organization_id, owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX files_listing_idx ON files (organization_id, owner_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX files_trash_idx ON files (organization_id, owner_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX files_starred_idx ON files (organization_id, owner_id) WHERE starred AND deleted_at IS NULL;
CREATE INDEX files_pinned_idx ON files (organization_id, owner_id) WHERE pinned AND deleted_at IS NULL;
CREATE INDEX files_search_idx ON files USING gin (search_vector);
CREATE INDEX files_name_trgm_idx ON files USING gin (name gin_trgm_ops);
CREATE INDEX files_parent_idx ON files (parent_id) WHERE deleted_at IS NULL;

CREATE TABLE file_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  version_no  integer NOT NULL,
  storage_key text NOT NULL,
  size        bigint NOT NULL DEFAULT 0,
  checksum    text,
  mime_type   text NOT NULL DEFAULT 'application/octet-stream',
  comment     text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_no)
);

CREATE INDEX file_versions_file_idx ON file_versions (file_id, version_no DESC);

-- One row per grant. Link shares store only the hash of the link token.
CREATE TABLE shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  file_id         uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  shared_by       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  principal_type  text NOT NULL CHECK (principal_type IN ('user', 'team', 'organization', 'link')),
  principal_id    uuid,
  role            text NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  token_hash      text UNIQUE,
  message         text,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (principal_type IN ('user', 'team') AND principal_id IS NOT NULL) OR
    (principal_type = 'organization' AND principal_id IS NULL) OR
    (principal_type = 'link' AND token_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX shares_unique_principal
  ON shares (file_id, principal_type, principal_id)
  WHERE revoked_at IS NULL AND principal_type IN ('user', 'team');

CREATE INDEX shares_file_idx ON shares (file_id) WHERE revoked_at IS NULL;
CREATE INDEX shares_principal_idx ON shares (principal_type, principal_id) WHERE revoked_at IS NULL;

-- Uploads that have started but not completed, so a resumable/multipart upload
-- survives a page reload or a lost connection (CLAUDE.md §39).
CREATE TABLE upload_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id         uuid REFERENCES files (id) ON DELETE SET NULL,
  parent_id       uuid REFERENCES files (id) ON DELETE SET NULL,
  filename        text NOT NULL,
  mime_type       text NOT NULL DEFAULT 'application/octet-stream',
  total_bytes     bigint NOT NULL,
  received_bytes  bigint NOT NULL DEFAULT 0,
  storage_key     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'uploading', 'completed', 'failed', 'cancelled')),
  error_message   text,
  -- Client-supplied idempotency key: a retried upload must not create a duplicate.
  client_token    text,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX upload_sessions_client_token_idx
  ON upload_sessions (user_id, client_token)
  WHERE client_token IS NOT NULL;

CREATE INDEX upload_sessions_user_idx ON upload_sessions (user_id, status);

CREATE TRIGGER files_updated_at BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shares_updated_at BEFORE UPDATE ON shares
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER upload_sessions_updated_at BEFORE UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
