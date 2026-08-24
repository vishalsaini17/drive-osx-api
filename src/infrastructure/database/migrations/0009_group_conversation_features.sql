-- ---------------------------------------------------------------------------
-- 0009 — Group info panel: favouriting, membership
--
-- Group descriptions reuse `conversations.topic` (already present since 0004,
-- previously unused) — no schema change needed for that.
--
-- Favouriting a conversation is new: a direct chat's "favourite" today comes
-- from the peer's contact record, but a group has no single contact to
-- favourite. `is_favourite` on `conversation_participants` (parallel to the
-- `is_pinned`/`is_muted` columns already there) gives every conversation —
-- direct or group — the same per-participant favourite, independent of any
-- contact record.
--
-- Membership changes (adding a member, leaving) work entirely through the
-- existing `conversation_participants` rows and `role` column — no new
-- columns needed there either.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS is_favourite boolean NOT NULL DEFAULT false;
