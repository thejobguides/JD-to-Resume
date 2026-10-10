-- Opt-in content store for product analysis. Only users who tick "save my data to improve the product" have rows:
-- the job posts they analyze, the minimized resume they send for tailoring (no name or contact details) and the
-- tailored result. Encrypted at rest (AES-GCM, CONTENT_ENCRYPTION_KEY, AAD binds each row to its user and kind),
-- kept 12 months (expires_at), deleted when the user opts out or deletes the account (FK cascade).
ALTER TABLE users ADD COLUMN content_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN content_opt_in_at timestamptz;

CREATE TABLE stored_content (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('job_post', 'resume', 'result')),
  optimization_id uuid,
  job_analysis_id uuid,
  -- Non-sensitive descriptors for aggregate analysis without decrypting (title, company, host, sizes, scores, models).
  meta jsonb NOT NULL DEFAULT '{}',
  bytes int NOT NULL,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX stored_content_user ON stored_content (user_id, created_at DESC);
CREATE INDEX stored_content_optimization ON stored_content (optimization_id) WHERE optimization_id IS NOT NULL;
CREATE INDEX stored_content_created ON stored_content (created_at DESC);
CREATE INDEX stored_content_expires ON stored_content (expires_at);
