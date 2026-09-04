-- ---------------------------------------------------------------------------
-- 0006 — Contact panel actions
--
-- Backs the WhatsApp-style contact panel: blocking a contact, and deleting a
-- chat for yourself without touching the other participant's copy.
--
-- Blocking lives on `contacts` rather than a separate table because messaging
-- already requires a contact row to exist between two users (accepting a chat
-- request creates one for each side — see 0004), so there is nowhere a block
-- state would need to live that this row cannot already reach.
--
-- Chat deletion is per participant, not per conversation: `conversations` and
-- `messages` are unchanged, and only the deleting participant's row in
-- `conversation_participants` is marked. The other participant's copy, and
-- the message history itself, are untouched.
-- ---------------------------------------------------------------------------

-- The existing `contacts_owner_user_idx` unique index on (owner_id,
-- contact_user_id) already serves an equality lookup for either direction of
-- a pair, so blocking needs no index of its own.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false;

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
