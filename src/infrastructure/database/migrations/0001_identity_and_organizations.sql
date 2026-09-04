-- Core tenancy and identity.
-- Every tenant-scoped table carries organization_id (CLAUDE.md §15, §16):
-- one shared database, tenant isolation enforced in queries and policy code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  type                text NOT NULL CHECK (type IN ('personal', 'organization')),
  owner_id            uuid,
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_quota_bytes bigint NOT NULL DEFAULT 16106127360,
  storage_used_bytes  bigint NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username                text NOT NULL UNIQUE,
  email                   text NOT NULL UNIQUE,
  first_name              text NOT NULL,
  last_name               text NOT NULL,
  full_name               text NOT NULL,
  recovery_email          text,
  mobile                  text,
  password_hash           text NOT NULL,
  avatar_url              text,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  primary_organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  current_organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  mfa_enabled             boolean NOT NULL DEFAULT false,
  last_login_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organizations
  ADD CONSTRAINT organizations_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT;

CREATE INDEX users_recovery_email_idx ON users (recovery_email) WHERE recovery_email IS NOT NULL;
CREATE INDEX organizations_owner_idx ON organizations (owner_id);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'manager', 'member', 'guest')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
  invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id, status);
CREATE INDEX memberships_organization_idx ON memberships (organization_id, status);

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE team_members (
  team_id  uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role     text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members (user_id);

-- Refresh tokens are stored hashed; a database leak cannot be replayed.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id    uuid REFERENCES organizations (id) ON DELETE SET NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent         text,
  ip_address         text,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id) WHERE used_at IS NULL;

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
