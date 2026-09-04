-- ---------------------------------------------------------------------------
-- 0011 — Per-message pin
--
-- Reactions (jsonb) and reply_to_id already exist (0004) with no service-layer
-- support until now — no schema change needed for those. Pinning needs one new
-- column: this is a property of the message itself, distinct from
-- conversation_participants.is_pinned (0004), which pins a whole chat to the
-- top of one participant's conversation list.
-- ---------------------------------------------------------------------------

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

CREATE INDEX IF NOT EXISTS messages_pinned_idx
  ON messages (conversation_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
