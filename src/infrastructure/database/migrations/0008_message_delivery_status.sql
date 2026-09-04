-- ---------------------------------------------------------------------------
-- 0008 — Message delivery status (single/double/blue tick)
--
-- `conversation_participants.last_read_at` already exists and drives unread
-- counts. `last_delivered_at` adds the other half of the watermark: it moves
-- whenever a participant fetches the conversation's messages (their client
-- now has the bytes, whether or not they have looked at them), while
-- `last_read_at` moves only when they explicitly mark the conversation read.
--
-- A sent message's status is derived by comparing its `created_at` against
-- the *other* participant's watermarks — no per-message status column is
-- needed, the same way unread counts never needed one.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz;
