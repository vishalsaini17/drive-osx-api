-- ---------------------------------------------------------------------------
-- 0007 — Chat history actually clears when a chat is deleted
--
-- 0006 gave "delete chat" a `deleted_at` per participant, but that alone only
-- hid the conversation from the sidebar: the moment either side sent a new
-- message, `deleted_at` was cleared and the *entire* old history came back —
-- from the deleter's point of view nothing had actually been deleted.
--
-- `history_cleared_at` is a permanent per-participant cutoff, independent of
-- `deleted_at`: `listMessages` and `listMedia` hide anything created at or
-- before it, and — unlike `deleted_at` — it is never reset by a new message.
-- Deleting a chat sets both columns; only `deleted_at` clears when the
-- conversation becomes active again, so a revived chat shows just the new
-- messages for the person who deleted it, while the other participant (who
-- never set a cutoff) keeps seeing everything.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS history_cleared_at timestamptz;
