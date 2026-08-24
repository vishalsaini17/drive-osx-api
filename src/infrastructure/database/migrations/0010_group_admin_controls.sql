-- ---------------------------------------------------------------------------
-- 0010 — Group admin-only edits, group avatar
--
-- `avatar_url` follows the exact pattern `users.avatar_url` already uses
-- (identity.repository.ts): a plain string — an emoji shorthand or an
-- `http…` image URL — set directly, not an object-storage upload. Groups get
-- the same low-fidelity avatar the rest of the app already has for people,
-- rather than a second, inconsistent upload pipeline.
--
-- No new column is needed to gate editing to admins: `conversation_participants.role`
-- (0004) already distinguishes owner/admin/member, so the service layer just
-- has to check it before renaming, re-describing, re-picturing, or adding to
-- a group.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS avatar_url text;
