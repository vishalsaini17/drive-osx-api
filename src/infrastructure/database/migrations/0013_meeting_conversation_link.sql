-- ---------------------------------------------------------------------------
-- 0013 — Link a meeting to the conversation its chat/files live in
--
-- A meeting started from an existing conversation (the video/voice call
-- buttons in Messages) is born already linked. A meeting that gains a third
-- distinct participant gets linked to a freshly created group conversation
-- instead, since a direct conversation cannot hold more than two members.
-- Nullable: a brand-new meeting with nobody joined yet has nothing to link to.
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL;

-- A meeting-derived contact is added automatically (being on a call together
-- is at least as strong a mutual-consent signal as accepting a chat request,
-- CLAUDE.md's existing precedent), so the UI needs to be able to say why.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
  CHECK (source IN ('manual', 'chat_request', 'import', 'meeting'));
