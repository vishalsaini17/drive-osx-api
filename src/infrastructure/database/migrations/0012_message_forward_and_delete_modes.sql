-- ---------------------------------------------------------------------------
-- 0012 — Forwarded label, two-sided delete
--
-- `forwarded` marks a message created by forwardMessage, so the client can
-- show WhatsApp's "Forwarded" label above it.
--
-- `deleted_for` backs "Delete for me": a per-viewer hide list, distinct from
-- `deleted_at` (0004), which now specifically means "deleted for everyone" —
-- the sender tombstoned it, so every participant sees a placeholder instead
-- of the original content. `deleted_for` never touches the row other
-- participants see; it only removes the message from the listing queries run
-- for the users named in it.
-- ---------------------------------------------------------------------------

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_for uuid[] NOT NULL DEFAULT '{}';
