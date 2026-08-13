-- ---------------------------------------------------------------------------
-- 0005 — Contact detail fields
--
-- The Contacts application already collects an address, website, birthday,
-- department, team and labels, but `contacts` (migration 0004) had nowhere to
-- put them, so the form accepted the input and threw it away on save. Storing
-- them is the smaller change; silently discarding what a user typed is the
-- kind of defect that only shows up after they rely on it.
--
-- Every column is nullable with no default, so existing rows are untouched and
-- nothing has to be backfilled.
-- ---------------------------------------------------------------------------

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS address     text,
  ADD COLUMN IF NOT EXISTS website     text,
  -- Date, not timestamptz: a birthday has no time of day and must not shift
  -- across time zones.
  ADD COLUMN IF NOT EXISTS birthday    date,
  ADD COLUMN IF NOT EXISTS department  text,
  ADD COLUMN IF NOT EXISTS team        text,
  -- Free-form tags chosen by the owner ("Work", "VIP", …). An array keeps them
  -- queryable without a join table, which no feature currently needs.
  ADD COLUMN IF NOT EXISTS labels      text[] NOT NULL DEFAULT '{}';

-- Supports filtering the address book by label, which the sidebar does.
CREATE INDEX IF NOT EXISTS contacts_labels_idx ON contacts USING gin (labels);

-- Supports the sidebar's company and department groupings without scanning
-- every contact the owner has.
CREATE INDEX IF NOT EXISTS contacts_owner_company_idx
  ON contacts (owner_id, company) WHERE company IS NOT NULL;
