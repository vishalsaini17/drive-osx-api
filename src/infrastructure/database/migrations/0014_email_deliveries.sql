-- Per-recipient outbound delivery tracking (CLAUDE.md §39: uploads/sends are
-- asynchronous operations and must be observable, not fire-and-forget).

CREATE TABLE email_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id          uuid NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  recipient_address text NOT NULL,
  kind              text NOT NULL DEFAULT 'to' CHECK (kind IN ('to', 'cc', 'bcc')),
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'failed', 'retrying', 'bounced')),
  attempts          int NOT NULL DEFAULT 0,
  last_error        text,
  mx_host           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_deliveries_email_idx ON email_deliveries (email_id);
CREATE INDEX email_deliveries_status_idx ON email_deliveries (status) WHERE status IN ('queued', 'retrying');

CREATE TRIGGER email_deliveries_updated_at BEFORE UPDATE ON email_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
