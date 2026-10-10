# API Design — AI Resume / Job Match Optimizer

**Purpose.** This document specifies:

- the REST API between the Chrome extension (and the small web app) and the backend: conventions, authentication, errors, rate limits and quotas;
- every endpoint's request and response;
- the async optimization job and SSE progress;
- the Paddle webhook;
- the extension's internal message contracts;
- the BYOK direct-call contract;
- the internal AI interfaces;
- the **admin API** (separate Worker) for the admin panel, runtime config and coupons ([admin-panel.md](admin-panel.md)).

These are contracts only; there is no implementation here. The names match [architecture.md](architecture.md) and [database-design.md](database-design.md).

Last updated: 2026-09-29 · Companion docs: [architecture.md](architecture.md) §2.3 (sequence), §10 (services), [security-threat-model.md](security-threat-model.md) §10, [ai-model-comparison.md](ai-model-comparison.md) §10–11

**Labels:** **[FACT]** · **[ASSUMPTION]** · **[RECOMMENDATION]** · **[OPEN QUESTION]**

---

## Table of contents

1. [Mapping from the brief's endpoints](#1-mapping-from-the-briefs-endpoints)
2. [Global conventions](#2-global-conventions)
3. [Authentication for an MV3 extension](#3-authentication-for-an-mv3-extension)
4. [Errors](#4-errors)
5. [Rate limits and quotas](#5-rate-limits-and-quotas)
6. [Endpoints](#6-endpoints)
7. [Webhooks](#7-webhooks)
8. [Extension internal message contracts](#8-extension-internal-message-contracts)
9. [BYOK direct-call contract](#9-byok-direct-call-contract)
10. [Internal AI interfaces](#10-internal-ai-interfaces)
11. [Admin API](#11-admin-api)
12. [Open questions](#12-open-questions)

---

## 1. Mapping from the brief's endpoints

| Brief | This design | Why it differs |
|---|---|---|
| `POST /api/resumes` | `POST /v1/resumes` (register metadata) + `POST /v1/resumes/structure` (transient AI structuring) | Resume **content stays local**; the server only needs IDs and metadata, plus a stateless structuring call |
| `GET /api/resumes` | `GET /v1/resumes` | Metadata list (labels, versions); content comes from local storage or opt-in sync |
| `POST /api/jobs/analyze` | `POST /v1/jobs/analyze` | Same idea; cached by `jd_hash` |
| `POST /api/resumes/match` | `POST /v1/matches/map` | **Scoring runs locally**; the server only maps ambiguous requirements to evidence |
| `POST /api/resumes/optimize` | `POST /v1/optimizations` (async) + `GET /v1/optimizations/{id}` + `GET …/events` (SSE) | Rewrites take 20–60 s; async + progress survives the panel closing |
| `POST /api/resumes/validate` | `POST /v1/validations` | Re-validates user-edited bullets (G7 entailment); gates G0–G6 run locally |
| `GET /api/usage` | `GET /v1/usage` | Same |
| *(added)* | `/v1/auth/*`, `/v1/me`, `/v1/config`, `/v1/feedback`, `/v1/account/*`, `/v1/billing/*` (incl. coupons), `/v1/sync/*`, `/v1/webhooks/paddle` | Needed for auth, compliance, billing and ops |
| *(added)* | `/admin/v1/*` on a **separate** `admin-api` Worker (§11) | Admin panel: support, coupons, config, traces, audit |

---

## 2. Global conventions

| Topic | Convention |
|---|---|
| Base URL | `https://api.<domain>/v1` (versioned in the path; breaking changes → `/v2`) |
| Format | JSON (UTF-8), `snake_case` fields; timestamps in RFC 3339 UTC; IDs are UUIDv7 strings |
| Required request headers | `Authorization: Bearer <access_jwt>` (except public routes), `X-Extension-Version: 1.4.2`, `X-Request-Id` (client UUID, echoed back), `Content-Type: application/json` |
| Idempotency | `Idempotency-Key` header **required** on `POST /v1/optimizations`, `/v1/billing/checkout` and `/v1/feedback`; stored 24 h; a replay returns the original response |
| Size limits | Body ≤ 256 KB by default; `jobs/analyze` `jd_text` ≤ 20,000 chars; resume payloads ≤ 60 KB |
| Pagination | Cursor based: `?limit=20&cursor=<opaque>` → `{"data":[…], "next_cursor": "…"}` |
| Timeouts | Synchronous endpoints target ≤ 15 s (`jobs/analyze`, `matches/map`, `resumes/structure`, `validations`); long work is async |
| Streaming | SSE (`text/event-stream`) for optimization progress, with a heartbeat every 15 s |
| Version gate | If `X-Extension-Version` < minimum → `426 Upgrade Required` + `{"error":{"code":"extension_outdated"}}` |
| CORS | Allow origins `chrome-extension://<prod-id>`, `chrome-extension://<beta-id>` and `https://app.<domain>`; no credentials (bearer only) |
| Privacy | Request and response bodies are **never logged**; logs carry the request ID, route, status, latency, `user_hash` and plan |
| OpenAPI | Generated from Zod schemas in `packages/shared` → `docs/api/openapi.json` |

---

## 3. Authentication for an MV3 extension

| Item | Design |
|---|---|
| Identity | Better Auth (Hono) with **Google OAuth** and **email OTP** ([architecture.md](architecture.md) §11) |
| Google flow | Side panel calls `chrome.identity.launchWebAuthFlow({url: https://api.<domain>/v1/auth/google/start?redirect_uri=https://<ext-id>.chromiumapp.org/cb&code_challenge=…, interactive: true})` → the backend completes OAuth with Google → redirects to the `chromiumapp.org` URL with a one-time `code` → the extension calls `POST /v1/auth/token` with `code` + `code_verifier` (PKCE). [FACT] `launchWebAuthFlow` supports non-Google IdPs and the `https://<app-id>.chromiumapp.org/*` redirect (https://developer.chrome.com/docs/extensions/reference/api/identity) |
| Email OTP flow | `POST /v1/auth/otp/request {email, turnstile_token}` → the user types the 6-digit code → `POST /v1/auth/otp/verify {email, code}` → tokens |
| Tokens | **Access JWT** (15 min; `sub`, `plan`, `aud=ext`, `iss`, `exp`, `jti`) kept in `chrome.storage.session`. **Refresh token** (opaque, 30 days, rotating, family reuse detection) in `chrome.storage.local` at the TRUSTED_CONTEXTS access level. |
| Refresh | `POST /v1/auth/refresh {refresh_token}` returns a new pair. Reuse of an old token revokes the family and returns 401 `session_revoked`. |
| Logout | `POST /v1/auth/logout` revokes the current family; `POST /v1/auth/logout-all` revokes every session |
| No-account modes | Local and BYOK modes never call authenticated endpoints; `GET /v1/config` is public |

---

## 4. Errors

### 4.1 Error envelope

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "You've used all 3 optimizations for this month.",
    "details": { "limit": 3, "used": 3, "resets_at": "2026-10-01T00:00:00Z", "upgrade_url": "https://app.<domain>/upgrade" },
    "request_id": "01J…",
    "retryable": false
  }
}
```

### 4.2 Error codes

| HTTP | `code` | Meaning | Client behaviour |
|---|---|---|---|
| 400 | `invalid_request` | Schema validation failed (`details.issues[]`) | Fix the request; don't retry |
| 400 | `unsupported_content` | Input doesn't look like a JD or resume, or the language isn't supported | Show a message; offer local mode |
| 401 | `unauthenticated` / `token_expired` | Missing or expired access token | Refresh, then retry once |
| 401 | `session_revoked` | Refresh reuse detected or logged out | Force re-login |
| 403 | `forbidden` | Resource not owned by the user | – |
| 403 | `account_suspended` | Abuse | Show support contact |
| 404 | `not_found` | – | – |
| 409 | `conflict` | Idempotency key reused with a different body; optimization already running | Show the existing job |
| 413 | `payload_too_large` | Size limits | Trim; explain |
| 422 | `coupon_rejected` | Coupon can't be used; `details.reason` ∈ `invalid` (not found, paused or archived: deliberately one reason), `expired`, `not_started`, `not_for_plan` (+ `eligible_plans`), `already_used`, `limit_reached`, `new_customers_only`, `domain_not_allowed` | Show the reason; checkout without the code stays available |
| 422 | `processing_failed` | The AI returned unusable output after retries and fallbacks; **quota not charged** | Show "try again later" |
| 426 | `extension_outdated` | Version gate | Prompt reload |
| 429 | `rate_limited` | Burst limit (`Retry-After` header) | Back off |
| 429 | `quota_exceeded` | Plan quota or AI budget exhausted (`details`) | Upsell; local mode still works |
| 429 | `concurrency_limit` | One optimization already in flight | Show the existing progress |
| 503 | `ai_unavailable` | All providers in the chain failed or a circuit is open (`Retry-After`) | Show "temporarily unavailable" |
| 503 | `maintenance` | – | – |
| 500 | `internal` | Bug (Sentry event ID in `details.event_id`) | Retry once |

---

## 5. Rate limits and quotas

### 5.1 Burst rate limits

Enforced with the Workers Rate Limiting binding ([FACT] 10-second or 60-second windows; "permissive, eventually consistent": https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

| Route group | Per user | Per IP (unauthenticated) |
|---|---|---|
| `auth/otp/request` | – | 5 / 60 s and 20 / day per email (via Postgres) |
| `auth/*` (other) | 20 / 60 s | 30 / 60 s |
| `jobs/analyze`, `matches/map`, `resumes/structure`, `validations` | 20 / 60 s | – |
| `optimizations` (POST) | 3 / 60 s (plus concurrency 1) | – |
| `optimizations/*` (GET, events) | 60 / 60 s | – |
| `config` | – | 60 / 60 s (edge cached anyway) |
| `billing/coupons/preview`, `billing/checkout` with a code | 10 / 60 s and 50 / day (anti-guessing) | – |

### 5.2 Plan quotas

Exact counts are enforced by the UserQuota DO ([cost-analysis.md](cost-analysis.md) §13).

| Plan | Optimizations | Analyses | AI $ budget |
|---|---|---|---|
| Free | 3 / month | 15 / month (JD analyze + map count as 1 analysis per job) | – |
| Pro | 150 / month, 25 / day | 500 / month | $8 / month (router downgrades analyses past 80%) |
| Credit pack | Consumes 1 credit per optimization after the plan quota | – | – |
| BYOK | No hosted AI calls | – | – |

**Charging rule:** an analysis or optimization is charged **only on success**. `processing_failed` and `ai_unavailable` release the reservation.

### 5.3 Rate-limit and quota headers

Returned on AI routes:

```text
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 17
X-Quota-Optimizations-Remaining: 147
X-Quota-Resets-At: 2026-10-01T00:00:00Z
```

---

## 6. Endpoints

### 6.1 `GET /v1/config` (public)

Remote, flat configuration. It is signed: the extension verifies the Ed25519 signature with a bundled public key ([security-threat-model.md](security-threat-model.md) §11 #20).

All values come from the active config versions, which are edited in the admin panel ([admin-panel.md](admin-panel.md) §6). `config_snapshot` is echoed so a screenshot or bug report can be traced to exact versions.

```json
{
  "version": 42,
  "config_snapshot": "cs_7f3a91c2e0b4",
  "min_extension_version": "1.2.0",
  "scoring_version": "score@v2",
  "kill_switches": { "hosted_ai": false, "checkout": false, "coupons": false },
  "announcements": [ { "id": "a12", "text": "Scheduled maintenance Sun 02:00–02:30 ET.", "plans": ["all"], "until": "2026-10-19T06:30:00Z" } ],
  "features": { "hosted_ai": true, "byok": true, "auto_detect_tier_a": false },
  "extractors": [
    { "id": "greenhouse", "hosts": ["job-boards.greenhouse.io", "boards.greenhouse.io"],
      "selectors": { "title": "h1", "company": ".company-name", "description": ".job__description" }, "layers": ["L1","L2","L3"] }
  ],
  "limits": { "jd_max_chars": 20000, "resume_max_pages": 6 },
  "signature": "base64-ed25519…"
}
```

### 6.2 `GET /v1/me`

```json
{ "id": "01J…", "email": "user@example.com", "display_name": "Asha", "plan": "pro_quarterly",
  "subscription": { "status": "active", "current_period_end": "2026-12-28T00:00:00Z", "cancel_at_period_end": false },
  "settings": { "history_opt_in": false, "telemetry_opt_in": true }, "consent_version": "2026-09" }
```

### 6.3 `GET /v1/usage`

```json
{ "period": { "start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z" },
  "optimizations": { "used": 12, "limit": 150, "daily_used": 2, "daily_limit": 25, "credits_remaining": 0 },
  "analyses": { "used": 41, "limit": 500 },
  "ai_budget": { "used_usd": 0.62, "limit_usd": 8.00 } }
```

### 6.4 `POST /v1/jobs/analyze`

JD structuring, with the shared cache.

Request:

```json
{
  "jd_text": "Senior Data Engineer\nAbout the role…",
  "jd_hash": "sha256:9f2c…",
  "source": { "host": "jobs.lever.co", "adapter": "lever", "layers_used": ["L1","L3"] },
  "structured_hint": { "title": "Senior Data Engineer", "company": "Acme", "location": ["Remote (US)"], "employment_type": "FULL_TIME" },
  "locale": "en"
}
```

The server recomputes `jd_hash` from the normalized `jd_text` and rejects a mismatch (400).

Response `200`:

```json
{
  "job_analysis_id": "01J…",
  "cache": "hit",
  "analysis": {
    "schema_version": "1.0",
    "title": "Senior Data Engineer", "company": "Acme", "location": ["Remote (US)"], "work_mode": "remote",
    "employment_type": "FULL_TIME", "salary": { "min": 150000, "max": 180000, "currency": "USD", "interval": "YEAR", "stated": true },
    "requirements": [
      { "req_id": "req_1", "type": "must", "hard": true, "text": "5+ years building data pipelines",
        "skills": ["data pipelines"], "years_min": 5, "quote": "5+ years of experience building data pipelines" },
      { "req_id": "req_7", "type": "must", "hard": false, "text": "Kafka or Kinesis", "skills": ["Kafka","Kinesis"], "quote": "experience with Kafka or Kinesis" },
      { "req_id": "req_12", "type": "preferred", "text": "AWS certification", "skills": ["AWS"], "quote": "AWS certification a plus" }
    ],
    "keywords": ["Kafka", "Airflow", "dbt", "Snowflake", "Python", "SQL", "data modeling"],
    "flags": { "injection_suspected": false, "truncated": false },
    "prompt_version": "jd_extract@v1"
  }
}
```

Charged as 1 analysis on a cache miss. On a cache hit it is still counted toward the analysis quota, but costs us $0 in AI. [OPEN QUESTION] Whether hits should be free.

Errors: `invalid_request`, `unsupported_content`, `quota_exceeded`, `ai_unavailable` (the client then falls back to the deterministic JSON-LD-only analysis).

### 6.5 `POST /v1/resumes/structure`

Transient: nothing is stored.

Request (pseudonymized lines):

```json
{
  "version_id": "01J…",
  "lines": [
    { "span_id": "s_v3_1_1", "text": "{{NAME}}", "page": 1, "style": { "size": 18, "bold": true } },
    { "span_id": "s_v3_1_4", "text": "EXPERIENCE", "page": 1, "style": { "size": 11, "bold": true, "caps": true } },
    { "span_id": "s_v3_1_5", "text": "Data Engineer — Globex   Mar 2021 – Present", "page": 1, "style": { "size": 10.5, "bold": true } },
    { "span_id": "s_v3_1_6", "text": "• Built Kafka-based pipeline processing 2M events/day", "page": 1, "style": { "size": 10 } }
  ],
  "locale": "en"
}
```

Response `200`: a partial `CanonicalResume` ([architecture.md](architecture.md) §5.4) where every field carries `span_ids`, plus `claims[]` and `dropped[]` (values that failed the citation check).

Charged as 0 analyses (structuring is included). It is limited to 10 per day per user, because resumes rarely change.

### 6.6 `POST /v1/matches/map`

Ambiguous requirement mapping. Only the requirements that deterministic matching could not decide are sent.

```json
{
  "job_analysis_id": "01J…",
  "requirements": [ { "req_id": "req_9", "text": "Experience operating Kubernetes in production", "type": "must" } ],
  "evidence": [ { "claim_id": "claim_40", "type": "tool", "text": "Deployed services to EKS with Helm", "role_id": "role_1" } ]
}
```

Response:

```json
{ "mappings": [ { "req_id": "req_9", "state": "partial", "claim_ids": ["claim_40"], "rationale": "EKS is managed Kubernetes; production operation implied by deployment work." } ],
  "prompt_version": "match_map@v1" }
```

The client ignores any `claim_ids` it didn't send.

### 6.7 `POST /v1/optimizations`

Starts the async evidence-bound rewrite.

Headers: `Idempotency-Key: 01J…`

```json
{
  "job_analysis_id": "01J…",
  "resume": {
    "version_id": "01J…",
    "roles": [ { "role_id": "role_2", "employer": "Globex", "title": "Data Engineer", "start": "2021-03", "end": "present",
                 "bullets": [ { "bullet_id": "role_2.b_3", "text": "Built Kafka-based pipeline processing 2M events/day", "claim_ids": ["claim_31","claim_32"] } ] } ],
    "summary": { "summary_id": "sum_1", "text": "Data engineer with 5 years…", "claim_ids": ["claim_2"] },
    "skills": [ { "skill_id": "sk_4", "name": "Kafka", "evidence_level": "demonstrated" } ]
  },
  "claims": [ { "claim_id": "claim_31", "type": "tool", "value": "Kafka", "text": "Built Kafka-based pipeline", "role_id": "role_2" },
              { "claim_id": "claim_32", "type": "metric", "value": { "number": 2000000, "unit": "events/day" }, "role_id": "role_2" } ],
  "targets": { "req_ids": ["req_7", "req_9"], "edit_budget": { "bullets": 8, "summary": true, "skills_order": true } },
  "options": { "tone": "concise", "locale": "en-US", "model_preference": "auto" }
}
```

The resume payload is pseudonymized and minimized: only in-scope roles, and no contact details.

Response `202`:

```json
{ "optimization_id": "01J…", "status": "queued", "events_url": "/v1/optimizations/01J…/events", "estimated_seconds": 35 }
```

Errors: `quota_exceeded`, `concurrency_limit`, `conflict` (idempotency), `payload_too_large`.

### 6.8 `GET /v1/optimizations/{id}/events` (SSE)

```text
event: status
data: {"status":"running","step":"rewrite","progress":0.35}

event: status
data: {"status":"validating","step":"entailment","progress":0.75}

event: status
data: {"status":"succeeded","progress":1.0}

: heartbeat
```

It reconnects with `Last-Event-ID`. When the status is terminal, the client fetches the result.

### 6.9 `GET /v1/optimizations/{id}`

The result can be fetched for 24 h from the DO mailbox, then only metadata remains.

```json
{
  "optimization_id": "01J…", "status": "succeeded",
  "result": {
    "summary": { "text": "Data engineer with 5 years building streaming pipelines…", "claim_ids": ["claim_2","claim_31"] },
    "bullets": [ { "bullet_id": "role_2.b_3", "source_bullet_ids": ["role_2.b_3"],
                   "text": "Built a Kafka-based streaming pipeline processing 2M events/day",
                   "claim_ids": ["claim_31","claim_32"], "emphasized_req_ids": ["req_7"], "validation": "entailed" } ],
    "skills_order": ["sk_4", "sk_9", "sk_1"],
    "not_addressable": [ { "req_id": "req_12", "reason": "no_evidence" } ],
    "reverted": [ { "bullet_id": "role_1.b_5", "reason": "new_metric_not_in_evidence" } ]
  },
  "meta": { "models": ["openai:gpt-6-sol", "openai:gpt-6-luna"], "prompt_versions": ["optimize@v1","validate_entail@v1"],
            "gates": { "G2": 0, "G3": 1, "G7_embellished": 1, "reverted": 1 }, "duration_ms": 31840 }
}
```

The client computes the before and after scores and the ceiling locally, then `PATCH`es the metadata (`before_score`, `after_score`, `ceiling_score`) with `POST /v1/optimizations/{id}/scores` so product metrics exist without content.

### 6.10 Other optimization routes

- `POST /v1/optimizations/{id}/cancel` → `202`; releases the reservation if no strong-model call has completed.
- `GET /v1/optimizations?limit=20&cursor=…` → history metadata (job title, company, scores, dates).

### 6.11 `POST /v1/validations`

Runs G7 entailment for user-edited bullets.

```json
{ "pairs": [ { "bullet_id": "role_2.b_3", "text": "Led Kafka streaming platform…", "evidence_texts": ["Built Kafka-based pipeline processing 2M events/day"] } ] }
```

Response:

```json
{ "results": [ { "bullet_id": "role_2.b_3", "verdict": "embellished", "issues": ["ownership_upgrade:led"] } ] }
```

Limited to 30 pairs per request; counts as 1 analysis per 10 pairs.

### 6.12 Resumes (metadata)

| Method / path | Purpose | Body / response |
|---|---|---|
| `POST /v1/resumes` | Register a local resume (for history linkage) | `{resume_id, label}` → `201 {resume_id}` |
| `GET /v1/resumes` | List metadata | `{data:[{resume_id, label, is_default, versions:[{version_id, version_no, kind, created_at}]}]}` |
| `GET /v1/resumes/{id}` | One resume's metadata | – |
| `POST /v1/resumes/{id}/versions` | Register a version hash | `{version_id, version_no, kind, content_sha256, parent_version_id, parse_quality}` |
| `DELETE /v1/resumes/{id}` | Delete metadata (and sync blobs) | `204` |

### 6.13 Sync (opt-in; ciphertext only)

| Method / path | Purpose |
|---|---|
| `PUT /v1/sync/blobs/{kind}` | Upload a client-encrypted bundle (`application/octet-stream`, ≤ 5 MB) with `X-Key-Id` and `X-Ciphertext-Sha256` headers |
| `GET /v1/sync/blobs/{kind}` | Download it |
| `DELETE /v1/sync/blobs/{kind}` | Remove it |

### 6.14 Feedback

`POST /v1/feedback`:

```json
{ "optimization_id": "01J…", "target": "bullet", "target_ref": "role_2.b_3", "rating": -1, "reason_code": "not_true", "comment": "I didn't lead this", "content_shared": false }
```

→ `201`

### 6.15 Account (rights)

| Method / path | Purpose |
|---|---|
| `GET /v1/account/export` | JSON archive of server-side data (account, subscription, usage, jobs metadata, optimizations metadata, feedback) |
| `DELETE /v1/account` | Starts the deletion workflow ([database-design.md](database-design.md) §7) → `202 {deletion_request_id}` |
| `GET /v1/account/sessions` | Device sessions list |
| `DELETE /v1/account/sessions/{id}` | Revoke one session |
| `PATCH /v1/account/settings` | `{history_opt_in, telemetry_opt_in, consent_version}` |

### 6.16 Billing

| Method / path | Purpose |
|---|---|
| `GET /v1/billing/plans` | Visible plans with current prices and features (from config + `plan_prices`) |
| `POST /v1/billing/coupons/preview` | `{code, plan_id}` → the discounted price and plain-language terms, or `coupon_rejected`. Read-only; reserves nothing. |
| `POST /v1/billing/checkout` | `{plan_id, coupon_code?}` → `{checkout_url, coupon_redemption_id?}`. With a code, the server re-validates, **reserves** a use for 60 min, and creates a Paddle transaction with the plan's non-checkout `discount_id` ([admin-panel.md](admin-panel.md) §7.4). The checkout page opens Paddle.js with `transactionId` and `showAddDiscounts: false`. |
| `GET /v1/billing/portal` | → `{url}` (Paddle customer portal) |

`POST /v1/billing/coupons/preview`:

```json
{ "code": "LAUNCH30", "plan_id": "pro_quarterly" }
```

→ `200`

```json
{ "valid": true, "plan_id": "pro_quarterly", "percent_off": 30, "duration": "repeating", "duration_periods": 2,
  "price": { "currency": "USD", "list": "45.00", "discounted": "31.50" },
  "summary": "30% off your first 2 quarters, then $45.00 every 3 months. Tax is calculated at checkout." }
```

→ `422` (code valid for other plans only)

```json
{ "error": { "code": "coupon_rejected", "message": "This code doesn't apply to the Pro monthly plan.",
  "details": { "reason": "not_for_plan", "eligible_plans": ["pro_quarterly"] }, "request_id": "01J…", "retryable": false } }
```

---

## 7. Webhooks

`POST /v1/webhooks/paddle`:

- **Verify** the Paddle signature header with the webhook secret and reject if the timestamp is older than 5 min.
- **Idempotent** via `subscription_events.paddle_event_id`.
- Handled events: `subscription.created`, `.updated`, `.canceled`, `.past_due`; `transaction.completed` (credit packs); `adjustment.created` (refunds and chargebacks → revoke credits).
- Process asynchronously: acknowledge `200` fast, then update `subscriptions` and the UserQuota DO plan.
- **Coupons:** `transaction.completed` carrying `custom_data.redemption_id` moves the redemption from `reserved` to `completed` and records list and discount amounts. `adjustment.created` (refund) moves it to `refunded`. Every change writes an `audit_log` row (`actor_type = 'webhook'`).
- **Nightly reconcile:** compare each Paddle discount's `times_used` with our completed redemptions and alert on a mismatch ([admin-panel.md](admin-panel.md) §9).
- [ASSUMPTION] Exact Paddle event names follow Paddle Billing's current API. Verify against the Paddle docs at implementation time.

---

## 8. Extension internal message contracts

All messages have the form `{type, v: 1, requestId, payload}` and are Zod-validated. Receivers check `sender.id === chrome.runtime.id`.

| Type | From → To | Payload | Response |
|---|---|---|---|
| `extract.request` | Side panel → SW | `{tabId, frameIds?: number[]}` | `{ok, job?: ExtractedJob, error?: 'no_permission'|'restricted_page'|'timeout'|'not_found'}` |
| `extract.fromSelection` | SW (context menu) → side panel | `{text, pageUrl, pageTitle}` (≤ 20k chars) | – |
| `panel.open` | SW → (sidePanel API) | `{tabId}` | – |
| `offscreen.parse` | SW → offscreen | `{docId}` (file read from IndexedDB) | `{ok, versionId?, parseQuality?, error?}` |
| `offscreen.generate` | SW → offscreen | `{optimizationId, format: 'docx'|'pdf', template}` | `{ok, exportId?}` |
| `auth.changed` | Side panel ↔ options | `{signedIn: boolean, plan?}` | – |
| `config.updated` | SW → pages | `{version}` | – |

**Rules:**

- The injected `extractJob` function returns only via the `executeScript` result. It never calls the extension APIs that carry resume data.
- Page-derived strings are capped at 200 KB and treated as untrusted text.
- No message ever carries a BYOK key or tokens to a content script or injected function.

---

## 9. BYOK direct-call contract

In privacy or BYOK mode, `packages/ai` runs in the side panel with a `DirectTransport`:

| Provider | Endpoint | Auth header | Notes |
|---|---|---|---|
| OpenAI | `POST https://api.openai.com/v1/responses` | `Authorization: Bearer <user key>` | `store: false`; strict `json_schema`; the optional host permission `https://api.openai.com/*` is requested when BYOK is enabled |
| Anthropic | `POST https://api.anthropic.com/v1/messages` | `x-api-key`, `anthropic-version`, **`anthropic-dangerous-direct-browser-access: true`** | [FACT-SECONDARY] The header is required for browser CORS (https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/). With a host permission, extension-page fetches aren't CORS-bound [ASSUMPTION], but send it anyway. |
| Google | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key` | Paid tier only (show a warning that the free tier forbids personal data, per the [FACT] Gemini terms) |

The same prompts, schemas and validation gates apply. Prompts ship in the extension bundle for BYOK, so updates need a CWS release. Usage and cost are shown locally from the response `usage` fields.

---

## 10. Internal AI interfaces

The full definitions are in [ai-model-comparison.md](ai-model-comparison.md) §11.3: `AIRequest`, `AIResult`, `AIProvider` and `AIRouter`.

The service facade matching the brief's `AIProvider` idea:

```typescript
interface ResumeAIService {
  analyzeJob(input: { jdText: string; hint?: JobHint }): Promise<JobAnalysis>;                        // jd_extract@v1
  analyzeResume(input: { lines: SpanLine[] }): Promise<CanonicalResumePartial>;                         // resume_extract@v1
  matchResume(input: { requirements: Requirement[]; evidence: ClaimLite[] }): Promise<Mapping[]>;       // match_map@v1
  optimizeResume(input: OptimizeInput, onProgress?: (p: Progress) => void): Promise<OptimizeResult>;     // optimize@v1 + gates + validate_entail@v1 + repair@v1
  validateResume(input: { pairs: BulletEvidencePair[] }): Promise<EntailmentResult[]>;                  // validate_entail@v1
}
// Implemented once in packages/ai over AIRouter; used by the API Workflow (HostedTransport) and by the side panel (DirectTransport for BYOK).
```

---

## 11. Admin API

**Base URL:** `https://admin-api.<domain>/admin/v1`. It runs on a **separate Worker** behind Cloudflare Access. The design is in [admin-panel.md](admin-panel.md).

**Conventions (in addition to §2):**

- Every request carries the Cloudflare Access JWT and an admin session. The Worker checks the role's permission for the route ([admin-panel.md](admin-panel.md) §4.2).
- Every **write** requires a `reason` (≥ 10 characters) and an `Idempotency-Key`. The response includes the `audit_id` of the row written in the same DB transaction.
- Every edit of an existing coupon or config version requires `If-Match: <etag>` to prevent lost updates. A mismatch returns `412`.
- **Sensitive reads** (user detail, email reveal, exports) are audited too.
- Step-up actions return `403 {code: "step_up_required"}` when the last re-authentication is older than 10 minutes.

| Area | Method / path | Purpose |
|---|---|---|
| Overview | `GET /overview` | KPI cards (§9 of admin-panel.md) |
| Users | `GET /users?query=` | Search by email, user ID or Paddle customer ID (masked emails) |
| | `GET /users/{id}` · `POST /users/{id}/reveal-email` | Profile (audited `user.view`) · full email (audited) |
| | `GET /users/{id}/timeline?types=&cursor=` | Merged metadata timeline |
| | `POST /users/{id}/credits` `{optimizations, expires_at?, reason}` | Grant credits |
| | `POST /users/{id}/grants` `{plan_id, days ≤ 90, source, reason}` · `DELETE /users/{id}/grants/{gid}` | Complimentary access |
| | `POST /users/{id}/quota/reset` `{kind, reason}` | Reset counters in the UserQuota DO |
| | `POST /users/{id}/suspend` · `/unsuspend` · `/sessions/revoke` · `/deletion` | Account actions |
| Coupons | `GET /coupons?status=&campaign=` · `POST /coupons` · `GET /coupons/{id}` · `PATCH /coupons/{id}` | CRUD. After the first redemption, PATCH accepts only name, dates, limits and status. |
| | `POST /coupons/{id}:pause` · `:resume` · `:archive` | Lifecycle (also archives the Paddle discounts) |
| | `POST /coupons/{id}/codes:bulk` `{count ≤ 5000, prefix}` · `GET /coupons/{id}/codes:export` | Bulk single-use codes; CSV shown once (audited) |
| | `GET /coupons/{id}/redemptions` · `GET /coupons/{id}/stats` | Redemptions; revenue, discount given, conversion, full-price renewal |
| Plans | `GET /plans` · `POST /plans/{id}/prices` `{currency, unit_amount_minor}` · `POST /plan-prices/{id}:archive` | A new price is created in Paddle; existing subscribers keep theirs |
| Config | `GET /config/{namespace}` · `GET /config/{namespace}/versions` | Active version + history |
| | `POST /config/{namespace}/versions` `{data, change_note}` | New draft |
| | `POST /config/versions/{id}:validate` · `:diff` · `:impact` · `:approve` · `:activate {rollout_pct}` · `:promote` · `:rollback` | Lifecycle ([admin-panel.md](admin-panel.md) §6.2); `:activate` enforces the eval gate |
| AI providers and keys | `GET /ai/providers` · `POST /ai/providers` · `PATCH /ai/providers/{id}` (policy flags need `terms_url` + reason; Owner) | Provider registry incl. OpenAI-compatible hosts ([admin-panel.md](admin-panel.md) §6.5) |
| | `GET /ai/vault/public-key` | Current vault public key and version, for **browser-side** encryption |
| | `GET /ai/credentials` · `POST /ai/credentials` `{provider_id, label, env, scope, ciphertext, wrapped_dek, iv, vault_key_version, last4, monthly_soft_budget_usd}` | Add a key (Owner, step-up). **The plaintext key never appears in any request.** |
| | `POST /ai/credentials/{id}:test` · `:activate` · `:standby` · `:revoke` | The test runs in the API Worker over a service binding with a synthetic prompt → `{ok, latency_ms, error_class?, json_mode_ok}` |
| | `GET /ai/models` · `POST /ai/models` · `PATCH /ai/models/{id}` (status, approved tasks need an `eval_run_id`) | Model registry and price book |
| AI analytics | `GET /analytics/ai/summary?from=&to=&compare=previous` | Overview cards and forecast |
| | `GET /analytics/ai/timeseries?metric=tokens\|cost\|calls\|latency_p95&group_by=task\|model\|provider\|credential\|plan\|prompt_version&interval=hour\|day` | Chart series from `ai_usage_hourly` |
| | `GET /analytics/ai/breakdown?dims=task,model&filters=…` | Tables: tokens by type, cost share, error, schema-failure and fallback rates, gate-trip and "not true" rates |
| | `GET /analytics/ai/users?sort=cost\|tokens&limit=50` · `GET /analytics/ai/users/{id}` | Top users (masked) · one user's per-step usage (audited `user.view`) |
| | `GET /analytics/ai/optimizations/{id}/waterfall` | Per-call waterfall for one optimization |
| | `POST /analytics/ai/what-if` `{from, to, tasks[], replace: {model_id}, caps?}` | Re-prices recorded tokens → monthly Δ per step (+ that model's latest eval scores) |
| | `GET /analytics/ai/export.csv?…` | CSV export (audited) |
| Insights | `GET /insights?status=open` · `POST /insights/{id}:accept` (creates a draft config version) · `:dismiss {reason}` | "What to optimize next" ([admin-panel.md](admin-panel.md) §9.5) |
| Traces | `GET /traces/{request_id}` · `GET /optimizations/{id}/trace` | Step-by-step metadata trace |
| Audit | `GET /audit?actor=&target_type=&target_id=&action=&from=&to=` · `GET /audit:export` · `GET /audit:verify?from=&to=` | Search; export (audited); verify the hash chain |
| Privacy | `GET /privacy/requests` · `POST /privacy/requests/{id}:retry-step` | Deletion and export queue |
| System | `GET /system/webhooks/failed` · `POST /system/webhooks/{id}:replay` | Paddle webhook failures |
| Admins | `GET /admins` · `POST /admins` · `PATCH /admins/{user_id}` · `DELETE /admins/{user_id}` | Owner only |

`POST /admin/v1/coupons` (a shared launch code with a different % per plan):

```json
{
  "name": "Launch week — Reddit",
  "campaign": "launch-2026-10",
  "codes": { "mode": "single", "code": "LAUNCH30" },
  "rules": [
    { "plan_id": "pro_monthly",   "percent_off": 20, "duration": "first_period" },
    { "plan_id": "pro_quarterly", "percent_off": 30, "duration": "repeating", "duration_periods": 2 }
  ],
  "max_redemptions": 200,
  "max_per_user": 1,
  "new_customers_only": true,
  "valid_from": "2026-10-15T13:00:00Z",
  "valid_until": "2026-10-23T03:59:00Z",
  "max_discount_total_usd": 500,
  "reason": "Launch promotion from the October marketing plan"
}
```

→ `201`

```json
{ "id": "01JC…", "status": "active",
  "paddle_discount_ids": { "pro_monthly": "dsc_01…", "pro_quarterly": "dsc_01…" },
  "audit_id": 8812 }
```

A **single-use** code is the same request with `"max_redemptions": 1`. A **bulk batch** uses `"codes": {"mode": "bulk", "count": 100, "prefix": "INF-"}`.

`GET /admin/v1/analytics/ai/breakdown?dims=task&from=2026-09-01&to=2026-09-29&env=production` → `200`. The values below are illustrative.

```json
{ "rows": [
  { "task": "optimize", "calls": 61200, "input_tokens": 361000000, "cached_input_tokens": 70000000,
    "output_tokens": 88700000, "reasoning_tokens": 62400000, "cost_usd": 1003.10, "cost_share": 0.71,
    "latency_ms": { "p50": 21000, "p95": 48000 }, "error_rate": 0.004, "schema_fail_rate": 0.001,
    "fallback_rate": 0.02, "repair_rate": 0.18, "tokens_estimated_share": 0 },
  { "task": "jd_extract", "calls": 40100, "cost_usd": 127.40, "cost_share": 0.09, "cache_hit_rate": 0.41 }
  ],
  "totals": { "cost_usd": 1412.00, "shadow_cost_usd": 0, "calls": 214000 },
  "config_versions_in_range": ["ai_routing@v13", "ai_routing@v14"] }
```

**Internal (service binding only, never public):** `POST /internal/credentials/{id}:test` on the API Worker. It decrypts the key and sends one synthetic request. The admin-api can call it, but it can't decrypt keys itself.

---

## 12. Open questions

1. Does `openPanelOnActionClick` grant `activeTab`? This affects whether `extract.request` needs an in-panel button click ([architecture.md](architecture.md) §3.4).
2. Should JD-analysis cache hits count toward the Free analysis quota? (§6.4)
3. Paddle Billing event names and signature scheme: verify at implementation time.
4. Should BYOK users be able to use hosted endpoints with their own key (server-side BYOK)? Not in the MVP; it would require `provider_keys` storage ([database-design.md](database-design.md) §3.4).
