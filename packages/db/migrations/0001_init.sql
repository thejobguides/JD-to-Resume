-- Job Match Optimizer — initial schema (research/database-design.md §3). PostgreSQL 16+.
-- The server never stores resume or JD content (§6.4) except the transient, encrypted optimization mailbox (≤ 24 h).

CREATE EXTENSION IF NOT EXISTS citext;

-- ── 3.1 Identity and auth ──
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext UNIQUE NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  display_name text,
  locale text NOT NULL DEFAULT 'en',
  country_code char(2),
  age_confirmed_18 boolean NOT NULL DEFAULT false,
  consent_version text NOT NULL DEFAULT '2026-09',
  telemetry_opt_in boolean NOT NULL DEFAULT false,
  history_opt_in boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending_deletion')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  device_label text,
  ip_hash bytea,
  kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','admin')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  last_step_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX auth_sessions_family ON auth_sessions (family_id);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY,
  identifier citext NOT NULL,
  code_hash bytea NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier ON auth_verifications (identifier, created_at DESC);

-- ── 3.2 Plans, subscriptions and usage ──
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('free','subscription','one_time')),
  billing_interval text CHECK (billing_interval IN ('month','year')),
  billing_frequency smallint,
  active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE plan_prices (
  id uuid PRIMARY KEY,
  plan_id text NOT NULL REFERENCES plans(id),
  paddle_price_id text NOT NULL UNIQUE,
  currency char(3) NOT NULL,
  unit_amount_minor int NOT NULL,
  status text NOT NULL CHECK (status IN ('active','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX one_active_price ON plan_prices (plan_id, currency) WHERE status = 'active';

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  paddle_price_id text,
  coupon_redemption_id uuid,
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','paused')),
  paddle_customer_id text,
  paddle_subscription_id text UNIQUE,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  paddle_event_id text UNIQUE NOT NULL,
  event_type text NOT NULL,
  payload_min jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE TABLE credit_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pack','promo','admin_grant','refund_reversal')),
  optimizations int NOT NULL,
  remaining int NOT NULL,
  paddle_transaction_id text UNIQUE,
  expires_at timestamptz,
  granted_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'admin_grant' OR (granted_by IS NOT NULL AND reason IS NOT NULL))
);

-- Exact quota counters (the Postgres implementation of the UserQuota store; a Durable Object replaces it on Workers).
CREATE TABLE usage_counters (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period text NOT NULL,                  -- 'm:2026-09' or 'd:2026-09-30'
  optimizations int NOT NULL DEFAULT 0,
  analyses int NOT NULL DEFAULT 0,
  structures int NOT NULL DEFAULT 0,
  ai_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  in_flight int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

CREATE TABLE usage_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('analysis','optimization','resume_structure','validation')),
  units int NOT NULL DEFAULT 1,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  optimization_id uuid,
  reservation_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released')),
  outcome text CHECK (outcome IN ('success','failed_uncharged','failed_charged')),
  used_credit boolean NOT NULL DEFAULT false,
  credit_grant_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX usage_ledger_user ON usage_ledger (user_id, occurred_at);

CREATE TABLE ai_usage_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  analyses int NOT NULL DEFAULT 0,
  optimizations int NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  by_step jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, day)
);

-- ── 3.3 Resumes (metadata only), jobs, analyses ──
CREATE TABLE resumes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resume_versions (
  id uuid PRIMARY KEY,
  resume_id uuid NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  parent_version_id uuid REFERENCES resume_versions(id) ON DELETE SET NULL,
  version_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('uploaded','edited','optimized')),
  content_sha256 text NOT NULL,
  parse_quality numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_analyses (              -- shared, derived cache; no user data
  id uuid PRIMARY KEY,
  jd_hash text NOT NULL,
  prompt_version text NOT NULL,
  model_tier text NOT NULL,
  analysis jsonb NOT NULL,
  model_id text,
  hits int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jd_hash, prompt_version, model_tier)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_analysis_id uuid REFERENCES job_analyses(id) ON DELETE SET NULL,
  jd_hash text NOT NULL,
  title text, company text, host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, jd_hash)
);

-- ── 3.4 Optimizations, AI requests, providers, prompts ──
CREATE TABLE optimizations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_analysis_id uuid,
  idempotency_key text NOT NULL,
  mode text NOT NULL DEFAULT 'hosted' CHECK (mode IN ('hosted','byok')),
  status text NOT NULL CHECK (status IN ('queued','running','validating','repairing','succeeded','partial','failed','canceled')),
  step text,
  progress numeric(4,3) NOT NULL DEFAULT 0,
  reservation_id uuid,
  config_snapshot_id text,
  before_score smallint, after_score smallint, ceiling_score smallint,
  change_summary jsonb,
  gates jsonb,
  meta jsonb,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX optimizations_user ON optimizations (user_id, created_at DESC);

-- Transient result mailbox (architecture.md §10: ≤ 24 h). AES-GCM encrypted with a server key; deleted after fetch.
CREATE TABLE optimization_mailbox (
  optimization_id uuid PRIMARY KEY REFERENCES optimizations(id) ON DELETE CASCADE,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE ai_providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('openai','anthropic','google','openai_compatible','mock')),
  base_url text,
  production_allowed boolean NOT NULL DEFAULT false,
  personal_data_allowed boolean NOT NULL DEFAULT false,
  trains_on_inputs text NOT NULL DEFAULT 'unknown' CHECK (trains_on_inputs IN ('yes','no','unknown')),
  retention_note text, terms_url text, terms_reviewed_on date,
  dpa_signed_at date, zdr boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true
);

CREATE TABLE ai_models (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES ai_providers(id),
  provider_model_id text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('cheap','strong','embedding','any')),
  capabilities jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','eval_only','approved','retired')),
  approved_tasks text[] NOT NULL DEFAULT '{}',
  input_per_mtok numeric(10,4) NOT NULL, cached_input_per_mtok numeric(10,4), output_per_mtok numeric(10,4),
  token_factor numeric(4,2) NOT NULL DEFAULT 1.00,
  effective_from date NOT NULL, effective_to date,
  source_url text NOT NULL, checked_on date NOT NULL
);

CREATE TABLE provider_credentials (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES ai_providers(id),
  label text NOT NULL,
  env text NOT NULL CHECK (env IN ('production','staging','eval')),
  scope text NOT NULL CHECK (scope IN ('production','non_production')),
  ciphertext bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  iv bytea NOT NULL,
  vault_key_version smallint NOT NULL,
  last4 char(4) NOT NULL,
  status text NOT NULL CHECK (status IN ('active','standby','revoked')),
  monthly_soft_budget_usd numeric(10,2),
  last_used_at timestamptz, last_test_at timestamptz, last_test_result text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_from text REFERENCES provider_credentials(id),
  revoked_at timestamptz, revoked_by uuid
);

CREATE TABLE prompt_versions (
  id text PRIMARY KEY,
  content_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','shadow','canary','live','retired')),
  rollout_pct smallint NOT NULL DEFAULT 0,
  eval_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_requests (              -- metadata only; NO prompt/response content. Partitioned monthly.
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  optimization_id uuid,
  job_analysis_id uuid,
  task text NOT NULL,
  prompt_version_id text NOT NULL,
  model_id text NOT NULL,
  provider_id text NOT NULL,
  config_snapshot_id text,
  request_id text,
  credential_id text,
  plan_id text,
  provider_request_id text,
  attempt smallint NOT NULL DEFAULT 1,
  fallback_used boolean NOT NULL DEFAULT false,
  input_tokens int NOT NULL DEFAULT 0, cached_input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0, reasoning_tokens int NOT NULL DEFAULT 0,
  tokens_estimated boolean NOT NULL DEFAULT false,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms int,
  outcome text NOT NULL,
  cache_hit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE ai_requests_default PARTITION OF ai_requests DEFAULT;
CREATE INDEX ai_requests_created ON ai_requests (created_at);
CREATE INDEX ai_requests_user ON ai_requests (user_id, created_at);
CREATE INDEX ai_requests_opt ON ai_requests (optimization_id);

CREATE OR REPLACE FUNCTION ensure_ai_requests_partition(p_month date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_d date := date_trunc('month', p_month)::date;
  end_d date := (date_trunc('month', p_month) + interval '1 month')::date;
  name text := format('ai_requests_%s', to_char(start_d, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = name) THEN
    -- Move any rows for this month out of the default partition first (keeps the attach valid).
    EXECUTE format('CREATE TABLE %I (LIKE ai_requests INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', name);
    EXECUTE format('INSERT INTO %I SELECT * FROM ai_requests_default WHERE created_at >= %L AND created_at < %L', name, start_d, end_d);
    EXECUTE format('DELETE FROM ai_requests_default WHERE created_at >= %L AND created_at < %L', start_d, end_d);
    EXECUTE format('ALTER TABLE ai_requests ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', name, start_d, end_d);
  END IF;
END $$;

-- ── 3.5 Feedback, compliance, evals ──
CREATE TABLE feedback (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  optimization_id uuid REFERENCES optimizations(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('score','bullet','summary','export','extraction','general')),
  target_ref text,
  rating smallint CHECK (rating BETWEEN -1 AND 5),
  reason_code text,
  comment text,
  content_shared boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','tagged','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  requested_by text NOT NULL DEFAULT 'user',
  steps jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','admin','system','webhook')),
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  request_id text,
  ip_hash bytea,
  device_label text,
  prev_hash bytea,
  row_hash bytea NOT NULL,
  CHECK (actor_type <> 'admin' OR action LIKE '%.view' OR action LIKE '%reveal%' OR action LIKE 'admin.login%' OR reason IS NOT NULL)
);
CREATE INDEX audit_target ON audit_log (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_actor ON audit_log (actor_id, occurred_at DESC);
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('jmo.audit_prune', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY,
  suite text NOT NULL,
  git_sha text NOT NULL,
  prompt_versions jsonb NOT NULL,
  models jsonb NOT NULL,
  metrics jsonb NOT NULL,
  passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  key text NOT NULL,
  route text NOT NULL,
  request_sha256 text NOT NULL,
  response jsonb,
  status_code int,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key, route)
);

-- ── 3.6 Admin, runtime configuration, coupons, grants, analytics ──
CREATE TABLE admin_members (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner','admin','support','finance','analyst')),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE config_versions (
  id uuid PRIMARY KEY,
  namespace text NOT NULL CHECK (namespace IN ('plans','ai_routing','budgets','prompts','scoring','extraction','features','kill_switches','limits','announcements','retention','coupons_policy','insights')),
  env text NOT NULL CHECK (env IN ('staging','production','eval')),
  version int NOT NULL,
  data jsonb NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('draft','approved','canary','active','superseded','rolled_back','rejected')),
  rollout_pct smallint NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  eval_run_id uuid REFERENCES eval_runs(id),
  change_note text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, activated_by uuid, activated_at timestamptz,
  UNIQUE (namespace, env, version)
);
CREATE UNIQUE INDEX one_active_config ON config_versions (namespace, env) WHERE status = 'active';
CREATE UNIQUE INDEX one_canary_config ON config_versions (namespace, env) WHERE status = 'canary';

CREATE TABLE config_snapshots (
  id text PRIMARY KEY,
  env text NOT NULL,
  version_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupons (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  campaign text,
  status text NOT NULL CHECK (status IN ('draft','active','paused','expired','archived')),
  max_redemptions int CHECK (max_redemptions > 0),
  max_per_user smallint NOT NULL DEFAULT 1 CHECK (max_per_user > 0),
  new_customers_only boolean NOT NULL DEFAULT false,
  allowed_email_domains text[],
  max_discount_total_usd numeric(10,2),
  restore_use_on_refund boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  first_redeemed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from)
);

CREATE TABLE coupon_plan_rules (
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  plan_id text NOT NULL REFERENCES plans(id),
  percent_off numeric(5,2) NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  duration text NOT NULL CHECK (duration IN ('first_period','repeating','forever')),
  duration_periods smallint,
  ai_budget_override_usd numeric(8,2),
  paddle_discount_id text UNIQUE,
  PRIMARY KEY (coupon_id, plan_id),
  CHECK ((duration = 'repeating') = (duration_periods IS NOT NULL AND duration_periods >= 2))
);

CREATE TABLE coupon_codes (
  id uuid PRIMARY KEY,
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  code text NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 4 AND 32),
  max_uses int CHECK (max_uses > 0),
  batch_id uuid,
  status text NOT NULL CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY,
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  code_id uuid NOT NULL REFERENCES coupon_codes(id),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  plan_id text NOT NULL REFERENCES plans(id),
  status text NOT NULL CHECK (status IN ('reserved','completed','released','refunded')),
  reserved_until timestamptz,
  paddle_transaction_id text UNIQUE,
  paddle_subscription_id text,
  list_amount_minor int,
  discount_amount_minor int,
  currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX coupon_redemptions_coupon ON coupon_redemptions (coupon_id, status);
CREATE INDEX coupon_redemptions_user ON coupon_redemptions (user_id, coupon_id);

CREATE TABLE entitlement_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('comp','beta','support','partner')),
  reason text NOT NULL,
  granted_by uuid NOT NULL,
  revoked_at timestamptz, revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '90 days')
);

CREATE TABLE ai_usage_hourly (
  hour timestamptz NOT NULL,
  task text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  credential_id text NOT NULL DEFAULT '',
  plan_id text NOT NULL DEFAULT '',
  prompt_version_id text NOT NULL DEFAULT '',
  calls int NOT NULL, errors int NOT NULL, schema_fails int NOT NULL, fallbacks int NOT NULL, cache_hits int NOT NULL,
  input_tokens bigint NOT NULL, cached_input_tokens bigint NOT NULL, output_tokens bigint NOT NULL, reasoning_tokens bigint NOT NULL,
  estimated_token_calls int NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL,
  shadow_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  latency_hist int[] NOT NULL,
  PRIMARY KEY (hour, task, provider_id, model_id, credential_id, plan_id, prompt_version_id)
);

CREATE TABLE rollup_watermarks (
  name text PRIMARY KEY,
  processed_until timestamptz NOT NULL
);

CREATE TABLE optimization_insights (
  id uuid PRIMARY KEY,
  rule_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warn','critical')),
  scope jsonb NOT NULL,
  evidence jsonb NOT NULL,
  estimated_monthly_impact_usd numeric(10,2),
  status text NOT NULL CHECK (status IN ('open','accepted','dismissed','measured','closed')),
  config_version_id uuid REFERENCES config_versions(id),
  measured_effect jsonb,
  decided_by uuid, decision_reason text,
  detected_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, measured_at timestamptz
);
CREATE UNIQUE INDEX one_open_insight ON optimization_insights (rule_id, (scope::text)) WHERE status = 'open';
